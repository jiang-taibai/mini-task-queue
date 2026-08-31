import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

// CSI 序列 + OSC 序列 + 双字符转义
const ANSI_RE = /\x1B(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g

/**
 * 把原始日志洗成可读文本。
 *
 * tqdm 的进度条靠 `\r` 回车覆盖实现：终端里是一条流畅的进度条，写进文件后
 * 却是几万行几乎相同的内容，外加成堆的颜色控制符。不折叠的话，真正的 loss
 * 日志会被彻底淹没，打开日志页只能看到进度条刷屏。
 *
 * 每个 `\r` 段只保留最后一次覆盖的结果——你打开日志是为了排查问题，
 * 不是为了欣赏进度条动画。副作用是日志体积能小一个数量级。
 */
export function sanitize (text) {
  return text
    .split('\n')
    .map(line => {
      const cleaned = line.replace(ANSI_RE, '').replace(/\r+$/, '')
      if (!cleaned.includes('\r')) return cleaned
      const segments = cleaned.split('\r').filter(s => s.length > 0)
      return segments.length ? segments[segments.length - 1] : ''
    })
    .join('\n')
}

export function logDirFor (logsDir, taskId) {
  return path.join(logsDir, String(taskId))
}

export function logPathFor (logsDir, taskId, attemptNo) {
  return path.join(logDirFor(logsDir, taskId), `attempt-${attemptNo}.log`)
}

export function exitCodePathFor (logsDir, taskId, attemptNo) {
  return path.join(logDirFor(logsDir, taskId), `attempt-${attemptNo}.rc`)
}

export async function ensureLogDir (logsDir, taskId) {
  await fsp.mkdir(logDirFor(logsDir, taskId), { recursive: true })
}

export async function statLog (filePath) {
  try {
    const st = await fsp.stat(filePath)
    return { exists: true, size: st.size, mtime: st.mtimeMs }
  } catch {
    return { exists: false, size: 0, mtime: null }
  }
}

/**
 * 读日志片段。默认取末尾 maxBytes——训练日志一夜能到几个 G，
 * 整个塞进浏览器会把标签页搞崩。
 */
export async function readLogSlice (filePath, { offset = null, maxBytes = 200 * 1024 } = {}) {
  const st = await statLog(filePath)
  if (!st.exists) return { content: '', start: 0, end: 0, size: 0, truncated: false }

  const size = st.size
  let start = offset
  if (start === null) start = Math.max(0, size - maxBytes)
  start = Math.max(0, Math.min(start, size))

  const length = Math.min(maxBytes, size - start)
  if (length <= 0) return { content: '', start, end: start, size, truncated: false }

  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, start)
    return {
      content: sanitize(buf.toString('utf8')),
      start,
      end: start + length,
      size,
      truncated: start > 0
    }
  } finally {
    await fh.close()
  }
}

/**
 * 增量跟随日志文件。
 *
 * 用轮询 stat 而不是 fs.watch：watch 在网络文件系统和部分容器挂载上不触发，
 * 而这个功能一旦静默失效，用户会以为任务卡住了。
 */
async function readRawBytes (filePath, offset, maxBytes) {
  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, offset)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * 增量跟随日志文件。
 *
 * 用轮询 stat 而不是 fs.watch：watch 在网络文件系统和部分容器挂载上不触发，
 * 而这个功能一旦静默失效，用户会以为任务卡住了。
 *
 * 关键在于区分「完整行」和「未完成行」。进度条整段都没有换行，若把每个增量
 * 片段各自清洗后直接追加，`\r` 的覆盖语义就跨不过片段边界，结果是
 * "Epoch 1: 70%Epoch 1: 71%..." 越拼越长。所以未完成的那一行单独送出，
 * 由前端替换而非追加——这才是终端里原地刷新的效果。
 */
export function followLog (filePath, { fromOffset = 0, intervalMs = 500, onData, onError }) {
  let offset = fromOffset
  let carry = ''      // 上一轮尚未遇到换行的残行
  let stopped = false
  let timer = null

  // 中文日志里一个字符占 3 字节，很容易被分块边界劈开。
  // StringDecoder 会把不完整的字节序列留到下一块，避免乱码。
  let decoder = new StringDecoder('utf8')

  const poll = async () => {
    if (stopped) return
    try {
      const st = await statLog(filePath)
      if (st.exists) {
        // 文件变小 = 被截断或重建，从头开始读
        if (st.size < offset) {
          offset = 0
          carry = ''
          decoder = new StringDecoder('utf8')
        }

        if (st.size > offset) {
          const maxBytes = Math.min(512 * 1024, st.size - offset)
          const bytes = await readRawBytes(filePath, offset, maxBytes)
          // 按实际字节数推进，不能用解码后的字符串长度
          offset += bytes.length

          const combined = carry + decoder.write(bytes)
          const lastBreak = combined.lastIndexOf('\n')

          const completed = lastBreak >= 0 ? combined.slice(0, lastBreak + 1) : ''
          carry = lastBreak >= 0 ? combined.slice(lastBreak + 1) : combined

          onData({
            content: completed ? sanitize(completed) : '',
            partial: carry ? sanitize(carry) : '',
            offset,
            size: st.size
          })
        }
      }
    } catch (err) {
      onError?.(err)
    }
    if (!stopped) timer = setTimeout(poll, intervalMs)
  }

  poll()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/** 读日志末尾若干字节，用于 OOM 判定 */
export function readTailSync (filePath, bytes = 8192) {
  try {
    const st = fs.statSync(filePath)
    const start = Math.max(0, st.size - bytes)
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(Math.min(bytes, st.size))
      fs.readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

export async function removeTaskLogs (logsDir, taskId) {
  await fsp.rm(logDirFor(logsDir, taskId), { recursive: true, force: true })
}

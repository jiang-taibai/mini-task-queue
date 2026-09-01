import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { ensureLogDir, logPathFor, exitCodePathFor } from './logs.js'

/**
 * 读 /proc/<pid>/stat 的指定字段（1-based，与 proc(5) 手册一致）。
 *
 * comm 字段（进程名）可能含空格和括号，所以必须从最后一个 ')' 之后开始切分，
 * 不能直接按空格 split——否则遇到 `python (worker)` 这类进程名就会错位。
 */
function readProcStatField (pid, field) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = raw.lastIndexOf(')')
    if (close < 0) return null
    // ')' 之后的第一个字段是 state（第 3 项），故偏移为 field - 3
    const rest = raw.slice(close + 2).trim().split(/\s+/)
    return rest[field - 3] ?? null
  } catch {
    return null
  }
}

export function getProcStarttime (pid) {
  return readProcStatField(pid, 22)
}

export function getPgid (pid) {
  const v = readProcStatField(pid, 5)
  return v === null ? null : Number(v)
}

/**
 * 进程是否还是「我们当初启动的那一个」。
 *
 * 只查 /proc/<pid> 存在性是不够的：PID 会复用，服务重启后那个号码很可能已经
 * 属于别人的进程。把启动时刻一并比对才能排除误认——否则你会对着同事的进程
 * 显示"运行中"，甚至在点停止时杀掉它。
 */
export function isSameProcess (pid, expectedStarttime) {
  if (!pid) return false
  const actual = getProcStarttime(pid)
  if (actual === null) return false
  if (!expectedStarttime) return true
  return actual === expectedStarttime
}

export class Runner {
  constructor (cfg) {
    this.cfg = cfg
    this.children = new Map() // taskId -> ChildProcess（仅本进程启动的任务有）
  }

  /**
   * 进程相关的查询都从这里走，不让调度器直接依赖 /proc。
   *
   * 一是职责本来就该归 Runner，二是 /proc 只有 Linux 才有——在 macOS 上写代码时
   * 调度器的逻辑至少还能被单独测到，否则任何验证都得等部署到那台卡机上。
   */
  pgidOf (pid) {
    return getPgid(pid)
  }

  isAlive (task) {
    return isSameProcess(task.pid, task.procStarttime)
  }

  /**
   * 启动任务。
   *
   * 三个关键点，各自对应一个会咬人的坑：
   *
   * 1. detached: true —— 子进程进入独立进程组。SSH 断开、Node 崩溃、你手动
   *    重启服务，正在跑的训练都不受影响。否则 SIGHUP 会顺着进程组把跑了
   *    一夜的实验一起带走。
   *
   * 2. stdio 直接指向文件 fd，不走管道 —— 管道缓冲区（默认 64KB）填满后，
   *    子进程会阻塞在 print() 上永久卡死，症状是"跑着跑着不动了"、GPU 利用率
   *    归零但进程还活着，极难排查。
   *
   * 3. 退出码落盘 —— 服务重启后我们不再是这些进程的父进程，wait() 拿不到
   *    退出码。让 wrapper 把 $? 写进文件，认领时才有权威结果可读。
   */
  async launch (task, gpuIndices, attemptNo) {
    const { logsDir } = this.cfg
    await ensureLogDir(logsDir, task.id)

    const logPath = logPathFor(logsDir, task.id, attemptNo)
    const rcPath = exitCodePathFor(logsDir, task.id, attemptNo)
    await fsp.rm(rcPath, { force: true })

    const fd = fs.openSync(logPath, 'a')

    // 用换行分隔而不是分号：用户命令若以行内注释结尾，分号会被一起吞掉
    const script = [
      task.command,
      '__mtq_rc=$?',
      `echo $__mtq_rc > ${JSON.stringify(rcPath)}`,
      'exit $__mtq_rc'
    ].join('\n')

    const env = {
      ...process.env,
      ...task.env,
      // 放在最后：用户若在 env 里自己写了 CUDA_VISIBLE_DEVICES，必须由调度器覆盖，
      // 否则分流会静默错位——任务跑到非预期的卡上，而账本还以为它在这张卡
      //
      // 顺序即槽位：CUDA_VISIBLE_DEVICES="3,1" 让脚本里的 cuda:0 指向物理 GPU 3、
      // cuda:1 指向物理 GPU 1。调度器保证第 i 张卡满足 gpuMems[i] 的声明，
      // 所以这个顺序不能排序、不能去重，必须原样拼。
      CUDA_VISIBLE_DEVICES: gpuIndices.join(',')
    }

    let child
    try {
      child = spawn('bash', ['-c', script], {
        cwd: task.cwd,
        env,
        detached: true,
        stdio: ['ignore', fd, fd]
      })
    } finally {
      fs.closeSync(fd)
    }

    if (!child.pid) throw new Error('spawn 失败：未获得 PID')

    // detached 下子进程经 setsid() 成为进程组组长，故 pgid === pid
    const pid = child.pid
    const pgid = pid
    const procStarttime = getProcStarttime(pid)

    child.unref()
    child.on('error', err => console.error(`[runner] 任务 #${task.id} 进程错误:`, err.message))
    this.children.set(task.id, child)

    return { pid, pgid, procStarttime, logPath }
  }

  /**
   * 停止任务：对整个进程组发信号（注意 pgid 前的负号）。
   *
   * 只杀父进程是不够的——PyTorch 的 DataLoader 会 fork 出一批 worker，
   * 它们会变成孤儿继续持有显存。结果就是任务显示"已停止"，那张卡却被
   * 一堆看不见的僵尸 worker 永久占着，只能手动 nvidia-smi 逐个清理。
   */
  stopTask (task, { force = false } = {}) {
    const pgid = task.pgid ?? task.pid
    if (!pgid) return false
    if (!isSameProcess(task.pid, task.procStarttime ?? null)) return false

    const signal = force ? 'SIGKILL' : 'SIGTERM'
    try {
      process.kill(-pgid, signal)
    } catch (err) {
      if (err.code === 'ESRCH') return false
      // EPERM：进程组里有别人的进程（PID 复用等），不再尝试
      if (err.code === 'EPERM') {
        console.warn(`[runner] 无权限向进程组 ${pgid} 发信号`)
        return false
      }
      throw err
    }

    if (!force) {
      const graceMs = this.cfg.scheduler.killGraceSeconds * 1000
      setTimeout(() => {
        try {
          if (isSameProcess(task.pid, task.procStarttime ?? null)) process.kill(-pgid, 'SIGKILL')
        } catch { /* 已经退出了 */ }
      }, graceMs).unref()
    }
    return true
  }

  /** 读 wrapper 落盘的退出码；进程刚消失时文件可能还没写完，此时返回 null */
  readExitCode (taskId, attemptNo) {
    try {
      const raw = fs.readFileSync(exitCodePathFor(this.cfg.logsDir, taskId, attemptNo), 'utf8').trim()
      if (!raw) return null
      const code = Number(raw)
      return Number.isNaN(code) ? null : code
    } catch {
      return null
    }
  }

  forget (taskId) {
    this.children.delete(taskId)
  }
}

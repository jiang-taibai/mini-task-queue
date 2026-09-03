import fs from 'node:fs'
import { getProcStarttime, isSameProcess } from './runner.js'

/**
 * 单实例锁。
 *
 * 这套东西存在的理由是一次真实事故：同一份 checkout 上跑起了 5 个 server，
 * 全都打开同一个 queue.db、全都在跑调度循环，互相抢着派发同一个队列。
 * 症状极其隐蔽——端口只有一个能绑上，但 scheduler 早在 listen 之前就启动了，
 * 绑不上的那几个照样调度，于是多开在运行时没有任何迹象，只有 attempts 表的
 * 唯一索引偶尔报一句 UNIQUE constraint failed。
 *
 * 判活用 pid + /proc 启动时刻，复用认领任务进程那套 isSameProcess：
 * 纯 pid 文件在这台机器上不够用，kill -9 之后文件会留下，而那个号码很可能
 * 已经属于别人的进程——那样服务就被自己的残留文件永久挡在门外了。
 */

/** 锁文件里记的持有者；没人持有（或持有者已经不在了）返回 null */
export function readHolder (lockPath) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    // 文件不存在、写了一半、内容不是 JSON——都当没人持有。
    // 宁可放行也不能因为一个坏文件让服务再也起不来
    return null
  }
  if (!raw?.pid) return null
  return holderAlive(raw) ? raw : null
}

function holderAlive ({ pid, starttime }) {
  if (starttime) return isSameProcess(pid, starttime)

  // 写锁时拿不到 /proc（非 Linux）。退化成「这个号码还在吗」：
  // 认不出 PID 复用，但比把锁当成陈旧的、直接放第二个实例进来强得多
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM' // 是别人的进程，反正不该动它
  }
}

/**
 * 抢锁。拿到返回 { ok: true, release }，没拿到返回 { ok: false, holder }。
 *
 * 用 O_EXCL 创建而不是「先查再写」：两个实例同时启动时，查和写之间的空档
 * 足够让两个都认为自己是第一个。
 */
export function acquireLock (lockPath) {
  // 两轮：第一轮撞上陈旧锁就删掉重来，第二轮再撞就说明有人正在抢，让给它
  for (let attempt = 0; attempt < 2; attempt++) {
    const self = {
      pid: process.pid,
      starttime: getProcStarttime(process.pid),
      startedAt: Date.now()
    }

    let fd
    try {
      fd = fs.openSync(lockPath, 'wx')
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      const holder = readHolder(lockPath)
      if (holder) return { ok: false, holder }

      // 陈旧锁：持有者已经不在了，多半是被 kill -9
      try {
        fs.unlinkSync(lockPath)
      } catch { /* 别人抢先删了，下一轮自然会发现 */ }
      continue
    }

    try {
      fs.writeSync(fd, JSON.stringify(self))
    } finally {
      fs.closeSync(fd)
    }
    return { ok: true, release: () => releaseLock(lockPath, self.pid) }
  }

  return { ok: false, holder: readHolder(lockPath) }
}

/**
 * 释放锁。只删自己写的那个。
 *
 * 接管场景下顺序是「旧实例退出 -> 新实例抢锁」，如果旧实例的退出钩子跑得晚
 * 一点、又不加判断地 unlink，删掉的就是新实例刚写好的锁。
 */
export function releaseLock (lockPath, pid) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    if (raw?.pid !== pid) return false
    fs.unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 请求持有者退出，等它把锁放掉。
 *
 * 只发 SIGTERM，超时就放弃并交回人工。绝不升级到 SIGKILL：那会跳过 shutdown()，
 * 而且「一个进程强行踢掉另一个」这种事，在判断依据只是一个锁文件的时候，
 * 错一次的代价是把正在服务的实例打断。
 *
 * 正在跑的任务不受影响——它们是 detached 的独立进程组，新实例起来后 reclaim()
 * 会重新认领。
 */
export async function takeover (lockPath, holder, { timeoutMs = 20000, pollMs = 200 } = {}) {
  try {
    process.kill(holder.pid, 'SIGTERM')
  } catch (err) {
    // ESRCH：就在我们读完锁文件之后它自己退了，正合我意
    if (err.code !== 'ESRCH') return { ok: false, reason: err.message }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!readHolder(lockPath)) return { ok: true }
    await sleep(pollMs)
  }
  return { ok: false, reason: `等待 ${timeoutMs / 1000}s 后 pid ${holder.pid} 仍未退出` }
}

/** 给人看的持有者描述 */
export function describeHolder (holder) {
  if (!holder) return '未知进程'
  const since = holder.startedAt ? `，启动于 ${new Date(holder.startedAt).toLocaleString()}` : ''
  return `pid ${holder.pid}${since}`
}

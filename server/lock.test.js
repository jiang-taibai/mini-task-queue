import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { acquireLock, readHolder, releaseLock, takeover } from './lock.js'
import { getProcStarttime } from './runner.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtq-lock-'))

let seq = 0
/** 每个用例一个独立的锁路径，用例之间互不影响 */
const freshPath = () => path.join(TMP, `case-${++seq}.lock`)

/** 一个必定不存在的 pid：远超 pid_max，process.kill 只会给 ESRCH */
const DEAD_PID = 0x7ffffff

test('首次启动能拿到锁，锁文件记下自己的 pid', () => {
  const lockPath = freshPath()

  const lock = acquireLock(lockPath)

  assert.equal(lock.ok, true)
  assert.equal(readHolder(lockPath).pid, process.pid)
})

test('已经有实例活着时拿不到锁，并报出是谁占着', () => {
  const lockPath = freshPath()
  const first = acquireLock(lockPath)
  assert.equal(first.ok, true)

  const second = acquireLock(lockPath)

  assert.equal(second.ok, false)
  assert.equal(
    second.holder.pid, process.pid,
    '拿不到锁时必须说清是谁占着——否则用户只能靠 ps 猜，而多开在运行时没有任何症状'
  )
})

test('kill -9 留下的陈旧锁不会把服务永久挡在门外', () => {
  const lockPath = freshPath()
  fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, starttime: null, startedAt: 0 }))

  const lock = acquireLock(lockPath)

  assert.equal(lock.ok, true, '持有者早就不在了，锁必须能被回收')
  assert.equal(readHolder(lockPath).pid, process.pid)
})

test('陈旧锁的 pid 已被别人复用时，不当成自己人', () => {
  const lockPath = freshPath()
  // pid 活着（就是本进程），但启动时刻对不上——正是 PID 被复用的样子
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    starttime: '999999999',
    startedAt: 0
  }))

  assert.equal(
    readHolder(lockPath), null,
    '只比对 pid 会把别人的进程认成上一任服务，然后既不敢启动也不敢接管'
  )
  assert.equal(acquireLock(lockPath).ok, true)
})

test('锁文件损坏时放行，不让一个坏文件把服务锁死', () => {
  const lockPath = freshPath()
  fs.writeFileSync(lockPath, '{"pid": 12') // 写到一半断电的样子

  assert.equal(readHolder(lockPath), null)
  assert.equal(acquireLock(lockPath).ok, true)
})

test('release 只删自己的锁，不会踢掉接管者', () => {
  const lockPath = freshPath()
  const lock = acquireLock(lockPath)
  assert.equal(lock.ok, true)

  // 接管场景：新实例已经把锁换成了自己的，此时旧实例的退出钩子才跑
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: DEAD_PID, starttime: null, startedAt: Date.now()
  }))
  lock.release()

  assert.equal(
    readHolder(lockPath)?.pid ?? null, null,
    '锁文件应当原样留给接管者'
  )
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, DEAD_PID)
})

test('释放之后可以重新获取', () => {
  const lockPath = freshPath()
  const lock = acquireLock(lockPath)
  assert.equal(lock.release(), true)

  assert.equal(fs.existsSync(lockPath), false)
  assert.equal(acquireLock(lockPath).ok, true)
})

test('接管：持有者已经不在时直接放行', async () => {
  const lockPath = freshPath()
  fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, starttime: null, startedAt: 0 }))

  const result = await takeover(lockPath, { pid: DEAD_PID }, { timeoutMs: 1000, pollMs: 50 })

  assert.equal(result.ok, true)
})

test('接管：持有者赖着不走就超时报错，绝不升级到 SIGKILL', async () => {
  const lockPath = freshPath()
  const lock = acquireLock(lockPath)
  assert.equal(lock.ok, true)

  // 本进程忽略 SIGTERM，扮演一个不肯退出的持有者
  const ignore = () => {}
  process.on('SIGTERM', ignore)
  try {
    const result = await takeover(lockPath, { pid: process.pid }, { timeoutMs: 400, pollMs: 50 })

    assert.equal(result.ok, false)
    assert.match(result.reason, /仍未退出/)
    assert.equal(
      readHolder(lockPath).pid, process.pid,
      '超时后必须原样交回人工：靠一个锁文件就强杀，判断错一次就是打断正在服务的实例'
    )
  } finally {
    process.off('SIGTERM', ignore)
  }
})

test('非 Linux 上拿不到 starttime 时，仍然认得出活着的持有者', () => {
  const lockPath = freshPath()
  // starttime 为 null 是 getProcStarttime 在非 Linux 上的返回值
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, starttime: null, startedAt: 0 }))

  assert.equal(
    readHolder(lockPath)?.pid, process.pid,
    '退化成判 pid 存活即可；把它当陈旧锁会让 macOS 上第二个实例直接放进来'
  )
})

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }))

// 兜底：真机上必须能取到启动时刻，否则判活会退化成裸 pid 比对
test('Linux 上取得到 /proc 启动时刻', { skip: process.platform !== 'linux' }, () => {
  assert.notEqual(getProcStarttime(process.pid), null)
})

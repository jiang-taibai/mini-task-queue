import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyProcesses, TRACKED, ORPHAN, FOREIGN, UNMATCHED } from './orphans.js'

/**
 * 孤儿判定的分类逻辑。
 *
 * 归属靠 pgid：nvidia-smi 报的是真正跑 CUDA 的 python 进程，而我们启动的是
 * bash wrapper，两者 PID 不同，detached 让整棵树共享 pgid。这里把 pgidOf
 * 换成查表，于是不需要真实 GPU 和 /proc 也能测。
 */

// pid -> pgid：模拟「python 进程属于某个 wrapper 的进程组」
const PGID = { 101: 900, 102: 901, 103: 902, 104: 903, 105: null }
const pgidOf = pid => (pid in PGID ? PGID[pid] : null)

const proc = (pid, over = {}) => ({ gpuIndex: 0, pid, usedMemoryMb: 8192, user: 'lhh', ...over })

function run (over = {}) {
  return classifyProcesses({
    gpuProcs: [],
    running: [],
    attempts: [],
    pgidOf,
    selfUser: 'lhh',
    ...over
  })
}

test('账本里正在运行的任务 -> 正常，不报', () => {
  const [r] = run({
    gpuProcs: [proc(101)],
    running: [{ id: 7, name: 'train', pgid: 900 }]
  })

  assert.equal(r.kind, TRACKED)
  assert.equal(r.task.id, 7)
})

test('pgid 出现在已结束任务的 attempts 里 -> 确认的孤儿', () => {
  const [r] = run({
    gpuProcs: [proc(102)],
    attempts: [{
      taskId: 12, taskName: 'llama3', attemptNo: 2, pgid: 901,
      taskStatus: 'failed', finishedAt: 1_700_000_000_000
    }]
  })

  assert.equal(
    r.kind, ORPHAN,
    'attempts 表白纸黑字记着这个 pgid 是我们派出去的，而任务已经结束——这是最强的证据'
  )
  assert.equal(r.attempt.taskId, 12)
  assert.equal(r.attempt.attemptNo, 2)
})

test('别的用户的进程 -> 不碰，哪怕 pgid 恰好撞上', () => {
  const [r] = run({
    gpuProcs: [proc(101, { user: 'colleague' })],
    running: [{ id: 7, name: 'train', pgid: 900 }]
  })

  assert.equal(
    r.kind, FOREIGN,
    '那台机器上还有同事在用，属主判定必须优先于一切匹配'
  )
})

test('账本和历史都对不上 -> 无法归属，交给人看', () => {
  const [r] = run({ gpuProcs: [proc(103)] })

  assert.equal(r.kind, UNMATCHED)
})

test('拿不到 pgid 时不瞎猜，归入无法归属', () => {
  const [r] = run({
    gpuProcs: [proc(105)],
    running: [{ id: 7, name: 'train', pgid: 900 }]
  })

  assert.equal(r.kind, UNMATCHED, 'pgid 读不到就没有判据，绝不能默认当成孤儿')
})

test('同一 pgid 有多次尝试时，报告最近的那次', () => {
  const [r] = run({
    gpuProcs: [proc(102)],
    attempts: [
      { taskId: 12, taskName: 'llama3', attemptNo: 1, pgid: 901, taskStatus: 'failed', finishedAt: 1 },
      { taskId: 12, taskName: 'llama3', attemptNo: 3, pgid: 901, taskStatus: 'failed', finishedAt: 3 },
      { taskId: 12, taskName: 'llama3', attemptNo: 2, pgid: 901, taskStatus: 'failed', finishedAt: 2 }
    ]
  })

  assert.equal(r.attempt.attemptNo, 3)
})

test('正在运行的任务优先于历史尝试——重试过的任务不该被当成孤儿', () => {
  const [r] = run({
    gpuProcs: [proc(101)],
    running: [{ id: 7, name: 'train', pgid: 900 }],
    // 同一个 pgid 也出现在历史里（比如库里留着上一轮的记录）
    attempts: [{ taskId: 7, taskName: 'train', attemptNo: 1, pgid: 900, taskStatus: 'failed', finishedAt: 1 }]
  })

  assert.equal(r.kind, TRACKED, '误报一个正在跑的任务是孤儿，会诱导人去杀掉它')
})

test('多卡任务的多个进程共享 pgid，各自都能对上', () => {
  const rows = classifyProcesses({
    gpuProcs: [proc(101, { gpuIndex: 0 }), proc(101, { gpuIndex: 1 })],
    running: [{ id: 7, name: 'train', pgid: 900 }],
    attempts: [],
    pgidOf,
    selfUser: 'lhh'
  })

  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.kind === TRACKED))
})

test('判不出属主时按自己人处理，走后续匹配而不是直接放过', () => {
  const [r] = run({
    gpuProcs: [proc(102, { user: null })],
    attempts: [{
      taskId: 12, taskName: 'llama3', attemptNo: 1, pgid: 901,
      taskStatus: 'cancelled', finishedAt: 1
    }]
  })

  assert.equal(r.kind, ORPHAN, '属主读不到就放过的话，孤儿会因为权限问题被漏掉')
})

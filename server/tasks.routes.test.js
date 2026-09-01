import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'

/**
 * 提交校验的测试，重点是「结构性不可能」的四类拦截。
 *
 * 多卡放大了一类新错误：把总需求填进每卡的框。这类任务提交成功、进队列、
 * 然后永远挂在那里，用户以为在排队，其实在等一件不可能发生的事。
 */

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'mtq-cwd-'))
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtq-routes-'))
process.env.GPU_SOURCE = 'mock'

const { loadConfig } = await import('./config.js')
const { getDb } = await import('./db.js')
const { createTasksRouter } = await import('./routes/tasks.js')

const cfg = loadConfig()
const db = getDb()

// 卡数与容量由用例控制：为空即模拟「GPU 监控挂了」
let devices = [
  { index: 0, memTotalMb: 24564 },
  { index: 1, memTotalMb: 24564 }
]

const gpu = { getDevices: () => devices }
const scheduler = { emitChange () {}, tick () {}, getBlockingInfo: () => null }

const app = express()
app.use(express.json())
app.use('/api/tasks', createTasksRouter({ db, scheduler, gpu, cfg }))

const server = app.listen(0)
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`

test.after(() => server.close())

let seq = 0
async function post (body) {
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `t${++seq}`,
      cwd: CWD,
      command: 'python train.py',
      ...body
    })
  })
  return { status: res.status, body: await res.json() }
}

test('双卡任务提交成功，槽位数组落库，memRequiredMb 是它们的和', async () => {
  const { status, body } = await post({ gpuMems: [10000, 8000] })

  assert.equal(status, 201)
  assert.deepEqual(body.task.gpuMems, [10000, 8000])
  assert.equal(body.task.memRequiredMb, 18000)
})

test('申请的卡数超过本机卡数 -> 拒绝', async () => {
  const { status, body } = await post({ gpuMems: [1000, 1000, 1000] })

  assert.equal(status, 400)
  assert.match(body.error, /需要 3 张卡，但本机只有 2 张/)
})

test('把总需求填进每卡的框 -> 拒绝，并点明填的是单卡需求', async () => {
  const { status, body } = await post({ gpuMems: [40000, 40000] })

  assert.equal(status, 400)
  assert.match(body.error, /超过可分配范围内单卡的显存上限/)
  assert.match(body.error, /不是总量/)
})

test('「限定 GPU」比申请卡数还少 -> 拒绝', async () => {
  const { status, body } = await post({ gpuMems: [1000, 1000], allowedGpus: [0] })

  assert.equal(status, 400)
  assert.match(body.error, /只允许了 1 张/)
})

test('限定范围内凑不出满足各槽位的一组卡 -> 拒绝', async () => {
  devices = [
    { index: 0, memTotalMb: 24564 },
    { index: 1, memTotalMb: 8192 }
  ]
  try {
    const { status, body } = await post({ gpuMems: [20000, 20000] })
    assert.equal(status, 400)
    assert.match(body.error, /超过可分配范围内单卡的显存上限/)
  } finally {
    devices = [{ index: 0, memTotalMb: 24564 }, { index: 1, memTotalMb: 24564 }]
  }
})

test('GPU 监控失联时照常接受提交——不把监控故障升级成系统不可用', async () => {
  devices = []
  try {
    const { status } = await post({ gpuMems: [999999, 999999, 999999, 999999] })
    assert.equal(status, 201, '拿不到设备列表时应跳过硬件校验并放行')
  } finally {
    devices = [{ index: 0, memTotalMb: 24564 }, { index: 1, memTotalMb: 24564 }]
  }
})

test('多卡但命令看着是单进程单卡 -> 警告不拦', async () => {
  const { status, body } = await post({ gpuMems: [1000, 1000] })

  assert.equal(status, 201)
  assert.ok(
    body.warnings.some(w => w.includes('单进程单卡的写法')),
    `应当提醒确认脚本会用到第二张卡，实际：${JSON.stringify(body.warnings)}`
  )
})

test('用 torchrun / device_map 时不再提醒', async () => {
  const { body } = await post({
    gpuMems: [1000, 1000],
    command: 'torchrun --nproc_per_node 2 train.py'
  })

  assert.ok(!body.warnings.some(w => w.includes('单进程单卡的写法')))
})

test('双卡任务里的 cuda:1 是正当写法，不该告警', async () => {
  const { body } = await post({
    gpuMems: [1000, 1000],
    command: 'torchrun train.py --device cuda:1'
  })

  assert.ok(
    !body.warnings.some(w => w.includes('cuda:1')),
    `双卡任务不该对 cuda:1 告警，实际：${JSON.stringify(body.warnings)}`
  )
})

test('超出本任务可见范围的卡号仍要告警', async () => {
  const { body } = await post({
    gpuMems: [1000, 1000],
    command: 'torchrun train.py --device cuda:2'
  })

  assert.ok(
    body.warnings.some(w => w.includes('cuda:2') && w.includes('超出本任务申请的 2 张卡')),
    `实际：${JSON.stringify(body.warnings)}`
  )
})

test('单卡任务里的 cuda:1 仍然告警，行为不变', async () => {
  const { body } = await post({ gpuMems: [1000], command: 'python train.py --device cuda:1' })

  assert.ok(
    body.warnings.some(w => w.includes('统一使用 cuda:0')),
    `实际：${JSON.stringify(body.warnings)}`
  )
})

test('几乎吃满整机时给出排队提醒', async () => {
  const { status, body } = await post({
    gpuMems: [20000, 20000],
    command: 'torchrun train.py'
  })

  assert.equal(status, 201)
  assert.ok(
    body.warnings.some(w => w.includes('接近整机显存总量')),
    `实际：${JSON.stringify(body.warnings)}`
  )
})

test('显存需求为零或负数 -> 拒绝', async () => {
  const { status, body } = await post({ gpuMems: [1000, 0] })

  assert.equal(status, 400)
  assert.match(body.error, /必须是正数/)
})

test('仍接受旧的 memRequiredMb 单值写法', async () => {
  const { status, body } = await post({ memRequiredMb: 4096 })

  assert.equal(status, 201)
  assert.deepEqual(body.task.gpuMems, [4096])
})

test('重新排队只清空重试预算，尝试编号继续往后走', async () => {
  const { body } = await post({ gpuMems: [1000] })
  const id = body.task.id
  db.prepare(`
    UPDATE tasks SET status = 'failed', attempt_count = 3, retry_count = 3,
                     gpu_index = 1, gpu_indices = '[1]', exit_code = 1,
                     fail_reason = '退出码 1', finished_at = 123
    WHERE id = ?
  `).run(id)

  const res = await fetch(`${base}/api/tasks/${id}/requeue`, { method: 'POST' })
  const task = (await res.json()).task

  assert.equal(res.status, 200)
  assert.equal(task.status, 'pending')
  assert.equal(task.retryCount, 0, '新一轮该有完整的自动重试预算')
  assert.equal(
    task.attemptCount, 3,
    '归零会让新一轮从 attempt-1.log 重新写，把上一轮的日志和记录覆盖掉'
  )
  assert.deepEqual(task.gpuIndices, [], '上一轮的卡号必须清掉，否则界面上它看着还占着卡')
  assert.equal(task.exitCode, null)
  assert.equal(task.failReason, null)
})

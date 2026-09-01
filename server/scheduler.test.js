import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 调度器的多卡行为测试。
 *
 * 不依赖 /proc：进程查询走 Runner 的 pgidOf/isAlive，这里换成假的实现。
 * 于是这些用例在 macOS 上也能跑——多卡下新增的失效模式（预留误删、槽位塌缩）
 * 都不会报错、不会崩，只会在几十分钟后表现为一次莫名其妙的 OOM，
 * 没有这层测试就只能在真机上靠 OOM 反推。
 *
 * 时间不靠 sleep：直接改 MockSource 里 allocation 的 startedAt 来伪造流逝，
 * 保证用例是确定性的。
 */

const MEM_TOTAL = 24564

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtq-test-'))
process.env.GPU_SOURCE = 'mock'

const { loadConfig } = await import('./config.js')
const { getDb } = await import('./db.js')
const { GpuMonitor } = await import('./gpu/index.js')
const { Scheduler } = await import('./scheduler.js')

/** 只实现调度器用得到的部分；不 spawn 任何真进程 */
class FakeRunner {
  constructor () {
    this.launched = []
    this.alive = new Set()
    this.nextPid = 1000
  }

  async launch (task, gpuIndices, attemptNo) {
    const pid = this.nextPid++
    this.alive.add(pid)
    this.launched.push({ taskId: task.id, gpuIndices: [...gpuIndices], attemptNo, pid })
    return { pid, pgid: pid, procStarttime: 'fake', logPath: '/dev/null' }
  }

  // mock 数据源里进程的 pid 就是我们记的 pgid
  pgidOf (pid) { return pid }
  isAlive (task) { return this.alive.has(task.pid) }
  readExitCode () { return null }
  forget () {}
  stopTask () { return true }
}

function setup ({ mem = MEM_TOTAL, allocDelayMs = 1000 } = {}) {
  const cfg = structuredClone(loadConfig())
  cfg.gpu.source = 'mock'
  cfg.gpu.mock = { deviceCount: 2, memTotalMb: mem, allocDelayMs }
  cfg.scheduler.warmupSeconds = 60
  cfg.scheduler.maxPerGpu = 1
  cfg.scheduler.overrunRatio = 1.5

  const db = getDb()
  db.exec('DELETE FROM attempts; DELETE FROM tasks;')

  const gpu = new GpuMonitor(cfg)
  const runner = new FakeRunner()
  const scheduler = new Scheduler(cfg, db, gpu, runner)

  // 手动灌快照，不启定时器——每一拍看到什么完全由用例决定
  const pump = () => {
    gpu.snapshot = gpu.source.snapshot()
    gpu.lastUpdate = Date.now()
  }

  return { cfg, db, gpu, runner, scheduler, pump }
}

let seq = 0
function addTask (db, gpuMems, { allowedGpus = null } = {}) {
  const info = db.prepare(`
    INSERT INTO tasks (name, cwd, command, mem_required_mb, gpu_mems, allowed_gpus,
                       env, depends_on, status, queue_order, created_at)
    VALUES (?, '/tmp', 'sleep 1', ?, ?, ?, '{}', '[]', 'pending', ?, ?)
  `).run(
    `t${++seq}`,
    gpuMems.reduce((a, b) => a + b, 0),
    JSON.stringify(gpuMems),
    allowedGpus ? JSON.stringify(allowedGpus) : null,
    seq * 1000,
    Date.now()
  )
  return Number(info.lastInsertRowid)
}

/** launchTask 的落库在 promise 回调里，让微任务队列先跑完 */
const settle = () => new Promise(resolve => setImmediate(resolve))

/** 伪造「启动至今已过去 ms 毫秒」 */
function advance (gpu, pid, ms) {
  gpu.source.allocations.get(pid).startedAt = Date.now() - ms
}

test('双卡任务按槽位分配，每张卡各记一条预留', async () => {
  const { db, scheduler, runner, pump } = setup()
  const id = addTask(db, [10000, 10000])

  pump()
  scheduler.tick()
  await settle()

  assert.deepEqual(runner.launched[0].gpuIndices, [0, 1])
  assert.equal(scheduler.reservedOn(0), 10000)
  assert.equal(scheduler.reservedOn(1), 10000)
  assert.equal(scheduler.getTask(id).status, 'running')
})

test('顺序加载时，只解除已被观测到的那张卡的预留', async () => {
  const { db, gpu, scheduler, runner, pump } = setup({ allocDelayMs: 1000 })
  addTask(db, [10000, 10000])

  pump()
  scheduler.tick()
  await settle()

  // 槽位 0 在 1s 后出现、槽位 1 在 2s 后——此刻只有卡 0 吃上了显存
  advance(gpu, runner.launched[0].pid, 1500)
  pump()
  scheduler.tick()

  assert.equal(scheduler.reservedOn(0), 0, '卡 0 已被观测到，预留应当解除')
  assert.equal(
    scheduler.reservedOn(1), 10000,
    '卡 1 还没被碰过，预留必须留着——跨卡求和会在这里把它一起删掉，' +
    '然后下一个任务被派上去，等权重压过来两个一起 OOM'
  )
})

test('还看得见进程就给未观测到的卡续期，彻底看不见才硬到期', async () => {
  const { db, gpu, scheduler, runner, pump } = setup()
  const id = addTask(db, [10000, 10000])

  pump()
  scheduler.tick()
  await settle()

  const pid = runner.launched[0].pid
  // 把卡 1 的预留推到已过期
  scheduler.reservations.get(id).find(r => r.gpuIndex === 1).expiresAt = Date.now() - 1

  advance(gpu, pid, 1500) // 卡 0 上看得见进程 -> 任务还活着
  pump()
  scheduler.tick()
  assert.equal(scheduler.reservedOn(1), 10000, '任务还在加载，卡 1 应当续期')

  // 进程从 GPU 上消失，且已超过硬到期
  gpu.source.allocations.delete(pid)
  scheduler.lastSeenAlive.set(id, Date.now() - 61_000)
  pump()
  scheduler.tick()
  assert.equal(scheduler.reservedOn(1), 0, '看不见任何进程时必须走硬到期，否则 WSL2 上这张卡会废到任务结束')
})

test('槽位需求不等时，大需求配大卡，CUDA_VISIBLE_DEVICES 按槽位序排', async () => {
  const { db, gpu, scheduler, runner, pump } = setup()
  gpu.source.setExternal(0, 10000) // GPU 0 只剩 14564，GPU 1 满的
  addTask(db, [20000, 2000])

  pump()
  scheduler.tick()
  await settle()

  assert.deepEqual(
    runner.launched[0].gpuIndices, [1, 0],
    '槽位 0 声明 20000，只有 GPU 1 装得下；顺序即 cuda:0 -> GPU 1'
  )
})

test('槽位需求相同时按卡号升序，便于阅读', async () => {
  const { db, scheduler, runner, pump } = setup()
  addTask(db, [10000, 10000])

  pump()
  scheduler.tick()
  await settle()

  assert.deepEqual(runner.launched[0].gpuIndices, [0, 1])
})

test('凑不齐卡数时不派发，且不退化成单卡', async () => {
  const { db, gpu, scheduler, runner, pump } = setup()
  gpu.source.setExternal(1, MEM_TOTAL) // GPU 1 被别人占满
  addTask(db, [10000, 10000])

  pump()
  scheduler.tick()
  await settle()

  assert.equal(runner.launched.length, 0)
})

test('队头多卡任务排不上时，后面的单卡任务一律等待', async () => {
  const { db, gpu, scheduler, runner, pump } = setup()
  gpu.source.setExternal(1, MEM_TOTAL)
  addTask(db, [10000, 10000]) // 队头，排不上
  addTask(db, [1000])          // 后面，本来放得下 GPU 0

  pump()
  scheduler.tick()
  await settle()

  assert.equal(runner.launched.length, 0, '严格门控：手动排的顺序是硬承诺')
})

test('槽位塌缩到同一张卡时，按卡比对能抓到而集合判定抓不到', async () => {
  const { db, gpu, scheduler, runner, pump } = setup()
  gpu.mock.setDrift('collapse')

  const logs = []
  scheduler.on('log', msg => logs.push(msg))
  addTask(db, [10000, 10000])

  pump()
  scheduler.tick()
  await settle()

  advance(gpu, runner.launched[0].pid, 5000) // 两个槽位都已落到 GPU 0
  pump()
  scheduler.tick()

  const hit = logs.find(l => l.includes('显存账本已不可信'))
  assert.ok(hit, `应当告警显存超额，实际日志：${JSON.stringify(logs)}`)
  assert.match(hit, /GPU 0 上声明 10000 MB，实测占用 20000 MB/)
})

test('跑到分配集合之外的卡上时，报分流被绕过', async () => {
  const { db, gpu, scheduler, runner, pump } = setup()
  addTask(db, [10000]) // 单卡任务，会被派到 GPU 0
  gpu.mock.setDrift('shift') // 实际落到 GPU 1

  const logs = []
  scheduler.on('log', msg => logs.push(msg))

  pump()
  scheduler.tick()
  await settle()

  advance(gpu, runner.launched[0].pid, 3000)
  pump()
  scheduler.tick()

  assert.ok(
    logs.some(l => l.includes('分流已被绕过')),
    `应当告警分流漂移，实际日志：${JSON.stringify(logs)}`
  )
})

test('峰值按槽位各自取最大值，peak_mem_mb 是它们的和', async () => {
  const { db, gpu, scheduler, runner, pump } = setup()
  const id = addTask(db, [10000, 8000])

  pump()
  scheduler.tick()
  await settle()

  advance(gpu, runner.launched[0].pid, 5000)
  pump()
  scheduler.tick()

  const task = scheduler.getTask(id)
  assert.deepEqual(task.peakMemPerGpu, [10000, 8000])
  assert.equal(task.peakMemMb, 18000)
})

test('单卡任务行为不变：一张卡、一条预留', async () => {
  const { db, scheduler, runner, pump } = setup()
  const id = addTask(db, [8192])

  pump()
  scheduler.tick()
  await settle()

  assert.deepEqual(runner.launched[0].gpuIndices, [0])
  assert.equal(scheduler.reservedOn(0), 8192)
  assert.equal(scheduler.reservedOn(1), 0)
  assert.deepEqual(scheduler.getTask(id).gpuIndices, [0])
})

test('gpu_mems 为空的历史行回退成单卡，不会炸', async () => {
  const { db, scheduler } = setup()
  const info = db.prepare(`
    INSERT INTO tasks (name, cwd, command, mem_required_mb, gpu_mems,
                       env, depends_on, status, queue_order, created_at)
    VALUES ('legacy', '/tmp', 'sleep 1', 4096, NULL, '{}', '[]', 'pending', 1, 0)
  `).run()

  const task = scheduler.getTask(Number(info.lastInsertRowid))
  assert.deepEqual(task.gpuMems, [4096])
  assert.deepEqual(task.gpuIndices, [])
  assert.equal(task.peakMemPerGpu, null)
})

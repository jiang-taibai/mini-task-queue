import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * 拿一个「多卡改动之前」的库来跑迁移。
 *
 * 服务就跑在那台带着实验的机器上，升级是原地重启——迁移把老库改坏的代价是
 * 半夜手工修数据库。这里先按旧 schema 建库、灌数据，再让 db.js 接手。
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtq-migrate-'))
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true })

// 旧 schema：没有 gpu_mems / gpu_indices / peak_mem_per_gpu
const legacy = new DatabaseSync(path.join(DATA_DIR, 'queue.db'))
legacy.exec(`
  CREATE TABLE tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    cwd             TEXT    NOT NULL,
    command         TEXT    NOT NULL,
    mem_required_mb INTEGER NOT NULL,
    allowed_gpus    TEXT,
    env             TEXT    NOT NULL DEFAULT '{}',
    depends_on      TEXT    NOT NULL DEFAULT '[]',
    timeout_seconds INTEGER,
    status          TEXT    NOT NULL,
    queue_order     REAL    NOT NULL,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    gpu_index       INTEGER,
    pid             INTEGER,
    pgid            INTEGER,
    proc_starttime  TEXT,
    stop_requested  INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    started_at      INTEGER,
    finished_at     INTEGER,
    exit_code       INTEGER,
    fail_reason     TEXT,
    peak_mem_mb     INTEGER
  );
  CREATE TABLE attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_no  INTEGER NOT NULL,
    gpu_index   INTEGER,
    pid         INTEGER,
    pgid        INTEGER,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    exit_code   INTEGER,
    outcome     TEXT,
    peak_mem_mb INTEGER,
    log_path    TEXT NOT NULL
  );
  -- 跑完的老任务：有卡号也有峰值
  INSERT INTO tasks (name, cwd, command, mem_required_mb, status, queue_order,
                     attempt_count, gpu_index, created_at, peak_mem_mb)
  VALUES ('done', '/tmp', 'python a.py', 8192, 'succeeded', 1000, 1, 1, 100, 7800);
  -- 还在排队的老任务：卡号和峰值都是 null
  INSERT INTO tasks (name, cwd, command, mem_required_mb, status, queue_order, created_at)
  VALUES ('queued', '/tmp', 'python b.py', 4096, 'pending', 2000, 200);
  INSERT INTO attempts (task_id, attempt_no, gpu_index, started_at, peak_mem_mb, log_path)
  VALUES (1, 1, 1, 100, 7800, '/tmp/a.log');

  -- 被手动重新排队过的任务：旧代码把 attempt_count 归零，第二轮又从 1 开始编号。
  -- 于是 attempts 里出现同号两行，attempt_count(1) 也低于实际用过的最大编号(3)。
  INSERT INTO tasks (name, cwd, command, mem_required_mb, status, queue_order,
                     attempt_count, created_at)
  VALUES ('requeued', '/tmp', 'python c.py', 8192, 'failed', 3000, 1, 300);
  INSERT INTO attempts (task_id, attempt_no, started_at, outcome, log_path) VALUES
    (3, 1, 300, 'round1', '/tmp/c.log'),
    (3, 2, 301, 'round1', '/tmp/c.log'),
    (3, 3, 302, 'round1', '/tmp/c.log'),
    (3, 1, 400, 'round2', '/tmp/c.log');

  -- 同样撞过号，但此刻正在跑：attempt_count 是它当前那次尝试的活链接
  INSERT INTO tasks (name, cwd, command, mem_required_mb, status, queue_order,
                     attempt_count, pid, created_at)
  VALUES ('running', '/tmp', 'python d.py', 8192, 'running', 4000, 1, 999, 400);
  INSERT INTO attempts (task_id, attempt_no, started_at, outcome, log_path) VALUES
    (4, 1, 400, 'round1', '/tmp/d.log'),
    (4, 2, 401, 'round1', '/tmp/d.log'),
    (4, 1, 500, 'round2', '/tmp/d.log');
`)
legacy.close()

process.env.DATA_DIR = DATA_DIR
process.env.GPU_SOURCE = 'mock'

const { getDb, rowToTask, rowToAttempt } = await import('./db.js')
const db = getDb()

const task = id => rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))

test('老任务的标量值被回填成单元素数组', () => {
  const done = task(1)
  assert.deepEqual(done.gpuMems, [8192])
  assert.deepEqual(done.gpuIndices, [1])
  assert.deepEqual(done.peakMemPerGpu, [7800])
  assert.equal(done.peakMemMb, 7800, '标量列保持原值不变')
})

test('没跑过的老任务：卡号与峰值保持空，不被填成 [null]', () => {
  const queued = task(2)
  assert.deepEqual(queued.gpuMems, [4096])
  assert.deepEqual(queued.gpuIndices, [])
  assert.equal(queued.peakMemPerGpu, null)
})

test('attempts 表同样被回填', () => {
  const attempt = rowToAttempt(db.prepare('SELECT * FROM attempts WHERE id = 1').get())
  assert.deepEqual(attempt.gpuIndices, [1])
  assert.deepEqual(attempt.peakMemPerGpu, [7800])
})

test('同号的 attempts 只留后写入的那行——它才和磁盘上的日志对得上', () => {
  const rows = db.prepare('SELECT attempt_no, outcome FROM attempts WHERE task_id = 3 ORDER BY attempt_no')
    .all()
    .map(r => ({ attempt_no: r.attempt_no, outcome: r.outcome })) // node:sqlite 返回 null 原型对象
  assert.deepEqual(rows, [
    { attempt_no: 1, outcome: 'round2' },
    { attempt_no: 2, outcome: 'round1' },
    { attempt_no: 3, outcome: 'round1' }
  ])
})

test('去重后 attempt_count 顶到用过的最大编号，下一轮不会再撞上老日志', () => {
  assert.equal(task(3).attemptCount, 3)
})

test('running 任务的 attempt_count 不动——它正指着当前这次尝试的日志和记录', () => {
  assert.equal(
    task(4).attemptCount, 1,
    '改掉它会让运行中的任务对不上自己的 attempts 行，结束时写不进退出码'
  )
  assert.equal(db.prepare('SELECT COUNT(*) c FROM attempts WHERE task_id = 4').get().c, 2)
})

test('retry_count 从 attempt_count 回填，老任务的重试预算保持原样', () => {
  assert.equal(task(1).retryCount, 1)
  assert.equal(task(3).retryCount, 1)
})

test('唯一索引拦住重复编号，这个 bug 从此写不进去', () => {
  assert.throws(
    () => db.prepare(`
      INSERT INTO attempts (task_id, attempt_no, started_at, log_path)
      VALUES (3, 3, 600, '/tmp/c.log')
    `).run(),
    /UNIQUE|constraint/i
  )
})

test('回填可重复执行，不会把已有数组覆盖回标量', () => {
  // 把 2 号任务改成双卡，再跑一遍回填——服务每次启动都会执行它
  db.prepare("UPDATE tasks SET gpu_mems = '[10000,10000]', mem_required_mb = 20000 WHERE id = 2").run()
  db.exec("UPDATE tasks SET gpu_mems = '[' || mem_required_mb || ']' WHERE gpu_mems IS NULL")

  assert.deepEqual(task(2).gpuMems, [10000, 10000], '已有的数组不该被标量覆盖回去')
})

test('retry_count 只在建列那次回填：重启不会把手动重排过的任务的预算又填满', () => {
  // 模拟「升级之后又手动重新排队」：预算归零，而 attempt_count 仍是 3
  db.prepare('UPDATE tasks SET retry_count = 0 WHERE id = 3').run()

  // 迁移只在进程启动时跑一次,只能另起一个进程来验它的第二次执行
  const dbUrl = pathToFileURL(path.join(import.meta.dirname, 'db.js')).href
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { getDb } = await import(${JSON.stringify(dbUrl)})
    console.log(getDb().prepare('SELECT retry_count FROM tasks WHERE id = 3').get().retry_count)
  `], { env: { ...process.env, DATA_DIR }, encoding: 'utf8' })

  assert.equal(
    out.trim(), '0',
    '若每次启动都按 attempt_count 回填，重排过的任务一上来就超预算，从此不再自动重试'
  )
})

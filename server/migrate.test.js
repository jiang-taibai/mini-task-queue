import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

test('回填可重复执行，不会把已有数组覆盖回标量', () => {
  // 把 2 号任务改成双卡，再跑一遍回填——服务每次启动都会执行它
  db.prepare("UPDATE tasks SET gpu_mems = '[10000,10000]', mem_required_mb = 20000 WHERE id = 2").run()
  db.exec("UPDATE tasks SET gpu_mems = '[' || mem_required_mb || ']' WHERE gpu_mems IS NULL")

  assert.deepEqual(task(2).gpuMems, [10000, 10000], '已有的数组不该被标量覆盖回去')
})

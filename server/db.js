import { DatabaseSync } from 'node:sqlite'
import { loadConfig } from './config.js'

let db = null

export function getDb () {
  if (db) return db
  const cfg = loadConfig()
  db = new DatabaseSync(cfg.dbPath)

  // WAL：手动 kill -9 重启是常态，需要崩溃安全
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  migrate(db)
  return db
}

function migrate (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      cwd             TEXT    NOT NULL,
      command         TEXT    NOT NULL,
      mem_required_mb INTEGER NOT NULL,
      allowed_gpus    TEXT,              -- JSON 数组，null 表示不限
      env             TEXT    NOT NULL DEFAULT '{}',
      depends_on      TEXT    NOT NULL DEFAULT '[]',
      timeout_seconds INTEGER,           -- null 表示不限时

      status          TEXT    NOT NULL,  -- blocked|pending|running|succeeded|failed|cancelled
      queue_order     REAL    NOT NULL,
      attempt_count   INTEGER NOT NULL DEFAULT 0,

      gpu_index       INTEGER,
      pid             INTEGER,
      pgid            INTEGER,
      proc_starttime  TEXT,              -- /proc/<pid>/stat 第 22 字段，防 PID 复用误认
      -- 区分「用户主动停止」与「进程自己崩了」：两者退出码都非 0，
      -- 但前者该记为 cancelled，后者要走 OOM 判定和重排队
      stop_requested  INTEGER NOT NULL DEFAULT 0,

      created_at      INTEGER NOT NULL,
      started_at      INTEGER,
      finished_at     INTEGER,

      exit_code       INTEGER,
      fail_reason     TEXT,
      peak_mem_mb     INTEGER,
      -- 实际观测到的占用卡号（JSON 数组）。与 gpu_index 不符即说明分流被绕过，
      -- 常见原因是 .env 里写了 CUDA_VISIBLE_DEVICES 且以覆盖方式加载
      actual_gpus     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_order  ON tasks(queue_order);

    CREATE TABLE IF NOT EXISTS attempts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_no  INTEGER NOT NULL,
      gpu_index   INTEGER,
      pid         INTEGER,
      pgid        INTEGER,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      exit_code   INTEGER,
      outcome     TEXT,                  -- succeeded|failed|oom_requeue|killed|timeout|unknown
      peak_mem_mb INTEGER,
      log_path    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
  `)

  // CREATE TABLE IF NOT EXISTS 不会给已有的库补列，增量字段走这里
  addColumnIfMissing(db, 'tasks', 'actual_gpus', 'TEXT')

  // 多卡支持：显存需求、分配卡号、显存峰值都从标量变成「槽位数组」。
  //
  // 旧的标量列一个都不删，每次写入时同步成派生值（需求与峰值取各槽位之和，
  // gpu_index 取槽位 0）。理由是回退安全：服务就跑在那台带着实验的机器上，
  // 万一要退回上一个版本，旧代码读不到列会直接起不来，而那些 running 任务
  // 还等着被 reclaim() 认领。留着标量列，旧版本至少能启动——它会把双卡任务
  // 误读成「一个 40G 的单卡任务」，语义是错的但不致命。
  addColumnIfMissing(db, 'tasks', 'gpu_mems', 'TEXT')
  addColumnIfMissing(db, 'tasks', 'gpu_indices', 'TEXT')
  addColumnIfMissing(db, 'tasks', 'peak_mem_per_gpu', 'TEXT')
  addColumnIfMissing(db, 'attempts', 'gpu_indices', 'TEXT')
  addColumnIfMissing(db, 'attempts', 'peak_mem_per_gpu', 'TEXT')

  backfillSlotArrays(db)
}

/**
 * 把历史行的标量值回填成单元素数组。
 *
 * 全部带 `IS NULL` 前置条件，因此可以重复执行。源值为 null 的行保持 null——
 * 没跑过的任务本来就没有卡号和峰值，填成 [null] 只会让下游多一处判空。
 */
function backfillSlotArrays (db) {
  db.exec(`
    UPDATE tasks SET gpu_mems = '[' || mem_required_mb || ']' WHERE gpu_mems IS NULL;
    UPDATE tasks SET gpu_indices = '[' || gpu_index || ']'
      WHERE gpu_indices IS NULL AND gpu_index IS NOT NULL;
    UPDATE tasks SET peak_mem_per_gpu = '[' || peak_mem_mb || ']'
      WHERE peak_mem_per_gpu IS NULL AND peak_mem_mb IS NOT NULL;
    UPDATE attempts SET gpu_indices = '[' || gpu_index || ']'
      WHERE gpu_indices IS NULL AND gpu_index IS NOT NULL;
    UPDATE attempts SET peak_mem_per_gpu = '[' || peak_mem_mb || ']'
      WHERE peak_mem_per_gpu IS NULL AND peak_mem_mb IS NOT NULL;
  `)
}

function addColumnIfMissing (db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

/**
 * 解出槽位数组，列为空时回退到标量。
 *
 * 兜底不是多余的：如果你回退过一次版本，旧代码会写进几行没有数组字段的新任务，
 * 再切回新版本时这些行的数组列就是 NULL。回退成 [标量] 至少让它们仍是合法的单卡任务。
 */
function parseSlotArray (json, fallbackScalar, { emptyWhenNull = false } = {}) {
  if (json) return JSON.parse(json)
  if (fallbackScalar === null || fallbackScalar === undefined) return emptyWhenNull ? [] : null
  return [fallbackScalar]
}

/** 数据库行 -> API 对象：把 JSON 字段解开，字段名转驼峰 */
export function rowToTask (row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    command: row.command,
    // 槽位数组是真相源；memRequiredMb 是各槽位之和，仅供展示与旧版本回退
    gpuMems: parseSlotArray(row.gpu_mems, row.mem_required_mb),
    memRequiredMb: row.mem_required_mb,
    allowedGpus: row.allowed_gpus ? JSON.parse(row.allowed_gpus) : null,
    env: JSON.parse(row.env || '{}'),
    dependsOn: JSON.parse(row.depends_on || '[]'),
    timeoutSeconds: row.timeout_seconds,
    status: row.status,
    queueOrder: row.queue_order,
    attemptCount: row.attempt_count,
    // 槽位序的物理卡号；未派发时为空数组。gpuIndex 保留为槽位 0
    gpuIndices: parseSlotArray(row.gpu_indices, row.gpu_index, { emptyWhenNull: true }),
    gpuIndex: row.gpu_index,
    pid: row.pid,
    pgid: row.pgid,
    procStarttime: row.proc_starttime,
    stopRequested: !!row.stop_requested,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    failReason: row.fail_reason,
    // 每个槽位在时间轴上各自的最大值；peakMemMb 是它们的和
    peakMemPerGpu: parseSlotArray(row.peak_mem_per_gpu, row.peak_mem_mb),
    peakMemMb: row.peak_mem_mb,
    actualGpus: row.actual_gpus ? JSON.parse(row.actual_gpus) : null
  }
}

export function rowToAttempt (row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    gpuIndices: parseSlotArray(row.gpu_indices, row.gpu_index, { emptyWhenNull: true }),
    gpuIndex: row.gpu_index,
    pid: row.pid,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    outcome: row.outcome,
    peakMemPerGpu: parseSlotArray(row.peak_mem_per_gpu, row.peak_mem_mb),
    peakMemMb: row.peak_mem_mb
  }
}

export const ACTIVE_STATUSES = ['blocked', 'pending', 'running']
export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled']

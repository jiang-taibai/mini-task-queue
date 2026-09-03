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
      -- 单调递增，永不归零：它同时是日志文件名 attempt-<n>.log 的编号，
      -- 归零会让手动重排后的新一轮覆盖掉上一轮的日志与记录
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      -- 本轮的自动重试预算（OOM 重排队用），手动「重新排队」时归零
      retry_count     INTEGER NOT NULL DEFAULT 0,

      gpu_index       INTEGER,
      pid             INTEGER,
      pgid            INTEGER,
      proc_starttime  TEXT,              -- /proc/<pid>/stat 第 22 字段，防 PID 复用误认
      -- 区分「用户主动停止」与「进程自己崩了」：两者退出码都非 0，
      -- 但前者该记为 cancelled，后者要走 OOM 判定和重排队
      stop_requested  INTEGER NOT NULL DEFAULT 0,

      created_at      INTEGER NOT NULL,
      -- 最近一次进入队列的时刻，「已等待」由它算起。
      -- 与 created_at 分开：重新排队后等待时长应当归零，否则一个昨天创建、
      -- 今天重排的任务会显示「已等待 20 小时」，而它其实刚排上队
      queued_at       INTEGER,
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

  // 手动「重新排队」曾经把 attempt_count 归零，于是第二轮的第 1 次尝试会复用
  // 第一轮的编号：日志文件 attempt-1.log 被追加写、attempts 表多出一行同号记录、
  // 而所有 `WHERE attempt_no = ?` 的更新会同时打到两行上，把第一轮的结果覆盖掉。
  //
  // 拆成两个计数器：attempt_count 单调递增，只负责标识「第几段日志」；
  // retry_count 是本轮的自动重试预算，手动重排时归零。
  if (addColumnIfMissing(db, 'tasks', 'retry_count', 'INTEGER NOT NULL DEFAULT 0')) {
    // 只在列刚建出来时回填：retry_count 为 0 是手动重排后的正常状态，
    // 每次启动都跑一遍会把重排过的任务的重试预算又填满
    db.exec('UPDATE tasks SET retry_count = attempt_count')
  }

  // 「已等待」的计时起点。只在列刚建出来时回填成 created_at——历史行没有更好的
  // 依据，而每次启动都跑一遍会把重排过的任务的等待时长又打回创建时间
  if (addColumnIfMissing(db, 'tasks', 'queued_at', 'INTEGER')) {
    db.exec('UPDATE tasks SET queued_at = created_at')
  }

  repairDuplicateAttempts(db)
}

/**
 * 收拾上面那个 bug 已经造成的历史数据。
 *
 * 同号的两行里，后写入的那行才和磁盘上的日志文件对得上（前一轮的记录早被
 * 覆盖了），所以保留 id 最大的一行。日志本身是追加写的，两轮内容已经混在
 * 同一个文件里，这一点无法追溯修复。
 *
 * 去重之后把 attempt_count 顶到该任务出现过的最大编号：否则下一次重排会从
 * 一个已经用过的编号接着写，又撞上老日志文件。running 的任务不能动——
 * 它的 attempt_count 正被用来定位当前这次尝试的日志和 attempts 行。
 */
function repairDuplicateAttempts (db) {
  db.exec(`
    DELETE FROM attempts WHERE id NOT IN (
      SELECT MAX(id) FROM attempts GROUP BY task_id, attempt_no
    );
    UPDATE tasks SET attempt_count = (
      SELECT MAX(attempt_no) FROM attempts WHERE task_id = tasks.id
    )
    WHERE status <> 'running'
      AND attempt_count < (SELECT COALESCE(MAX(attempt_no), 0) FROM attempts WHERE task_id = tasks.id);
  `)

  // 让这个 bug 从此不可表达。去重刚跑完，正常情况下必定建得起来；
  // 万一有意料之外的数据，宁可少一层保护也不能让服务起不来——
  // 那台机器上还挂着正在跑的实验等着被认领。
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_unique ON attempts(task_id, attempt_no)')
  } catch (err) {
    console.warn('[db] attempts 唯一索引未能建立，跳过:', err.message)
  }
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

/** @returns 是否真的加了列——供只该跑一次的回填判断时机 */
function addColumnIfMissing (db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (columns.some(c => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
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
    retryCount: row.retry_count ?? 0,
    // 槽位序的物理卡号；未派发时为空数组。gpuIndex 保留为槽位 0
    gpuIndices: parseSlotArray(row.gpu_indices, row.gpu_index, { emptyWhenNull: true }),
    gpuIndex: row.gpu_index,
    pid: row.pid,
    pgid: row.pgid,
    procStarttime: row.proc_starttime,
    stopRequested: !!row.stop_requested,
    createdAt: row.created_at,
    // 兜底到 created_at：回退过版本的话，旧代码写的行没有这一列
    queuedAt: row.queued_at ?? row.created_at,
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

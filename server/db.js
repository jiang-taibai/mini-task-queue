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
      peak_mem_mb     INTEGER
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
}

/** 数据库行 -> API 对象：把 JSON 字段解开，字段名转驼峰 */
export function rowToTask (row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    command: row.command,
    memRequiredMb: row.mem_required_mb,
    allowedGpus: row.allowed_gpus ? JSON.parse(row.allowed_gpus) : null,
    env: JSON.parse(row.env || '{}'),
    dependsOn: JSON.parse(row.depends_on || '[]'),
    timeoutSeconds: row.timeout_seconds,
    status: row.status,
    queueOrder: row.queue_order,
    attemptCount: row.attempt_count,
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
    peakMemMb: row.peak_mem_mb
  }
}

export function rowToAttempt (row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    gpuIndex: row.gpu_index,
    pid: row.pid,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    outcome: row.outcome,
    peakMemMb: row.peak_mem_mb
  }
}

export const ACTIVE_STATUSES = ['blocked', 'pending', 'running']
export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled']

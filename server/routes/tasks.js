import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { rowToTask, rowToAttempt } from '../db.js'
import { readLogSlice, statLog, logPathFor, removeTaskLogs, followLog } from '../logs.js'

const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function createTasksRouter ({ db, scheduler, gpu, cfg }) {
  const router = express.Router()

  const listTasks = () =>
    db.prepare('SELECT * FROM tasks ORDER BY queue_order ASC, id ASC').all().map(rowToTask)

  const getTask = id => rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))

  /** 环检测：允许编辑依赖之后，A→B→A 是可以被构造出来的，两个任务会一起 blocked 到天荒地老 */
  function hasCycle (taskId, dependsOn) {
    const seen = new Set()
    const stack = [...dependsOn]
    while (stack.length) {
      const cur = stack.pop()
      if (cur === taskId) return true
      if (seen.has(cur)) continue
      seen.add(cur)
      const row = db.prepare('SELECT depends_on FROM tasks WHERE id = ?').get(cur)
      if (row) stack.push(...JSON.parse(row.depends_on || '[]'))
    }
    return false
  }

  function validate (body, { taskId = null } = {}) {
    const errors = []
    const warnings = []

    const name = String(body.name ?? '').trim()
    if (!name) errors.push('任务名称不能为空')

    const cwd = String(body.cwd ?? '').trim()
    if (!cwd) {
      errors.push('工作目录不能为空')
    } else {
      try {
        if (!fs.statSync(cwd).isDirectory()) errors.push(`工作目录不是目录：${cwd}`)
      } catch {
        errors.push(`工作目录不存在：${cwd}`)
      }
    }

    const command = String(body.command ?? '').trim()
    if (!command) errors.push('命令不能为空')

    const memRequiredMb = Number(body.memRequiredMb)
    if (!Number.isFinite(memRequiredMb) || memRequiredMb <= 0) {
      errors.push('显存需求必须是正数（单位 MB）')
    }

    let allowedGpus = body.allowedGpus ?? null
    if (allowedGpus !== null) {
      if (!Array.isArray(allowedGpus)) {
        errors.push('allowedGpus 必须是数组')
        allowedGpus = null
      } else {
        allowedGpus = allowedGpus.map(Number).filter(n => Number.isInteger(n) && n >= 0)
        if (allowedGpus.length === 0) allowedGpus = null
      }
    }

    const env = body.env ?? {}
    if (typeof env !== 'object' || Array.isArray(env)) {
      errors.push('环境变量必须是键值对象')
    } else {
      for (const key of Object.keys(env)) {
        if (!VALID_ENV_KEY.test(key)) errors.push(`非法的环境变量名：${key}`)
      }
      if ('CUDA_VISIBLE_DEVICES' in env) {
        warnings.push('你设置的 CUDA_VISIBLE_DEVICES 会被调度器覆盖——分流由系统决定卡号，请从命令中使用 cuda:0')
      }
    }

    let dependsOn = body.dependsOn ?? []
    if (!Array.isArray(dependsOn)) {
      errors.push('dependsOn 必须是数组')
      dependsOn = []
    } else {
      dependsOn = [...new Set(dependsOn.map(Number).filter(Number.isInteger))]
      for (const depId of dependsOn) {
        if (depId === taskId) errors.push('任务不能依赖自己')
        else if (!getTask(depId)) errors.push(`依赖的任务 #${depId} 不存在`)
      }
      if (taskId !== null && hasCycle(taskId, dependsOn)) {
        errors.push('检测到循环依赖')
      }
    }

    let timeoutSeconds = body.timeoutSeconds ?? null
    if (timeoutSeconds !== null && timeoutSeconds !== '') {
      timeoutSeconds = Number(timeoutSeconds)
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        errors.push('超时时长必须是正数（单位秒）')
        timeoutSeconds = null
      }
    } else {
      timeoutSeconds = null
    }

    // 命令里硬编码卡号会让分流静默错位：任务跑到非预期的卡上，账本却以为它在别处
    if (/\bcuda:[1-9]\b/.test(command)) {
      warnings.push('命令中出现了 cuda:1 之类的硬编码卡号。分流靠 CUDA_VISIBLE_DEVICES 实现，设定后代码里应统一使用 cuda:0')
    }

    warnings.push(...checkDotenv(cwd))

    return {
      errors,
      warnings,
      value: { name, cwd, command, memRequiredMb, allowedGpus, env, dependsOn, timeoutSeconds }
    }
  }

  /**
   * 提交时就检查工作目录下的 .env 有没有写 CUDA_VISIBLE_DEVICES。
   *
   * 它是否真会盖掉调度器的设置取决于加载方式——`load_dotenv()` 默认不覆盖
   * 已有变量（安全），但 `override=True`、`source .env`、direnv 都会覆盖。
   * 与其等任务跑到错误的卡上再靠漂移检测发现，不如在这里提醒一句。
   */
  function checkDotenv (cwd) {
    if (!cwd) return []
    try {
      const envPath = path.join(cwd, '.env')
      const stat = fs.statSync(envPath)
      if (!stat.isFile() || stat.size > 256 * 1024) return []

      const content = fs.readFileSync(envPath, 'utf8')
      const hit = content.split('\n').find(line =>
        /^\s*(export\s+)?CUDA_VISIBLE_DEVICES\s*=/.test(line)
      )
      if (!hit) return []

      return [
        `工作目录下的 .env 里设置了 CUDA_VISIBLE_DEVICES（${hit.trim()}）。` +
        '若你的代码用 load_dotenv(override=True)、source .env 或 direnv 加载，它会盖掉调度器分配的卡号，' +
        '导致任务跑错卡而账本记错账。load_dotenv() 默认不覆盖，则不受影响。'
      ]
    } catch {
      return []
    }
  }


  router.get('/', (req, res) => {
    res.json({
      tasks: listTasks(),
      blocking: scheduler.getBlockingInfo()
    })
  })

  router.post('/', (req, res) => {
    const { errors, warnings, value } = validate(req.body)
    if (errors.length) return res.status(400).json({ error: errors[0], errors })

    const maxOrder = db.prepare('SELECT COALESCE(MAX(queue_order), 0) AS m FROM tasks').get().m
    const status = value.dependsOn.length > 0 ? 'blocked' : 'pending'

    const info = db.prepare(`
      INSERT INTO tasks (name, cwd, command, mem_required_mb, allowed_gpus, env, depends_on,
                         timeout_seconds, status, queue_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.name, value.cwd, value.command, value.memRequiredMb,
      value.allowedGpus ? JSON.stringify(value.allowedGpus) : null,
      JSON.stringify(value.env), JSON.stringify(value.dependsOn),
      value.timeoutSeconds, status, maxOrder + 1000, Date.now()
    )

    const task = getTask(Number(info.lastInsertRowid))
    scheduler.emitChange(task.id)
    scheduler.tick()
    res.status(201).json({ task, warnings })
  })

  router.get('/:id', (req, res) => {
    const task = getTask(Number(req.params.id))
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const attempts = db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC')
      .all(task.id).map(rowToAttempt)

    // 附上日志文件大小：几百 MB 的日志不该被无声无息地整个拉进浏览器
    const attemptsWithLog = attempts.map(a => {
      const path = logPathFor(cfg.logsDir, task.id, a.attemptNo)
      const st = fs.existsSync(path) ? fs.statSync(path) : null
      return { ...a, logSize: st ? st.size : 0 }
    })

    const dependents = db.prepare('SELECT id, name, status, depends_on FROM tasks').all()
      .filter(r => JSON.parse(r.depends_on || '[]').includes(task.id))
      .map(r => ({ id: r.id, name: r.name, status: r.status }))

    res.json({
      task,
      attempts: attemptsWithLog,
      dependencies: task.dependsOn.map(id => {
        const d = getTask(id)
        return d ? { id: d.id, name: d.name, status: d.status } : { id, name: '（已删除）', status: 'missing' }
      }),
      dependents
    })
  })

  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id)
    const task = getTask(id)
    if (!task) return res.status(404).json({ error: '任务不存在' })
    if (task.status === 'running') {
      return res.status(409).json({ error: '任务正在运行，无法编辑' })
    }

    const { errors, warnings, value } = validate({ ...task, ...req.body }, { taskId: id })
    if (errors.length) return res.status(400).json({ error: errors[0], errors })

    const status = ['pending', 'blocked'].includes(task.status)
      ? (value.dependsOn.length > 0 ? 'blocked' : 'pending')
      : task.status

    db.prepare(`
      UPDATE tasks SET name = ?, cwd = ?, command = ?, mem_required_mb = ?, allowed_gpus = ?,
                       env = ?, depends_on = ?, timeout_seconds = ?, status = ?
      WHERE id = ?
    `).run(
      value.name, value.cwd, value.command, value.memRequiredMb,
      value.allowedGpus ? JSON.stringify(value.allowedGpus) : null,
      JSON.stringify(value.env), JSON.stringify(value.dependsOn),
      value.timeoutSeconds, status, id
    )

    scheduler.emitChange(id)
    scheduler.tick()
    res.json({ task: getTask(id), warnings })
  })

  router.delete('/:id', async (req, res) => {
    const id = Number(req.params.id)
    const task = getTask(id)
    if (!task) return res.status(404).json({ error: '任务不存在' })
    if (task.status === 'running') {
      return res.status(409).json({ error: '任务正在运行，请先停止再删除' })
    }

    db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    await removeTaskLogs(cfg.logsDir, id)
    scheduler.emitChange(id)
    res.json({ ok: true })
  })

  router.post('/:id/stop', (req, res) => {
    const result = scheduler.requestStop(Number(req.params.id))
    res.status(result.ok ? 200 : 400).json(result)
  })

  /** 把失败或取消的任务放回队列，保持它原来的排序位置 */
  router.post('/:id/requeue', (req, res) => {
    const id = Number(req.params.id)
    const task = getTask(id)
    if (!task) return res.status(404).json({ error: '任务不存在' })
    if (['running', 'pending', 'blocked'].includes(task.status)) {
      return res.status(409).json({ error: '任务尚未结束，无需重新排队' })
    }

    const status = task.dependsOn.length > 0 ? 'blocked' : 'pending'
    db.prepare(`
      UPDATE tasks
      SET status = ?, attempt_count = 0, stop_requested = 0, pid = NULL, pgid = NULL,
          proc_starttime = NULL, gpu_index = NULL, started_at = NULL, finished_at = NULL,
          exit_code = NULL, fail_reason = NULL
      WHERE id = ?
    `).run(status, id)

    scheduler.emitChange(id)
    scheduler.tick()
    res.json({ task: getTask(id) })
  })

  /** 拖拽排序：前端提交完整的 id 顺序，后端整体重写 queue_order */
  router.post('/reorder', (req, res) => {
    const ids = req.body?.ids
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必须是数组' })

    db.exec('BEGIN')
    try {
      const stmt = db.prepare('UPDATE tasks SET queue_order = ? WHERE id = ?')
      ids.forEach((id, index) => stmt.run((index + 1) * 1000, Number(id)))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      return res.status(500).json({ error: err.message })
    }

    scheduler.emitChange(null)
    scheduler.tick()
    res.json({ tasks: listTasks() })
  })

  router.get('/:id/logs', async (req, res) => {
    const id = Number(req.params.id)
    const task = getTask(id)
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const attempt = Number(req.query.attempt ?? task.attemptCount) || 1
    const path = logPathFor(cfg.logsDir, id, attempt)
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : null
    const maxBytes = Math.min(Number(req.query.maxBytes ?? 200 * 1024), 2 * 1024 * 1024)

    const [slice, st] = await Promise.all([
      readLogSlice(path, { offset, maxBytes }),
      statLog(path)
    ])
    res.json({ ...slice, exists: st.exists, attempt })
  })

  /** 日志单开一条 SSE：训练日志每秒几十行，混进状态流会把整个界面的刷新拖慢 */
  router.get('/:id/logs/stream', (req, res) => {
    const id = Number(req.params.id)
    const task = getTask(id)
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const attempt = Number(req.query.attempt ?? task.attemptCount) || 1
    const path = logPathFor(cfg.logsDir, id, attempt)
    const fromOffset = Number(req.query.offset ?? 0)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no' // 让 nginx 不要缓冲 SSE
    })
    res.write(': connected\n\n')

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    const stopFollow = followLog(path, {
      fromOffset,
      onData: payload => send('append', payload),
      onError: err => send('error', { message: err.message })
    })

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000)

    req.on('close', () => {
      stopFollow()
      clearInterval(heartbeat)
    })
  })

  return router
}

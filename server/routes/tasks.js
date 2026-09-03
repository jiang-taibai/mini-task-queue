import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { rowToTask, rowToAttempt } from '../db.js'
import { formatMb } from '../scheduler.js'
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

    // 槽位数组是真相源；memRequiredMb 退化为各槽位之和，只用于展示与旧版本兼容
    //
    // 空数组是合法的：那是纯 CPU 任务，不分配任何卡。但它必须由 gpuMems 显式表达——
    // 两个字段都没传只能是客户端漏了，那种情况仍要拦，否则一个字段名写错的请求
    // 会静默变成 CPU 任务
    const declaredSlots = Array.isArray(body.gpuMems)
    let gpuMems = declaredSlots
      ? body.gpuMems.map(Number)
      : (body.memRequiredMb === undefined ? [] : [Number(body.memRequiredMb)])

    if (!declaredSlots && gpuMems.length === 0) {
      errors.push('至少要声明一张卡的显存需求（纯 CPU 任务请显式提交 gpuMems: []）')
    } else if (gpuMems.some(m => !Number.isFinite(m) || m <= 0)) {
      errors.push('每张卡的显存需求必须是正数（单位 MB）')
      gpuMems = []
    }
    const memRequiredMb = gpuMems.reduce((sum, m) => sum + m, 0)

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

    // 「限定 GPU」比申请卡数还少：纯粹是用户输入自相矛盾，不依赖任何运行时信息，
    // 任何时候都拦
    if (gpuMems.length > 0 && allowedGpus && allowedGpus.length < gpuMems.length) {
      errors.push(`需要 ${gpuMems.length} 张卡，但「限定 GPU」只允许了 ${allowedGpus.length} 张，这个任务永远排不上`)
    }

    if (gpuMems.length > 0) {
      errors.push(...checkFeasible(gpuMems, allowedGpus))
      warnings.push(...checkFootprint(gpuMems, command))
    }

    const env = body.env ?? {}
    if (typeof env !== 'object' || Array.isArray(env)) {
      errors.push('环境变量必须是键值对象')
    } else {
      for (const key of Object.keys(env)) {
        if (!VALID_ENV_KEY.test(key)) errors.push(`非法的环境变量名：${key}`)
      }
      if ('CUDA_VISIBLE_DEVICES' in env) {
        warnings.push('你设置的 CUDA_VISIBLE_DEVICES 会被调度器覆盖——分流由系统决定卡号，' +
          (gpuMems.length > 1
            ? `代码里请使用 cuda:0 到 cuda:${gpuMems.length - 1}`
            : '代码里请统一使用 cuda:0'))
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

    // 命令里硬编码卡号会让分流静默错位：任务跑到非预期的卡上，账本却以为它在别处。
    // 多卡任务里 cuda:1 是完全正当的写法，只有超出本任务可见范围的卡号才值得提醒。
    const mentionedGpus = [...new Set(
      [...command.matchAll(/\bcuda:(\d+)\b/g)].map(m => Number(m[1]))
    )].sort((a, b) => a - b)

    if (gpuMems.length === 0) {
      // 纯 CPU 任务：CUDA_VISIBLE_DEVICES 会被设成空串，任何卡号都用不了。
      // 这多半是「忘了把卡数改回去」，不拦但必须说清楚，否则只会看到一句 CUDA 报错
      if (mentionedGpus.length > 0) {
        warnings.push('这是纯 CPU 任务（0 张卡），但命令里出现了 ' +
          `${mentionedGpus.map(n => `cuda:${n}`).join('、')}。` +
          'CUDA_VISIBLE_DEVICES 会被设为空，脚本看不到任何 GPU')
      }
    } else {
      const visibleCount = gpuMems.length
      const outOfRange = mentionedGpus.filter(n => n >= visibleCount)
      if (outOfRange.length) {
        warnings.push(visibleCount === 1
          ? '命令中出现了 cuda:1 之类的硬编码卡号。分流靠 CUDA_VISIBLE_DEVICES 实现，设定后代码里应统一使用 cuda:0'
          : `命令中出现了 ${outOfRange.map(n => `cuda:${n}`).join('、')}，` +
            `超出本任务申请的 ${visibleCount} 张卡——脚本只看得见 cuda:0 到 cuda:${visibleCount - 1}`)
      }
    }

    warnings.push(...checkDotenv(cwd))

    return {
      errors,
      warnings,
      value: { name, cwd, command, gpuMems, memRequiredMb, allowedGpus, env, dependsOn, timeoutSeconds }
    }
  }

  /**
   * 拦掉结构性不可能的任务——那些提交成功、进了队列、然后永远挂在那里的。
   *
   * 多卡放大了这类错误：用户很容易把「总需求」填进「每卡」的框，40G 总量填成
   * 两个 40G，于是要 80G 而机器只有 48G。任务看起来在排队，实际在等一件
   * 不可能发生的事。
   *
   * 判据是 memTotalMb——静态硬件信息，读数陈旧也不影响结论，所以用「拿不拿得到
   * 设备列表」而不是 isStale() 来决定要不要检查。GPU 监控挂了照样收任务：
   * 把「监控故障」升级成「提交不了任务」是不可接受的，反正 tick() 里的 isStale()
   * 闸门本来就会挡住派发。
   */
  function checkFeasible (gpuMems, allowedGpus) {
    const devices = gpu.getDevices()
    if (devices.length === 0) return []

    const pool = devices
      .filter(d => !allowedGpus || allowedGpus.includes(d.index))
      .map(d => d.memTotalMb)
      .sort((a, b) => b - a)

    if (pool.length < gpuMems.length) {
      return [allowedGpus
        ? `需要 ${gpuMems.length} 张卡，但「限定 GPU」框定的范围内只有 ${pool.length} 张`
        : `需要 ${gpuMems.length} 张卡，但本机只有 ${pool.length} 张`]
    }

    // 需求降序对卡容量降序逐对比，配不上就是任何配法都配不上
    const need = [...gpuMems].sort((a, b) => b - a)
    for (let i = 0; i < need.length; i++) {
      if (pool[i] < need[i]) {
        return [`某张卡声明了 ${formatMb(need[i])}，超过可分配范围内单卡的显存上限 ${formatMb(pool[i])}` +
          (gpuMems.length > 1 ? '——注意每个框填的是「单张卡」的需求，不是总量' : '')]
      }
    }
    return []
  }

  /** 不拦，只提醒：这些情况合法但很可能不是用户想要的 */
  function checkFootprint (gpuMems, command) {
    const out = []
    const devices = gpu.getDevices()

    if (devices.length > 0) {
      const total = devices.reduce((sum, d) => sum + d.memTotalMb, 0)
      const asked = gpuMems.reduce((sum, m) => sum + m, 0)
      if (asked > total * 0.8) {
        out.push(`这个任务需要 ${formatMb(asked)}，接近整机显存总量 ${formatMb(total)}。` +
          '在与他人共用的机器上可能长时间排不上队。')
      }
    }

    // 启发式，会误报（比如你用自己的 launcher 脚本包了一层），所以只做警告
    if (gpuMems.length > 1 && !/torchrun|accelerate|deepspeed|device_map|torch\.distributed/.test(command)) {
      out.push(`你申请了 ${gpuMems.length} 张卡，但命令看起来是单进程单卡的写法。` +
        '请确认脚本会真的用到第二张卡，否则那张卡会被预留着闲置。')
    }
    return out
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

    const now = Date.now()
    const info = db.prepare(`
      INSERT INTO tasks (name, cwd, command, mem_required_mb, gpu_mems, allowed_gpus, env, depends_on,
                         timeout_seconds, status, queue_order, created_at, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.name, value.cwd, value.command, value.memRequiredMb, JSON.stringify(value.gpuMems),
      value.allowedGpus ? JSON.stringify(value.allowedGpus) : null,
      JSON.stringify(value.env), JSON.stringify(value.dependsOn),
      value.timeoutSeconds, status, maxOrder + 1000, now, now
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
      UPDATE tasks SET name = ?, cwd = ?, command = ?, mem_required_mb = ?, gpu_mems = ?, allowed_gpus = ?,
                       env = ?, depends_on = ?, timeout_seconds = ?, status = ?
      WHERE id = ?
    `).run(
      value.name, value.cwd, value.command, value.memRequiredMb, JSON.stringify(value.gpuMems),
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
    // 只把 retry_count 归零，attempt_count 保持不动：新一轮从下一个编号往后写，
    // 上一轮的 attempt-<n>.log 和 attempts 记录原样留着可查。
    // 归零 attempt_count 会让两轮共用编号——日志被追加进同一个文件，
    // attempts 表出现两行同号记录，之后所有 `WHERE attempt_no = ?` 的更新
    // 会同时改到两行，把上一轮的结果覆盖掉
    // queued_at 重置：等待时长该从「这一次排上队」算起，而不是最初创建的时刻
    db.prepare(`
      UPDATE tasks
      SET status = ?, retry_count = 0, stop_requested = 0, pid = NULL, pgid = NULL,
          proc_starttime = NULL, gpu_index = NULL, gpu_indices = NULL, queued_at = ?,
          started_at = NULL, finished_at = NULL, exit_code = NULL, fail_reason = NULL
      WHERE id = ?
    `).run(status, Date.now(), id)

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

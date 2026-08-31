import { EventEmitter } from 'node:events'
import { rowToTask } from './db.js'
import { isSameProcess, getPgid } from './runner.js'
import { readTailSync, logPathFor } from './logs.js'

/**
 * 判定「抢卡失败」而非「代码有 bug」的关键词。
 *
 * 单靠关键词不够——跑了两小时才 OOM 的那是 batch size 有问题，重排一万次也没用。
 * 必须叠加运行时长窗口：只有启动后很快就 OOM 的，才算没抢过别人。
 */
const OOM_PATTERNS = [
  /CUDA out of memory/i,
  /CUDA error:\s*out of memory/i,
  /torch\.cuda\.OutOfMemoryError/i,
  /CUBLAS_STATUS_ALLOC_FAILED/i,
  /CUDNN_STATUS_ALLOC_FAILED/i,
  /cudaErrorMemoryAllocation/i
]

export class Scheduler extends EventEmitter {
  constructor (cfg, db, gpu, runner) {
    super()
    this.cfg = cfg
    this.db = db
    this.gpu = gpu
    this.runner = runner

    /**
     * 软预留账本：taskId -> { gpuIndex, memMb, expiresAt }
     *
     * 从「进程启动」到「nvidia-smi 观测到它吃满显存」之间有一段盲区，
     * 这段时间里那块显存在读数上仍然是空闲的。没有这个账本，同一拍里
     * 两个任务会双双被派到同一张卡上，然后一起 OOM——这是纯粹的自伤，
     * 而且与外部同事无关，完全是我们自己能控制的部分。
     */
    this.reservations = new Map()

    /** 进程已消失但退出码文件还没落盘的任务：taskId -> 首次发现消失的时刻 */
    this.awaitingExitCode = new Map()

    this.ticking = false
  }

  start () {
    this.reclaim()
    // 跟着 GPU 数据走：有新读数才有必要重新决策
    this.gpu.on('update', () => this.tick())
    // 兜底，保证 GPU 失联时 running 任务的退出仍能被发现
    this.timer = setInterval(() => this.tick(), 2000)
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
  }

  tick () {
    if (this.ticking) return
    this.ticking = true
    try {
      this.reconcileRunning()

      // 失联闸门：宁可一张卡都不派，也不拿过期数据做决策。
      // 满载环境下 5 秒前的显存读数已经是废纸。
      if (this.gpu.isStale()) return

      this.collectPeakMemory()
      this.pruneReservations()
      this.resolveDependencies()
      this.dispatch()
    } catch (err) {
      console.error('[scheduler] tick 异常:', err)
    } finally {
      this.ticking = false
    }
  }

  // —— 查询 ——

  query (sql, ...params) {
    return this.db.prepare(sql).all(...params).map(rowToTask)
  }

  getRunning () {
    return this.query("SELECT * FROM tasks WHERE status = 'running'")
  }

  getQueue () {
    return this.query("SELECT * FROM tasks WHERE status IN ('blocked','pending') ORDER BY queue_order ASC, id ASC")
  }

  getTask (id) {
    return rowToTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
  }

  // —— running 任务的存活与退出 ——

  reconcileRunning () {
    const now = Date.now()

    for (const task of this.getRunning()) {
      // 超时（可选功能，默认不限）：死锁的 dataloader 会永久占着卡
      if (task.timeoutSeconds && task.startedAt && now - task.startedAt > task.timeoutSeconds * 1000) {
        if (!task.stopRequested) {
          this.db.prepare("UPDATE tasks SET stop_requested = 1, fail_reason = ? WHERE id = ?")
            .run(`超过设定的最大运行时长 ${task.timeoutSeconds}s，已强制停止`, task.id)
          this.runner.stopTask(task)
          this.emitChange(task.id)
          continue
        }
      }

      if (isSameProcess(task.pid, task.procStarttime)) {
        this.awaitingExitCode.delete(task.id)
        continue
      }

      // 进程没了。退出码由 wrapper 写文件，但落盘有极短延迟，给它几秒宽限。
      const exitCode = this.runner.readExitCode(task.id, task.attemptCount)
      if (exitCode === null) {
        const since = this.awaitingExitCode.get(task.id)
        if (!since) {
          this.awaitingExitCode.set(task.id, now)
          continue
        }
        if (now - since < 3000) continue
        // 超过宽限仍无退出码：多半是被 SIGKILL 掉了，wrapper 没机会写
        this.finishTask(task, { exitCode: null, outcome: 'unknown' })
      } else {
        this.finishTask(task, { exitCode })
      }
      this.awaitingExitCode.delete(task.id)
    }
  }

  finishTask (task, { exitCode, outcome = null }) {
    const now = Date.now()
    const durationMs = task.startedAt ? now - task.startedAt : 0
    this.reservations.delete(task.id)
    this.runner.forget(task.id)
    this.gpu.mock?.noteTaskEnd(task.pgid)

    let status
    let failReason = null
    let attemptOutcome = outcome

    if (task.stopRequested) {
      status = 'cancelled'
      attemptOutcome = 'killed'
      failReason = task.failReason ?? '已手动停止'
    } else if (exitCode === 0) {
      status = 'succeeded'
      attemptOutcome = 'succeeded'
    } else if (this.looksLikeLostRace(task, durationMs)) {
      // 没抢过别人：启动后很快就因显存不足倒下
      if (task.attemptCount < this.cfg.scheduler.maxRetries) {
        this.requeueTask(task, `第 ${task.attemptCount} 次抢卡失败（显存不足），已重新排队`)
        return
      }
      status = 'failed'
      attemptOutcome = 'failed'
      failReason = `连续 ${task.attemptCount} 次因显存不足失败，请检查显存声明是否偏小`
    } else {
      status = 'failed'
      attemptOutcome = attemptOutcome ?? 'failed'
      failReason = exitCode === null
        ? '进程已消失但未留下退出码（可能被外部强制终止）'
        : `退出码 ${exitCode}`
    }

    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        UPDATE tasks SET status = ?, finished_at = ?, exit_code = ?, fail_reason = ?
        WHERE id = ?
      `).run(status, now, exitCode, failReason, task.id)

      this.db.prepare(`
        UPDATE attempts SET finished_at = ?, exit_code = ?, outcome = ?
        WHERE task_id = ? AND attempt_no = ?
      `).run(now, exitCode, attemptOutcome, task.id, task.attemptCount)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    if (status !== 'succeeded') this.cascadeCancel(task.id, status)
    this.emitChange(task.id)
  }

  looksLikeLostRace (task, durationMs) {
    if (durationMs > this.cfg.scheduler.oomWindowSeconds * 1000) return false
    const tail = readTailSync(logPathFor(this.cfg.logsDir, task.id, task.attemptCount), 16384)
    return OOM_PATTERNS.some(re => re.test(tail))
  }

  /** 抢卡失败后回到队列的原位置——保持你手动排的顺序不被打乱 */
  requeueTask (task, reason) {
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        UPDATE tasks
        SET status = 'pending', pid = NULL, pgid = NULL, proc_starttime = NULL,
            gpu_index = NULL, started_at = NULL, fail_reason = ?
        WHERE id = ?
      `).run(reason, task.id)

      this.db.prepare(`
        UPDATE attempts SET finished_at = ?, outcome = 'oom_requeue' WHERE task_id = ? AND attempt_no = ?
      `).run(now, task.id, task.attemptCount)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.emit('log', `任务 #${task.id} ${reason}`)
    this.emitChange(task.id)
  }

  // —— 依赖 ——

  resolveDependencies () {
    for (const task of this.query("SELECT * FROM tasks WHERE status = 'blocked'")) {
      if (task.dependsOn.length === 0) {
        this.setStatus(task.id, 'pending')
        continue
      }

      const deps = task.dependsOn.map(id => this.getTask(id)).filter(Boolean)

      // 依赖的任务被删了：无从判断前置是否成功，保守起见不放行
      if (deps.length !== task.dependsOn.length) {
        this.cancelTask(task.id, '依赖的任务已不存在')
        continue
      }

      const failed = deps.find(d => d.status === 'failed' || d.status === 'cancelled')
      if (failed) {
        this.cancelTask(task.id, `依赖 #${failed.id} ${failed.status === 'failed' ? '失败' : '被取消'}`)
        continue
      }

      if (deps.every(d => d.status === 'succeeded')) {
        this.setStatus(task.id, 'pending')
      }
    }
  }

  /** 前置失败则整条链一起取消：训练挂了，后面的评测跑了也是垃圾，还白占卡 */
  cascadeCancel (failedId, reason) {
    const dependents = this.query("SELECT * FROM tasks WHERE status IN ('blocked','pending')")
      .filter(t => t.dependsOn.includes(failedId))

    for (const dep of dependents) {
      this.cancelTask(dep.id, `依赖 #${failedId} ${reason === 'failed' ? '失败' : '被取消'}`)
      this.cascadeCancel(dep.id, 'cancelled')
    }
  }

  cancelTask (id, reason) {
    this.db.prepare(`
      UPDATE tasks SET status = 'cancelled', finished_at = ?, fail_reason = ? WHERE id = ?
    `).run(Date.now(), reason, id)
    this.emitChange(id)
  }

  setStatus (id, status) {
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id)
    this.emitChange(id)
  }

  // —— 预留账本 ——

  pruneReservations () {
    const now = Date.now()
    const processes = this.gpu.getProcesses()

    for (const [taskId, res] of this.reservations) {
      const task = this.getTask(taskId)
      if (!task || task.status !== 'running') {
        this.reservations.delete(taskId)
        continue
      }

      if (now > res.expiresAt) {
        this.reservations.delete(taskId)
        continue
      }

      // 提前解除：已经能在 GPU 上看到这个任务的进程了，说明显存读数已反映它，
      // 账本再挂着就是重复扣减，白白让卡闲置
      if (task.pgid && processes.length > 0) {
        const observed = processes
          .filter(p => getPgid(p.pid) === task.pgid)
          .reduce((sum, p) => sum + p.usedMemoryMb, 0)
        if (observed >= res.memMb * 0.5) this.reservations.delete(taskId)
      }
    }
  }

  reservedOn (gpuIndex) {
    let total = 0
    for (const res of this.reservations.values()) {
      if (res.gpuIndex === gpuIndex) total += res.memMb
    }
    return total
  }

  availableMemOn (gpuIndex) {
    const device = this.gpu.getDevices().find(d => d.index === gpuIndex)
    if (!device) return 0
    return device.memFreeMb - this.reservedOn(gpuIndex)
  }

  // —— 派发 ——

  pickGpu (task, runningByGpu) {
    const candidates = this.gpu.getDevices()
      .filter(d => !task.allowedGpus || task.allowedGpus.includes(d.index))
      .filter(d => (runningByGpu.get(d.index) ?? 0) < this.cfg.scheduler.maxPerGpu)
      .map(d => ({ index: d.index, available: this.availableMemOn(d.index) }))
      .filter(d => d.available >= task.memRequiredMb)

    if (candidates.length === 0) return null
    // 多张卡都够时选余量最大的，给后续任务留下更完整的空间
    candidates.sort((a, b) => b.available - a.available)
    return candidates[0].index
  }

  dispatch () {
    const runningByGpu = new Map()
    for (const t of this.getRunning()) {
      if (t.gpuIndex !== null) runningByGpu.set(t.gpuIndex, (runningByGpu.get(t.gpuIndex) ?? 0) + 1)
    }

    for (const task of this.getQueue()) {
      // 严格门控：队头排不上，后面的一律等待。
      // 你手动排的顺序是硬承诺，系统不会自作主张让小任务插队。
      if (task.status === 'blocked') break

      const gpuIndex = this.pickGpu(task, runningByGpu)
      if (gpuIndex === null) break

      try {
        this.launchTask(task, gpuIndex)
        runningByGpu.set(gpuIndex, (runningByGpu.get(gpuIndex) ?? 0) + 1)
      } catch (err) {
        console.error(`[scheduler] 启动任务 #${task.id} 失败:`, err)
        this.db.prepare(`
          UPDATE tasks SET status = 'failed', finished_at = ?, fail_reason = ? WHERE id = ?
        `).run(Date.now(), `启动失败：${err.message}`, task.id)
        this.emitChange(task.id)
      }
      break // 一拍只派一个：给账本和监控留出反应时间，避免瞬间超派
    }
  }

  launchTask (task, gpuIndex) {
    const attemptNo = task.attemptCount + 1
    const now = Date.now()

    // launch 是异步的，但派发必须同步完成账本记账，否则同一拍的后续决策会看到旧数据。
    // 这里先占坑，再实际启动。
    this.reservations.set(task.id, {
      gpuIndex,
      memMb: task.memRequiredMb,
      expiresAt: now + this.cfg.scheduler.warmupSeconds * 1000
    })

    this.runner.launch(task, gpuIndex, attemptNo).then(({ pid, pgid, procStarttime, logPath }) => {
      this.db.exec('BEGIN')
      try {
        this.db.prepare(`
          UPDATE tasks
          SET status = 'running', gpu_index = ?, pid = ?, pgid = ?, proc_starttime = ?,
              started_at = ?, attempt_count = ?, finished_at = NULL, exit_code = NULL, fail_reason = NULL
          WHERE id = ?
        `).run(gpuIndex, pid, pgid, procStarttime, now, attemptNo, task.id)

        this.db.prepare(`
          INSERT INTO attempts (task_id, attempt_no, gpu_index, pid, pgid, started_at, log_path)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(task.id, attemptNo, gpuIndex, pid, pgid, now, logPath)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }

      this.gpu.mock?.noteTaskStart(pgid, gpuIndex, task.memRequiredMb)
      this.emit('log', `任务 #${task.id}「${task.name}」已派往 GPU ${gpuIndex}（第 ${attemptNo} 次尝试）`)
      this.emitChange(task.id)
    }).catch(err => {
      this.reservations.delete(task.id)
      console.error(`[scheduler] 任务 #${task.id} 启动失败:`, err)
      this.db.prepare(`
        UPDATE tasks SET status = 'failed', finished_at = ?, fail_reason = ? WHERE id = ?
      `).run(Date.now(), `启动失败：${err.message}`, task.id)
      this.emitChange(task.id)
    })
  }

  // —— 显存峰值采集 ——

  /**
   * 记录任务实际用到的显存峰值，克隆时用它预填需求。
   *
   * 匹配靠进程组：nvidia-smi 报的是真正跑 CUDA 的 python 进程，
   * 而我们启动的是 bash wrapper，两者 PID 不同。detached 让整棵进程树
   * 共享同一个 pgid，于是 pgid 成了任务的天然标识。
   */
  collectPeakMemory () {
    const processes = this.gpu.getProcesses()
    if (processes.length === 0) return

    const running = this.getRunning()
    if (running.length === 0) return

    const byPgid = new Map()
    for (const p of processes) {
      const pgid = getPgid(p.pid)
      if (pgid === null) continue
      byPgid.set(pgid, (byPgid.get(pgid) ?? 0) + p.usedMemoryMb)
    }

    for (const task of running) {
      const used = byPgid.get(task.pgid)
      if (used === undefined) continue
      if (task.peakMemMb === null || used > task.peakMemMb) {
        this.db.prepare('UPDATE tasks SET peak_mem_mb = ? WHERE id = ?').run(used, task.id)
        this.db.prepare('UPDATE attempts SET peak_mem_mb = ? WHERE task_id = ? AND attempt_no = ?')
          .run(used, task.id, task.attemptCount)
      }
    }
  }

  // —— 重启后认领 ——

  /**
   * 服务重启后重新接管仍在运行的任务。
   *
   * 因为任务是 detached 启动的，它们在服务不在的这段时间里照常运行；
   * 重启后必须把它们认回来，否则会被当成"消失"而误判失败，
   * 更糟的是账本不认识它们，会把已被占用的卡再派出去。
   */
  reclaim () {
    const running = this.getRunning()
    if (running.length === 0) return

    let alive = 0
    let dead = 0
    const now = Date.now()

    for (const task of running) {
      if (isSameProcess(task.pid, task.procStarttime)) {
        alive++
        // 若仍在预热期内，把预留补回账本
        const warmupMs = this.cfg.scheduler.warmupSeconds * 1000
        if (task.startedAt && now - task.startedAt < warmupMs) {
          this.reservations.set(task.id, {
            gpuIndex: task.gpuIndex,
            memMb: task.memRequiredMb,
            expiresAt: task.startedAt + warmupMs
          })
        }
      } else {
        dead++
        const exitCode = this.runner.readExitCode(task.id, task.attemptCount)
        this.finishTask(task, { exitCode, outcome: exitCode === null ? 'unknown' : undefined })
      }
    }

    console.log(`[scheduler] 认领完成：${alive} 个任务仍在运行，${dead} 个已在服务离线期间结束`)
  }

  // —— 外部动作 ——

  requestStop (taskId) {
    const task = this.getTask(taskId)
    if (!task) return { ok: false, message: '任务不存在' }

    if (task.status === 'running') {
      this.db.prepare("UPDATE tasks SET stop_requested = 1 WHERE id = ?").run(taskId)
      const sent = this.runner.stopTask({ ...task, stopRequested: true })
      this.emitChange(taskId)
      return { ok: true, message: sent ? '已发送停止信号' : '进程已不存在，将标记为已取消' }
    }

    if (task.status === 'pending' || task.status === 'blocked') {
      this.cancelTask(taskId, '已手动取消')
      this.cascadeCancel(taskId, 'cancelled')
      return { ok: true, message: '已从队列中移除' }
    }

    return { ok: false, message: `任务处于 ${task.status} 状态，无需停止` }
  }

  emitChange (taskId) {
    this.emit('change', { taskId })
  }

  /** 队列被谁挡住了——UI 顶部的阻塞提示条用它 */
  getBlockingInfo () {
    const queue = this.getQueue()
    if (queue.length === 0) return null

    const head = queue[0]
    const runningByGpu = new Map()
    for (const t of this.getRunning()) {
      if (t.gpuIndex !== null) runningByGpu.set(t.gpuIndex, (runningByGpu.get(t.gpuIndex) ?? 0) + 1)
    }
    if (this.pickGpu(head, runningByGpu) !== null) return null

    const idleGpus = this.gpu.getDevices()
      .filter(d => (runningByGpu.get(d.index) ?? 0) < this.cfg.scheduler.maxPerGpu)
      .map(d => ({ index: d.index, availableMb: this.availableMemOn(d.index) }))

    return {
      taskId: head.id,
      taskName: head.name,
      status: head.status,
      reason: head.status === 'blocked'
        ? `等待依赖 ${head.dependsOn.map(id => '#' + id).join('、')} 完成`
        : `等待 ${head.memRequiredMb} MB 显存`,
      waitingMs: Date.now() - head.createdAt,
      queueLength: queue.length,
      idleGpus
    }
  }
}

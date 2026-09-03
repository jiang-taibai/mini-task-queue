import { EventEmitter } from 'node:events'
import { rowToTask } from './db.js'
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

/** 给人看的显存数字，和前端 formatMb 保持一致的口径 */
export function formatMb (mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

export class Scheduler extends EventEmitter {
  constructor (cfg, db, gpu, runner) {
    super()
    this.cfg = cfg
    this.db = db
    this.gpu = gpu
    this.runner = runner

    /**
     * 软预留账本：taskId -> [{ gpuIndex, memMb, expiresAt }]，每张卡一条。
     *
     * 从「进程启动」到「nvidia-smi 观测到它吃满显存」之间有一段盲区，
     * 这段时间里那块显存在读数上仍然是空闲的。没有这个账本，同一拍里
     * 两个任务会双双被派到同一张卡上，然后一起 OOM——这是纯粹的自伤，
     * 而且与外部同事无关，完全是我们自己能控制的部分。
     *
     * 必须按卡拆成独立条目、独立释放。device_map="auto" 是按分片顺序加载的，
     * 先填满 cuda:0 再溢到 cuda:1；若照旧跨卡求和判断解除，卡 0 刚吃到一半
     * 就会把整条预留（含卡 1 那份）一起删掉，此刻卡 1 读数还是空的，
     * 下一个任务立刻被派上去，等权重压过来两个一起 OOM。
     */
    this.reservations = new Map()

    /**
     * 已经派出去、但落库还没完成的任务 id。
     *
     * launch 是异步的，这段窗口里任务在库里仍然是 pending——没有这个标记，
     * getQueue() 下一拍还会把它选出来再派一次，而 pruneReservations() 会因为
     * 它「不是 running」把预留删掉。两个后果都指向同一种事故：同一个任务的
     * 两个进程抢同一个 attemptNo，或者卡上的显存没人记账。
     *
     * 只在本进程内有效，靠 launchTask 里的条件更新兜住跨进程的情况。
     */
    this.launching = new Set()

    /** 进程已消失但退出码文件还没落盘的任务：taskId -> 首次发现消失的时刻 */
    this.awaitingExitCode = new Map()

    /** taskId -> 最后一次在 GPU 上看到该任务进程的时刻，用于给预留续期 */
    this.lastSeenAlive = new Map()

    /** 已告警过的任务，避免每秒刷屏 */
    this.partialUseWarned = new Set()      // taskId
    this.overrunWarned = new Map()         // taskId -> Set<gpuIndex>

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

      // 一次采集，两处使用：峰值采集与预留解除看的是同一份观测数据
      const usageByPgid = this.buildUsageByPgid()
      this.noteLiveness(usageByPgid)
      this.collectPeakMemory(usageByPgid)
      this.pruneReservations(usageByPgid)
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

      if (this.runner.isAlive(task)) {
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
    this.forgetTaskState(task.id)
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
      // 没抢过别人：启动后很快就因显存不足倒下。
      // 用 retryCount 而不是 attemptCount：后者跨轮累加，手动重排过的任务
      // 一进来就超预算，等于再也不会自动重试
      if (task.retryCount < this.cfg.scheduler.maxRetries) {
        this.requeueTask(task, `第 ${task.retryCount} 次抢卡失败（显存不足），已重新排队`)
        return
      }
      status = 'failed'
      attemptOutcome = 'failed'
      failReason = `连续 ${task.retryCount} 次因显存不足失败，请检查显存声明是否偏小`
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

  /** 任务离开 running 时清掉所有按 taskId 挂着的内存态，避免重排队后沿用上一轮的告警去重 */
  forgetTaskState (taskId) {
    this.reservations.delete(taskId)
    this.lastSeenAlive.delete(taskId)
    this.partialUseWarned.delete(taskId)
    this.overrunWarned.delete(taskId)
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
      // queued_at 重置：它重新开始排队了，等待时长不该沿用上一轮
      this.db.prepare(`
        UPDATE tasks
        SET status = 'pending', pid = NULL, pgid = NULL, proc_starttime = NULL,
            gpu_index = NULL, gpu_indices = NULL, started_at = NULL, queued_at = ?, fail_reason = ?
        WHERE id = ?
      `).run(now, reason, task.id)

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

  /**
   * 把 nvidia-smi 的进程列表归拢成 pgid -> Map<gpuIndex, 占用 MB>。
   *
   * 归拢靠进程组：nvidia-smi 报的是真正跑 CUDA 的 python 进程，而我们启动的是
   * bash wrapper，两者 PID 不同。detached 让整棵进程树共享同一个 pgid。
   *
   * 拿不到卡号的进程（uuid 不在映射表里）直接丢弃——多卡下所有判断都是按卡做的，
   * 一份无法归属到具体卡的占用无处安放，计进总量反而会污染逐卡比对。
   */
  buildUsageByPgid () {
    const byPgid = new Map()
    for (const p of this.gpu.getProcesses()) {
      if (p.gpuIndex === null) continue
      const pgid = this.runner.pgidOf(p.pid)
      if (pgid === null) continue

      let perGpu = byPgid.get(pgid)
      if (!perGpu) {
        perGpu = new Map()
        byPgid.set(pgid, perGpu)
      }
      perGpu.set(p.gpuIndex, (perGpu.get(p.gpuIndex) ?? 0) + p.usedMemoryMb)
    }
    return byPgid
  }

  /** 记下「这一刻还看得见该任务的进程」，预留续期靠它 */
  noteLiveness (usageByPgid) {
    if (usageByPgid.size === 0) return
    const now = Date.now()
    for (const task of this.getRunning()) {
      if (task.pgid && usageByPgid.has(task.pgid)) this.lastSeenAlive.set(task.id, now)
    }
  }

  pruneReservations (usageByPgid) {
    const now = Date.now()
    const warmupMs = this.cfg.scheduler.warmupSeconds * 1000

    for (const [taskId, entries] of this.reservations) {
      const task = this.getTask(taskId)
      // launching 的任务在库里还是 pending，但预留必须留着：进程已经在起了，
      // 此刻删掉预留等于把那份显存重新当成空闲派给别人
      if (!task || (task.status !== 'running' && !this.launching.has(taskId))) {
        this.reservations.delete(taskId)
        continue
      }

      const perGpu = task.pgid ? usageByPgid.get(task.pgid) : undefined
      const aliveAt = this.lastSeenAlive.get(taskId) ?? null

      const kept = entries.filter(res => {
        // 提前解除：这张卡上已经能看到该任务吃掉声明的一半，说明显存读数
        // 已反映它，账本再挂着就是重复扣减，白白让卡闲置
        const observed = perGpu?.get(res.gpuIndex) ?? 0
        if (observed >= res.memMb * 0.5) return false

        // 还看得见这个任务的其它进程，就认为它仍在往后面的卡上铺，给未被
        // 观测到的卡续期——大模型加载几分钟很常见，固定 60 秒会让最后一张卡
        // 在还空着的时候就失去保护。
        //
        // 硬到期必须保留作兜底：processesAvailable 为 false 时（WSL2 拿不到
        // 进程列表）观测永远不会发生，没有兜底那张卡就废到任务结束。
        const deadline = aliveAt === null
          ? res.expiresAt
          : Math.max(res.expiresAt, aliveAt + warmupMs)
        return now <= deadline
      })

      if (kept.length === 0) this.reservations.delete(taskId)
      else if (kept.length !== entries.length) this.reservations.set(taskId, kept)
    }
  }

  reservedOn (gpuIndex) {
    let total = 0
    for (const entries of this.reservations.values()) {
      for (const res of entries) {
        if (res.gpuIndex === gpuIndex) total += res.memMb
      }
    }
    return total
  }

  availableMemOn (gpuIndex) {
    const device = this.gpu.getDevices().find(d => d.index === gpuIndex)
    if (!device) return 0
    return device.memFreeMb - this.reservedOn(gpuIndex)
  }

  /** 每张卡上正在跑几个任务——多卡任务在它占的每张卡上各计一次 */
  countRunningByGpu () {
    const byGpu = new Map()
    for (const t of this.getRunning()) {
      for (const idx of t.gpuIndices) byGpu.set(idx, (byGpu.get(idx) ?? 0) + 1)
    }
    return byGpu
  }

  /**
   * 正在跑的纯 CPU 任务数。
   *
   * 判据用 gpuMems 而不是 gpuIndices：后者在任务落库前是空的，会把一个正在启动的
   * GPU 任务误算成 CPU 任务。gpuMems 是提交时就定死的声明，不受生命周期影响。
   */
  countRunningCpuTasks () {
    return this.getRunning().filter(t => t.gpuMems.length === 0).length
  }

  // —— 派发 ——

  /**
   * 为任务挑一组卡，返回槽位序的物理卡号数组；排不上返回 null。
   *
   * 匹配是位置无关的：需求降序、候选卡余量降序，逐对配对。这个贪心对
   * 「存不存在可行解」是最优的——若最大需求配不上最大余量，换任何配法都配不上。
   *
   * 配完再还原回槽位序，因为 CUDA_VISIBLE_DEVICES 的顺序就是脚本里 cuda:i 的顺序，
   * 槽位 i 的卡必须满足 gpuMems[i] 的声明。
   */
  pickGpus (task, runningByGpu) {
    const pool = this.gpu.getDevices()
      .filter(d => !task.allowedGpus || task.allowedGpus.includes(d.index))
      .filter(d => (runningByGpu.get(d.index) ?? 0) < this.cfg.scheduler.maxPerGpu)
      .map(d => ({ index: d.index, available: this.availableMemOn(d.index) }))
      // 余量最大的优先，给后续任务留下更完整的空间
      .sort((a, b) => b.available - a.available || a.index - b.index)

    if (pool.length < task.gpuMems.length) return null

    // 需求大的先挑，否则小需求会先占走大卡，把大需求逼到排不上
    const slots = task.gpuMems
      .map((memMb, slot) => ({ slot, memMb }))
      .sort((a, b) => b.memMb - a.memMb || a.slot - b.slot)

    const assigned = new Array(task.gpuMems.length)
    for (let i = 0; i < slots.length; i++) {
      if (pool[i].available < slots[i].memMb) return null
      assigned[slots[i].slot] = pool[i].index
    }

    // 各槽位需求相同时顺序无所谓，按卡号升序让日志和 UI 少让人愣一下
    if (task.gpuMems.every(m => m === task.gpuMems[0])) assigned.sort((a, b) => a - b)

    return assigned
  }

  dispatch () {
    const runningByGpu = this.countRunningByGpu()
    let cpuRunning = this.countRunningCpuTasks()

    for (const task of this.getQueue()) {
      // 严格门控：队头排不上，后面的一律等待。
      // 你手动排的顺序是硬承诺，系统不会自作主张让小任务插队。
      //
      // 多卡任务在队头时这条规则会让卡空转（等第二张卡时第一张闲着），但它同时
      // 保证了不会饿死：后面的任务也不启动，卡就会一张张空出来并保持空着。
      // 想让小任务先跑，把它拖到队头就是——那才是这套系统里的「回填」。
      if (task.status === 'blocked') break

      // 已经派出去、只是还没落库。它在库里仍是 pending，再派一次就是两个进程
      // 抢同一个 attemptNo。等一拍即可——落库后它就变 running 了
      if (this.launching.has(task.id)) break

      // 纯 CPU 任务不占显存，maxPerGpu 那道闸门对它不起作用。没有独立上限的话，
      // 队列里十几个预处理任务会被一拍接一拍全部派出去，把机器压垮——
      // 而那台机器上还有同事在用
      if (task.gpuMems.length === 0) {
        if (cpuRunning >= this.cfg.scheduler.maxCpuTasks) break
        try {
          if (this.launchTask(task, [])) cpuRunning++
        } catch (err) {
          this.failLaunch(task, err)
        }
        break
      }

      const gpuIndices = this.pickGpus(task, runningByGpu)
      if (gpuIndices === null) break

      try {
        if (this.launchTask(task, gpuIndices)) {
          for (const idx of gpuIndices) runningByGpu.set(idx, (runningByGpu.get(idx) ?? 0) + 1)
        }
      } catch (err) {
        this.failLaunch(task, err)
      }
      break // 一拍只派一个：给账本和监控留出反应时间，避免瞬间超派
    }
  }

  /** launch 同步抛出时的收尾。标记漏清一次，这个任务就再也不会被派发，而且不会有任何报错 */
  failLaunch (task, err) {
    this.launching.delete(task.id)
    console.error(`[scheduler] 启动任务 #${task.id} 失败:`, err)
    this.db.prepare(`
      UPDATE tasks SET status = 'failed', finished_at = ?, fail_reason = ? WHERE id = ?
    `).run(Date.now(), `启动失败：${err.message}`, task.id)
    this.emitChange(task.id)
  }

  /**
   * 派发一个任务；抢不到这一拍返回 false。
   *
   * 编号必须在这里同步占掉，不能等 launch 回来再写。launch 是异步的，在它落库
   * 之前任务在库里还是 pending，而 getQueue() 选的就是 pending、countRunningByGpu()
   * 只数 running——没有任何东西表示「这个任务正在启动中」。于是下一拍会把同一个
   * 任务再派一次，两次拿到同一个 attemptNo：两个进程写进同一个 attempt-<n>.log，
   * 后落库的那次撞唯一索引，被标成「启动失败：UNIQUE constraint failed」，
   * 而它 spawn 出来的进程还在卡上吃着显存。
   *
   * 条件更新即乐观锁：attempt_count 没被别人动过才算抢到。SQLite 同一时刻只有
   * 一个写者，所以这条规则对「不小心起了两个服务实例连同一个库」同样成立。
   */
  launchTask (task, gpuIndices) {
    const claimed = this.db.prepare(`
      UPDATE tasks SET attempt_count = attempt_count + 1
      WHERE id = ? AND attempt_count = ? AND status = 'pending'
    `).run(task.id, task.attemptCount)
    if (claimed.changes === 0) return false
    this.launching.add(task.id)

    // 编号单调递增，跨轮不复位：它决定写哪个 attempt-<n>.log
    const attemptNo = task.attemptCount + 1
    const retryCount = task.retryCount + 1
    const now = Date.now()
    const expiresAt = now + this.cfg.scheduler.warmupSeconds * 1000
    const indicesJson = JSON.stringify(gpuIndices)
    // 纯 CPU 任务没有槽位 0。显式转成 null——undefined 绑不进 SQLite
    const slotZero = gpuIndices[0] ?? null

    // launch 是异步的，但派发必须同步完成账本记账，否则同一拍的后续决策会看到旧数据。
    // 这里先占坑，再实际启动。每张卡一条，各自独立解除。
    this.reservations.set(task.id, gpuIndices.map((gpuIndex, slot) => ({
      gpuIndex,
      memMb: task.gpuMems[slot],
      expiresAt
    })))

    this.runner.launch(task, gpuIndices, attemptNo).then(proc => {
      const { pid, pgid, procStarttime, logPath } = proc
      this.db.exec('BEGIN')
      try {
        // attempt_count 已在上面占号时推进过，这里不再写：它的唯一推进点就是那一条
        // 条件更新，多一处写入就多一条绕过乐观锁的路
        //
        // gpu_index 写槽位 0，仅为让回退到旧版本的服务仍能启动，不参与新逻辑
        this.db.prepare(`
          UPDATE tasks
          SET status = 'running', gpu_index = ?, gpu_indices = ?, pid = ?, pgid = ?, proc_starttime = ?,
              started_at = ?, retry_count = ?,
              finished_at = NULL, exit_code = NULL, fail_reason = NULL
          WHERE id = ?
        `).run(slotZero, indicesJson, pid, pgid, procStarttime, now, retryCount, task.id)

        this.db.prepare(`
          INSERT INTO attempts (task_id, attempt_no, gpu_index, gpu_indices, pid, pgid, started_at, log_path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(task.id, attemptNo, slotZero, indicesJson, pid, pgid, now, logPath)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        this.killOrphan(task, proc, gpuIndices)
        throw err
      }

      this.launching.delete(task.id)
      this.gpu.mock?.noteTaskStart(pgid, gpuIndices, task.gpuMems)
      const target = gpuIndices.length ? `已派往 GPU ${gpuIndices.join('、')}` : '已启动（纯 CPU，不占卡）'
      this.emit('log', `任务 #${task.id}「${task.name}」${target}（第 ${attemptNo} 次尝试）`)
      this.emitChange(task.id)
    }).catch(err => {
      this.launching.delete(task.id)
      this.reservations.delete(task.id)
      console.error(`[scheduler] 任务 #${task.id} 启动失败:`, err)
      this.db.prepare(`
        UPDATE tasks SET status = 'failed', finished_at = ?, fail_reason = ? WHERE id = ?
      `).run(Date.now(), `启动失败：${err.message}`, task.id)
      this.emitChange(task.id)
    })

    return true
  }

  /**
   * 记账失败但进程已经 spawn 出去了——杀掉它。
   *
   * 事务回滚只撤销了库里的行，进程不会跟着消失。任务随后被标成 failed，于是
   * getRunning() 再也看不见它，而它仍在卡上吃着显存：那张卡会被继续派任务，
   * 症状是毫无来由的 OOM。宁可让这次尝试彻底失败，也不留一份账本之外的占用。
   *
   * 杀不掉只记日志：此刻已经在异常路径上，再抛一次只会盖掉真正的原因。
   */
  killOrphan (task, { pid, pgid, procStarttime }, gpuIndices) {
    try {
      this.runner.stopTask({ pid, pgid, procStarttime })
      this.runner.forget(task.id)
      this.emit('log', `⚠ 任务 #${task.id}「${task.name}」记账失败，已终止刚启动的进程（pid ${pid}）`)
    } catch (err) {
      console.error(
        `[scheduler] 任务 #${task.id} 记账失败后未能终止进程 ${pid}，` +
        `它仍占着 GPU ${gpuIndices.join('、')} 且不在账本内，请手动清理:`, err.message)
    }
  }

  // —— 显存峰值采集 ——

  /**
   * 记录任务实际用到的显存峰值，克隆时用它预填需求。
   *
   * 匹配靠进程组：nvidia-smi 报的是真正跑 CUDA 的 python 进程，
   * 而我们启动的是 bash wrapper，两者 PID 不同。detached 让整棵进程树
   * 共享同一个 pgid，于是 pgid 成了任务的天然标识。
   */
  collectPeakMemory (usageByPgid) {
    if (usageByPgid.size === 0) return

    for (const task of this.getRunning()) {
      const perGpu = task.pgid ? usageByPgid.get(task.pgid) : undefined
      if (perGpu === undefined) continue

      this.updatePeak(task, perGpu)
      this.checkGpuDrift(task, perGpu)
    }
  }

  /**
   * 每个槽位在时间轴上各自取最大值。
   *
   * 不是「总和最大那一刻的分解」——两张卡的峰值时刻可能不同，逐槽独立取最大
   * 会偏保守。显存声明宁可保守：克隆时预填偏大只是多排一会儿队，偏小则是 OOM。
   *
   * 只认跑在已分配卡上的占用。任务漂移到别的卡时槽位映射本身就不成立了，
   * 那种情况交给 checkGpuDrift 告警，不该污染峰值数据。
   */
  updatePeak (task, perGpu) {
    if (task.gpuIndices.length === 0) return

    const previous = task.peakMemPerGpu ?? []
    const next = task.gpuIndices.map((gpuIndex, slot) =>
      Math.max(previous[slot] ?? 0, perGpu.get(gpuIndex) ?? 0))

    if (next.every((v, i) => v === (previous[i] ?? 0))) return

    const total = next.reduce((sum, v) => sum + v, 0)
    const json = JSON.stringify(next)
    this.db.prepare('UPDATE tasks SET peak_mem_per_gpu = ?, peak_mem_mb = ? WHERE id = ?')
      .run(json, total, task.id)
    this.db.prepare(`
      UPDATE attempts SET peak_mem_per_gpu = ?, peak_mem_mb = ?
      WHERE task_id = ? AND attempt_no = ?
    `).run(json, total, task.id, task.attemptCount)
  }

  /**
   * 检测任务是否跑在了调度器分配之外的卡上。
   *
   * 分流靠 CUDA_VISIBLE_DEVICES，但这个变量可能被绕过——最常见的是项目里的
   * .env 用覆盖方式加载（`load_dotenv(override=True)`、`source .env`、direnv），
   * 或者代码里硬编码了 cuda:1 / torch.cuda.set_device()。
   *
   * 这类错位两边都不报错：任务在别的卡上跑，账本却按分配的卡记账，
   * 于是那张卡会被超派，症状是毫无来由的 OOM。这里直接拿 nvidia-smi
   * 观测到的实际卡号对账，不管被绕过的原因是什么都能抓到。
   *
   * 观测集合与分配集合的关系分三种，后果完全不同，措辞也必须不同：
   *   - 有分配集合之外的卡 -> 真漂移，那张卡的账本失效
   *   - 是分配集合的真子集 -> 声明多了，卡被预留着闲置（走 notePartialUse）
   *   - 相等                -> 正常
   */
  checkGpuDrift (task, perGpu) {
    const actual = [...perGpu.keys()].sort((a, b) => a - b)
    if (actual.length === 0) return

    const assigned = new Set(task.gpuIndices)
    const previous = task.actualGpus
    // 只在首次发现或结果变化时写库和告警，避免每秒重复刷屏
    const changed = !previous || previous.length !== actual.length ||
      !previous.every((g, i) => g === actual[i])

    if (changed) {
      this.db.prepare('UPDATE tasks SET actual_gpus = ? WHERE id = ?')
        .run(JSON.stringify(actual), task.id)

      const strays = actual.filter(g => !assigned.has(g))
      if (strays.length > 0) {
        const message =
          `任务 #${task.id}「${task.name}」被分配到 GPU ${task.gpuIndices.join('、')}，` +
          `但实际运行在 GPU ${actual.join('、')} 上。` +
          `分流已被绕过——请检查工作目录下的 .env 是否设置了 CUDA_VISIBLE_DEVICES，` +
          `或代码里是否硬编码了卡号。显存账本对 GPU ${strays.join('、')} 的记账已不可信。`
        this.emit('log', `⚠ ${message}`)
        // 同时落服务端日志：你未必开着浏览器，而这个问题会一直污染账本
        console.warn('[scheduler] 分流漂移:', message)
      }
      this.emitChange(task.id)
    }

    if (actual.length < assigned.size && actual.every(g => assigned.has(g))) {
      this.notePartialUse(task, actual)
    }

    this.checkOverrun(task, perGpu)
  }

  /**
   * 声明了 N 张卡却只用了其中几张：剩下的卡被预留着白白闲置。
   *
   * 这不是漂移，最常见的原因是 device_map="auto" 发现模型塞得下就没用第二张卡。
   * 给足预热余量再提示，否则顺序加载途中每个任务都会先触发一次。
   */
  notePartialUse (task, actual) {
    if (this.partialUseWarned.has(task.id)) return
    const graceMs = this.cfg.scheduler.warmupSeconds * 2000
    if (!task.startedAt || Date.now() - task.startedAt < graceMs) return

    this.partialUseWarned.add(task.id)
    const idle = task.gpuIndices.filter(g => !actual.includes(g))
    const message =
      `任务 #${task.id}「${task.name}」声明了 ${task.gpuIndices.length} 张卡，` +
      `但启动 ${Math.round(graceMs / 1000)} 秒后仍只在 GPU ${actual.join('、')} 上观测到占用。` +
      `GPU ${idle.join('、')} 被预留着但闲置，建议改成 ${actual.length} 卡任务。`
    this.emit('log', `⚠ ${message}`)
    console.warn('[scheduler] 声明多卡但未用满:', message)
  }

  /**
   * 按卡比对实测占用与该槽位的声明值。
   *
   * 集合判定抓不到多卡下最危险的一种绕过：.env 把 CUDA_VISIBLE_DEVICES 覆盖成 "0"
   * 时，两个槽位的显存全压在 GPU 0 上——用的卡确实在分配集合里，看上去只是
   * 「声明多了」这种良性情况，实际那张卡被吃掉了双倍而账本只记了单份，
   * 下一个派上去的任务必 OOM。只有按卡比对数值才看得见。
   *
   * 顺带也能抓到纯粹的「显存声明偏小」——那种现在只能等 OOM 才暴露。
   */
  checkOverrun (task, perGpu) {
    const ratio = this.cfg.scheduler.overrunRatio
    let warned = this.overrunWarned.get(task.id)

    task.gpuIndices.forEach((gpuIndex, slot) => {
      const declared = task.gpuMems[slot]
      const observed = perGpu.get(gpuIndex) ?? 0
      if (!declared || observed <= declared * ratio) return
      if (warned?.has(gpuIndex)) return

      if (!warned) {
        warned = new Set()
        this.overrunWarned.set(task.id, warned)
      }
      warned.add(gpuIndex)

      const message =
        `任务 #${task.id}「${task.name}」在 GPU ${gpuIndex} 上声明 ${declared} MB，` +
        `实测占用 ${observed} MB。这张卡的显存账本已不可信——请检查工作目录下的 .env ` +
        `是否把 CUDA_VISIBLE_DEVICES 覆盖成了单张卡，或显存声明是否偏小。`
      this.emit('log', `⚠ ${message}`)
      console.warn('[scheduler] 显存超额:', message)
    })
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
      if (this.runner.isAlive(task)) {
        alive++
        // 若仍在预热期内，把预留补回账本——每张分配卡各一条
        const warmupMs = this.cfg.scheduler.warmupSeconds * 1000
        if (task.startedAt && now - task.startedAt < warmupMs && task.gpuIndices.length > 0) {
          this.reservations.set(task.id, task.gpuIndices.map((gpuIndex, slot) => ({
            gpuIndex,
            memMb: task.gpuMems[slot],
            expiresAt: task.startedAt + warmupMs
          })))
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

  /**
   * 给 GPU 进程列表标注归属：哪些是我们派出去的任务，哪些是别人的。
   *
   * 满载环境下这个信息很实用——一眼能看出正在跟谁抢卡，是同事的进程
   * 还是自己某个忘了停的任务。匹配仍然走进程组：nvidia-smi 报的是
   * python 进程，而我们记录的是 bash wrapper。
   */
  annotateState (gpuState) {
    const byPgid = new Map()
    for (const t of this.getRunning()) {
      if (t.pgid) byPgid.set(t.pgid, t)
    }

    return {
      ...gpuState,
      processes: gpuState.processes.map(p => {
        const pgid = this.runner.pgidOf(p.pid)
        const task = pgid === null ? null : byPgid.get(pgid)
        return { ...p, taskId: task?.id ?? null, taskName: task?.name ?? null }
      }),
      reserved: Object.fromEntries(
        gpuState.devices.map(d => [d.index, this.reservedOn(d.index)])
      )
    }
  }

  /** 队列被谁挡住了——UI 顶部的阻塞提示条用它 */
  getBlockingInfo () {
    const queue = this.getQueue()
    if (queue.length === 0) return null

    const head = queue[0]
    const runningByGpu = this.countRunningByGpu()

    // 纯 CPU 队头单独判定：pickGpus 对它永远返回 []（不是 null），
    // 走下面那条会被当成「排得上」，于是被 CPU 闸门挡住时界面上什么都不显示
    if (head.status !== 'blocked' && head.gpuMems.length === 0) {
      const limit = this.cfg.scheduler.maxCpuTasks
      if (this.countRunningCpuTasks() < limit) return null
      return {
        taskId: head.id,
        taskName: head.name,
        status: head.status,
        reason: `已有 ${limit} 个纯 CPU 任务在跑，达到并发上限（scheduler.maxCpuTasks）`,
        waitingMs: Date.now() - head.queuedAt,
        queueLength: queue.length,
        idleGpus: []
      }
    }

    if (this.pickGpus(head, runningByGpu) !== null) return null

    const idleGpus = this.gpu.getDevices()
      .filter(d => (runningByGpu.get(d.index) ?? 0) < this.cfg.scheduler.maxPerGpu)
      .map(d => ({ index: d.index, availableMb: this.availableMemOn(d.index) }))

    return {
      taskId: head.id,
      taskName: head.name,
      status: head.status,
      reason: head.status === 'blocked'
        ? `等待依赖 ${head.dependsOn.map(id => '#' + id).join('、')} 完成`
        : this.describeMemoryWait(head),
      waitingMs: Date.now() - head.queuedAt,
      queueLength: queue.length,
      idleGpus
    }
  }

  /**
   * 队头因显存排不上时说清楚在等什么。
   *
   * 多卡任务干等时「还差几张卡、正在等谁结束」比「等待 40960 MB 显存」有用得多——
   * 前者你能据此决定要不要把某个小任务拖到队头，后者只能干瞪眼。
   */
  describeMemoryWait (head) {
    const need = head.gpuMems
    const devices = this.gpu.getDevices()
      .filter(d => !head.allowedGpus || head.allowedGpus.includes(d.index))
    const smallest = Math.min(...need)
    const usable = devices.filter(d => this.availableMemOn(d.index) >= smallest)

    const demand = need.length === 1
      ? `等待 ${formatMb(need[0])} 显存`
      : `需要 ${need.length} 张卡（${need.map(formatMb).join(' + ')}），当前 ${usable.length} 张可用`

    const usableSet = new Set(usable.map(d => d.index))
    const inScope = new Set(devices.map(d => d.index))
    const blockers = new Set()
    for (const t of this.getRunning()) {
      for (const idx of t.gpuIndices) {
        if (inScope.has(idx) && !usableSet.has(idx)) {
          blockers.add(`GPU ${idx} 上的 #${t.id}「${t.name}」`)
        }
      }
    }

    if (blockers.size === 0) return demand
    return `${demand}；正在等待 ${[...blockers].join('、')} 结束`
  }
}

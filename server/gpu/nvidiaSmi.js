import { spawn, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 从 nvidia-smi 的一个字段里取数值。
 *
 * 不直接用 Number()：部分驱动版本对 `--query-compute-apps` 的 used_memory
 * 不认 `nounits`，仍然输出 "16870 MiB"，Number() 会得到 NaN，
 * 于是显存峰值采集和预留的提前解除会静默失效——不报错，只是永远算不出数。
 * 不支持的字段则返回 "[N/A]"，这里一并归为 NaN 由调用方处理。
 */
function parseNumeric (value) {
  const match = String(value).match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : NaN
}

/**
 * 真实 GPU 数据源。
 *
 * 两条通道，刻意用了不同的机制：
 *
 * 1. 显存/利用率：常驻一个 `nvidia-smi -l 1` 进程读 stdout。
 *    绝不能每秒 spawn 一次——GPU 满载时 nvidia-smi 会被驱动阻塞数秒，
 *    定时 spawn 会导致进程堆积，反过来把驱动拖得更慢，最终雪崩。
 *
 * 2. 进程列表：独立的低频定时单次查询。
 *    因为 compute-apps 每轮输出行数随进程数变化，`-l` 模式下无法切分轮次边界。
 *    它不参与调度决策（只用于展示和显存峰值采集），低频完全够用。
 */
export class NvidiaSmiSource extends EventEmitter {
  constructor (cfg) {
    super()
    this.cfg = cfg
    this.proc = null
    this.appsTimer = null
    this.stopped = false
    this.restartDelay = 1000

    this.staticInfo = []      // [{ index, uuid, name, memTotalMb }]
    this.uuidToIndex = new Map()
    this.buffer = ''
    this.pending = []         // 当前轮次已解析的行
    this.processes = []
    this.lastDevices = []

    // 先乐观假定可用。判定推迟到 apps 首次轮询完成之后——
    // 两条通道是并发启动的，显存流通常先返回，此时进程列表还是空的，
    // 若在那一刻就下结论，任何卡上有占用的机器都会被误判成"进程列表不可用"
    this.processesAvailable = true
    this.appsPolledOnce = false
    this.appsQueryOk = null   // null=未轮询, true=查询成功, false=查询失败
  }

  async start () {
    await this.loadStaticInfo()
    this.startStream()
    this.startAppsPolling()
  }

  /** 静态信息只查一次：卡数决定了流式输出的分组边界，uuid 用于把进程映射回卡号 */
  async loadStaticInfo () {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,uuid,name,memory.total',
      '--format=csv,noheader,nounits'
    ])
    this.staticInfo = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [index, uuid, name, memTotal] = line.split(',').map(s => s.trim())
      return { index: parseNumeric(index), uuid, name, memTotalMb: parseNumeric(memTotal) }
    })
    if (this.staticInfo.length === 0) throw new Error('nvidia-smi 未返回任何 GPU')
    for (const d of this.staticInfo) this.uuidToIndex.set(d.uuid, d.index)
  }

  startStream () {
    if (this.stopped) return

    const interval = Math.max(1, Math.round(this.cfg.gpu.pollIntervalMs / 1000))
    // 只查数值字段：名字里若含逗号会破坏 CSV 解析，静态信息里已经有名字了
    this.proc = spawn('nvidia-smi', [
      '--query-gpu=index,memory.total,memory.used,memory.free,utilization.gpu',
      '--format=csv,noheader,nounits',
      '-l', String(interval)
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', chunk => this.onChunk(chunk))
    this.proc.stderr.on('data', d => {
      this.emit('warn', `nvidia-smi stderr: ${String(d).trim()}`)
    })

    const onDead = (info) => {
      if (this.stopped) return
      this.proc = null
      this.emit('warn', `nvidia-smi 流已退出（${info}），${this.restartDelay}ms 后重启`)
      setTimeout(() => this.startStream(), this.restartDelay)
      // 指数退避，避免驱动异常时疯狂重启
      this.restartDelay = Math.min(this.restartDelay * 2, 30000)
    }
    this.proc.on('exit', code => onDead(`exit ${code}`))
    this.proc.on('error', err => onDead(err.message))
  }

  onChunk (chunk) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue

      const parts = line.split(',').map(s => s.trim())
      if (parts.length < 5) continue

      const [index, memTotal, memUsed, memFree, util] = parts.map(parseNumeric)
      if (Number.isNaN(index)) continue

      this.pending.push({
        index,
        name: this.staticInfo.find(d => d.index === index)?.name ?? `GPU ${index}`,
        memTotalMb: memTotal,
        memUsedMb: memUsed,
        memFreeMb: memFree,
        utilization: Number.isNaN(util) ? null : util
      })

      // 卡数固定，攒够一轮就发布
      if (this.pending.length >= this.staticInfo.length) {
        const devices = this.pending.sort((a, b) => a.index - b.index)
        this.pending = []
        this.lastDevices = devices
        this.restartDelay = 1000 // 成功收到数据，重置退避
        this.emit('update', {
          timestamp: Date.now(),
          devices,
          processes: this.processes,
          processesAvailable: this.processesAvailable
        })
      }
    }
  }

  startAppsPolling () {
    const poll = async () => {
      if (this.stopped) return
      try {
        const { stdout } = await execFileAsync('nvidia-smi', [
          '--query-compute-apps=gpu_uuid,pid,used_memory',
          '--format=csv,noheader,nounits'
        ], { timeout: 10000 })

        const lines = stdout.trim().split('\n').filter(Boolean)
        this.processes = lines.map(line => {
          const [uuid, pid, mem] = line.split(',').map(s => s.trim())
          return {
            gpuIndex: this.uuidToIndex.get(uuid) ?? null,
            pid: parseNumeric(pid),
            usedMemoryMb: parseNumeric(mem)
          }
        }).filter(p => !Number.isNaN(p.pid) && !Number.isNaN(p.usedMemoryMb))
        this.appsQueryOk = true
      } catch {
        this.processes = []
        this.appsQueryOk = false
      }
      this.appsPolledOnce = true
      this.evaluateProcessAvailability()
      this.appsTimer = setTimeout(poll, this.cfg.gpu.appsIntervalMs)
    }
    poll()
  }

  /**
   * 判断进程列表是否真的取不到。
   *
   * 在 apps 轮询结束后评估，而不是在显存数据到达时——两条通道并发启动，
   * 显存流通常先返回，那时进程列表必然还是空的。
   *
   * 判定必须可逆：曾经因为一次超时降级，不该让后续所有成功查询都失效。
   */
  evaluateProcessAvailability () {
    if (!this.appsPolledOnce) return

    // 查询本身失败（命令不支持、驱动繁忙超时）——确实拿不到
    if (this.appsQueryOk === false) {
      this.setProcessesAvailable(false, 'nvidia-smi 进程查询失败，暂时只能显示显存')
      return
    }

    // 能列出进程，一切正常
    if (this.processes.length > 0) {
      this.setProcessesAvailable(true)
      return
    }

    // 查询成功但为空：可能真的没进程，也可能是环境限制（WSL2 的 GPU
    // 半虚拟化不暴露进程列表，表现就是永远返回空）。只有当卡上明显有
    // 显存被占用时，才能断定是后者——否则空卡会被误判。
    const someoneUsingMemory = this.lastDevices.some(d => d.memUsedMb > 500)
    if (someoneUsingMemory) {
      this.setProcessesAvailable(false, 'GPU 进程列表不可用（WSL2 等环境的已知限制），已降级为仅显示显存')
    }
    // 卡是空的又查不到进程，属于正常情况，维持现状
  }

  setProcessesAvailable (available, message = null) {
    if (this.processesAvailable === available) return
    this.processesAvailable = available
    if (available) this.emit('warn', 'GPU 进程列表已恢复')
    else if (message) this.emit('warn', message)
  }

  stop () {
    this.stopped = true
    if (this.appsTimer) clearTimeout(this.appsTimer)
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
  }
}

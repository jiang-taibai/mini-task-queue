import { spawn, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
    this.processesAvailable = true
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
      return { index: Number(index), uuid, name, memTotalMb: Number(memTotal) }
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

      const [index, memTotal, memUsed, memFree, util] = parts.map(Number)
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
            pid: Number(pid),
            usedMemoryMb: Number(mem)
          }
        }).filter(p => !Number.isNaN(p.pid))
      } catch {
        this.processes = []
        this.processesAvailable = false
      }
      this.appsTimer = setTimeout(poll, this.cfg.gpu.appsIntervalMs)
    }
    poll()
  }

  /**
   * WSL2 的 GPU 半虚拟化不暴露进程列表：查询成功但永远返回空。
   * 用「卡上明显有显存被占，进程列表却是空的」来识别这种降级，
   * 避免调度器把"查不到进程"误读成"卡是干净的"。
   */
  updateProcessAvailability (devices) {
    if (!this.processesAvailable) return
    const someoneUsingMemory = devices.some(d => d.memUsedMb > 500)
    if (someoneUsingMemory && this.processes.length === 0) {
      this.processesAvailable = false
      this.emit('warn', 'GPU 进程列表不可用（WSL2 等环境的已知限制），已降级为仅显示显存')
    }
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

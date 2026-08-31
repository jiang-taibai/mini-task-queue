import { EventEmitter } from 'node:events'
import { NvidiaSmiSource } from './nvidiaSmi.js'
import { MockSource } from './mock.js'

/**
 * GPU 监控门面：包住数据源，对外提供快照 + 新鲜度闸门。
 *
 * 闸门是这里最重要的东西：宁可一张卡都不派，也绝不拿过期数据做调度决策。
 * 满载环境下 5 秒前的显存读数已经是废纸。
 */
export class GpuMonitor extends EventEmitter {
  constructor (cfg) {
    super()
    this.cfg = cfg
    this.snapshot = null
    this.lastUpdate = 0
    this.warnings = []

    this.source = cfg.gpu.source === 'mock'
      ? new MockSource(cfg)
      : new NvidiaSmiSource(cfg)

    this.source.on('update', snap => {
      this.snapshot = snap
      this.lastUpdate = Date.now()
      this.emit('update', snap)
    })

    this.source.on('warn', msg => {
      const entry = { at: Date.now(), message: msg }
      this.warnings.unshift(entry)
      this.warnings = this.warnings.slice(0, 20)
      console.warn('[gpu]', msg)
      this.emit('warn', entry)
    })
  }

  async start () {
    await this.source.start()
  }

  /** 数据是否已过期。调度器每一拍都必须先问这个问题。 */
  isStale () {
    if (!this.snapshot) return true
    return Date.now() - this.lastUpdate > this.cfg.gpu.staleTimeoutMs
  }

  getDevices () {
    return this.snapshot?.devices ?? []
  }

  /** 卡数。首帧数据到达前退回数据源的静态信息，避免启动日志显示为未知 */
  getDeviceCount () {
    return this.snapshot?.devices.length
      ?? this.source.staticInfo?.length
      ?? this.source.devices?.length
      ?? 0
  }

  getProcesses () {
    return this.snapshot?.processes ?? []
  }

  getState () {
    return {
      stale: this.isStale(),
      lastUpdate: this.lastUpdate || null,
      source: this.cfg.gpu.source,
      devices: this.getDevices(),
      processes: this.getProcesses(),
      processesAvailable: this.snapshot?.processesAvailable ?? false,
      warnings: this.warnings.slice(0, 5)
    }
  }

  /** mock 数据源才有的测试控制接口 */
  get mock () {
    return this.source instanceof MockSource ? this.source : null
  }

  stop () {
    this.source.stop()
  }
}

import { EventEmitter } from 'node:events'

/**
 * 假的 GPU 数据源。
 *
 * 存在的理由：开发机只有单卡，而系统要跑在双卡服务器上——分流、软预留账本、
 * 双卡并发这些代码路径在本地一行都跑不到。调度器是整个系统唯一有实质复杂度的
 * 部分，如果它只能在生产上调试，排查成本会远超写它的成本。
 *
 * 关键在于它会模拟「任务启动后延迟若干秒才真正吃显存」这个盲区——
 * 预热期和账本正是为这个盲区存在的，不模拟它就等于没测。
 */
export class MockSource extends EventEmitter {
  constructor (cfg) {
    super()
    this.cfg = cfg
    this.timer = null
    this.stopped = false

    const { deviceCount, memTotalMb } = cfg.gpu.mock
    this.devices = Array.from({ length: deviceCount }, (_, i) => ({
      index: i,
      name: `Mock GPU ${i}`,
      memTotalMb,
      utilization: 0
    }))

    this.externalUsage = new Map()  // gpuIndex -> 外部进程占用 MB
    this.allocations = new Map()    // pgid -> { gpuIndex, memMb, startedAt }
    this.fluctuate = false
    // 让任务故意占用相邻的卡，用来验证「分流被绕过」的检测能否抓到
    this.simulateDrift = false
  }

  async start () {
    const tick = () => {
      if (this.stopped) return
      this.emit('update', this.snapshot())
      this.timer = setTimeout(tick, this.cfg.gpu.pollIntervalMs)
    }
    tick()
  }

  snapshot () {
    const now = Date.now()
    const delay = this.cfg.gpu.mock.allocDelayMs

    const usedByUs = new Map()
    const processes = []

    for (const [pgid, a] of this.allocations) {
      // 启动后 delay 毫秒内显存还没被吃掉——这正是账本要覆盖的盲区
      if (now - a.startedAt < delay) continue
      usedByUs.set(a.gpuIndex, (usedByUs.get(a.gpuIndex) ?? 0) + a.memMb)
      processes.push({ gpuIndex: a.gpuIndex, pid: pgid, usedMemoryMb: a.memMb })
    }

    const devices = this.devices.map(d => {
      const external = this.externalUsage.get(d.index) ?? 0
      const ours = usedByUs.get(d.index) ?? 0
      const memUsedMb = Math.min(d.memTotalMb, external + ours)
      return {
        index: d.index,
        name: d.name,
        memTotalMb: d.memTotalMb,
        memUsedMb,
        memFreeMb: d.memTotalMb - memUsedMb,
        utilization: memUsedMb > 0 ? 50 + (d.index * 7) % 40 : 0
      }
    })

    if (this.fluctuate) this.stepFluctuation()

    return { timestamp: now, devices, processes, processesAvailable: true }
  }

  /** 模拟同事的任务随机占卡/放卡，用来观察抢占与重排队行为 */
  stepFluctuation () {
    for (const d of this.devices) {
      if (Math.random() < 0.02) {
        const current = this.externalUsage.get(d.index) ?? 0
        this.externalUsage.set(d.index, current > 0 ? 0 : Math.round(d.memTotalMb * (0.4 + Math.random() * 0.5)))
      }
    }
  }

  // —— 测试控制接口，经 /api/mock/* 暴露 ——

  setExternal (gpuIndex, memMb) {
    this.externalUsage.set(gpuIndex, Math.max(0, memMb))
  }

  setFluctuate (on) {
    this.fluctuate = !!on
  }

  noteTaskStart (pgid, gpuIndex, memMb) {
    // 开启 drift 时把占用记到相邻的卡上，模拟 .env 覆盖了 CUDA_VISIBLE_DEVICES 的情形
    const effective = this.simulateDrift
      ? (gpuIndex + 1) % this.devices.length
      : gpuIndex
    this.allocations.set(pgid, { gpuIndex: effective, memMb, startedAt: Date.now() })
  }

  setDrift (on) {
    this.simulateDrift = !!on
  }

  noteTaskEnd (pgid) {
    this.allocations.delete(pgid)
  }

  updateProcessAvailability () { /* mock 始终提供进程列表 */ }

  stop () {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }
}

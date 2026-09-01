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
 *
 * 多卡下还要模拟两件事，它们是本地唯一能触发新失效模式的手段：
 *
 * 1. 分卡错开的加载延迟。device_map="auto" 按分片顺序加载，先填满 cuda:0 再溢到
 *    cuda:1。若两张卡同时吃满，「跨卡求和误删整条预留」那个 bug 永远不会复现。
 *
 * 2. collapse 形变。.env 把 CUDA_VISIBLE_DEVICES 覆盖成单卡时，两个槽位的显存
 *    会全压在第一张卡上——用的卡仍在分配集合里，集合判定抓不到，只有按卡比对
 *    数值的检测能发现。
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
    // pgid -> { startedAt, slots: [{ gpuIndex, memMb, appearsAfterMs }] }
    this.allocations = new Map()
    this.fluctuate = false
    // 形变模式，用来验证「分流被绕过」的两类检测：
    //   off      —— 老老实实按分配的卡占用
    //   shift    —— 整体挪到相邻卡（跑出分配集合，集合判定该抓到）
    //   collapse —— 所有槽位塌缩到第一张卡（仍在分配集合内，只有按卡比对能抓到）
    this.driftMode = 'off'
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

    const usedByUs = new Map()
    const processes = []

    for (const [pgid, a] of this.allocations) {
      for (const slot of a.slots) {
        // 启动后这段时间里显存还没被吃掉——这正是账本要覆盖的盲区。
        // 逐槽错开，模拟按分片顺序加载。
        if (now - a.startedAt < slot.appearsAfterMs) continue
        usedByUs.set(slot.gpuIndex, (usedByUs.get(slot.gpuIndex) ?? 0) + slot.memMb)
        processes.push({ gpuIndex: slot.gpuIndex, pid: pgid, usedMemoryMb: slot.memMb })
      }
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

  noteTaskStart (pgid, gpuIndices, memPerGpu) {
    const delay = this.cfg.gpu.mock.allocDelayMs

    const slots = gpuIndices.map((gpuIndex, slot) => ({
      gpuIndex: this.effectiveGpu(gpuIndices, slot),
      memMb: memPerGpu[slot],
      // 槽位 i 的显存在 delay×(i+1) 之后才出现：第一张卡先吃满，后面的卡逐个跟上
      appearsAfterMs: delay * (slot + 1)
    }))

    this.allocations.set(pgid, { startedAt: Date.now(), slots })
  }

  /** 按当前形变模式决定某个槽位实际落在哪张卡上 */
  effectiveGpu (gpuIndices, slot) {
    if (this.driftMode === 'shift') return (gpuIndices[slot] + 1) % this.devices.length
    if (this.driftMode === 'collapse') return gpuIndices[0]
    return gpuIndices[slot]
  }

  setDrift (mode) {
    // 兼容早先的布尔开关：true 即原来的「挪到相邻卡」
    if (typeof mode === 'boolean') mode = mode ? 'shift' : 'off'
    this.driftMode = ['off', 'shift', 'collapse'].includes(mode) ? mode : 'off'
    return this.driftMode
  }

  noteTaskEnd (pgid) {
    this.allocations.delete(pgid)
  }

  stop () {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }
}

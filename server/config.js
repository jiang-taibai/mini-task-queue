import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_PATH = path.join(ROOT, 'config.json')

const DEFAULTS = {
  port: 3000,
  host: '0.0.0.0',

  // 反向代理层数。经 frp -> nginx 访问时必须为 1，否则限流会按代理 IP 计数，
  // 导致外网所有请求共用一个计数器（攻击者爆破 5 次就能把你自己锁在门外）。
  trustProxy: 1,

  // CSRF 的 Origin 白名单。内网直连与外网域名各写一条，留空表示跳过校验。
  allowedOrigins: [],

  auth: {
    salt: null,
    hash: null,
    sessionTtlHours: 24 * 7,
    maxFailures: 5,
    lockMinutes: 15
  },

  gpu: {
    source: 'nvidia-smi', // 'nvidia-smi' | 'mock'
    pollIntervalMs: 1000,
    // 超过这个时长没有新数据即判定监控失联，立刻暂停全部调度。
    // 满载环境下 5 秒前的显存读数已是废纸，照着它派任务等于闭眼开车。
    staleTimeoutMs: 5000,
    // compute-apps 不参与调度决策，因此用低频独立查询，
    // 避免 `-l` 模式下进程数不定导致无法切分轮次边界。
    appsIntervalMs: 2000,
    mock: {
      deviceCount: 2,
      memTotalMb: 24564,
      // 模拟任务启动后多久开始真正吃显存，用于验证预热期与账本
      allocDelayMs: 8000
    }
  },

  scheduler: {
    // 从启动到 nvidia-smi 能观测到显存被吃掉之间的盲区，账本在此期间挂着预留
    warmupSeconds: 60,
    maxPerGpu: 1,
    maxRetries: 3,
    // 运行时长低于此值且日志含 OOM 关键字 -> 判定为抢卡失败而非真失败
    oomWindowSeconds: 90,
    // 某张卡上实测占用超过该槽位声明值的这个倍数即告警。
    // 多卡下最隐蔽的失效是「两个槽位塌缩到同一张卡」——用的卡确实在分配集合里，
    // 集合判定抓不到，只有按卡比对数值才看得见。
    overrunRatio: 1.5,
    // 停止任务时 SIGTERM 到 SIGKILL 的宽限期
    killGraceSeconds: 10
  }
}

function deepMerge (base, override) {
  if (!override || typeof override !== 'object') return base
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

let cached = null

export function loadConfig ({ reload = false } = {}) {
  if (cached && !reload) return cached

  let fileConfig = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    } catch (err) {
      throw new Error(`config.json 解析失败：${err.message}`)
    }
  }

  const cfg = deepMerge(DEFAULTS, fileConfig)

  // 环境变量覆盖，方便本地开发切到 mock 数据源
  if (process.env.PORT) cfg.port = Number(process.env.PORT)
  if (process.env.HOST) cfg.host = process.env.HOST
  if (process.env.GPU_SOURCE) cfg.gpu.source = process.env.GPU_SOURCE

  cfg.dataDir = process.env.DATA_DIR || path.join(ROOT, 'data')
  cfg.logsDir = path.join(cfg.dataDir, 'logs')
  cfg.dbPath = path.join(cfg.dataDir, 'queue.db')

  fs.mkdirSync(cfg.logsDir, { recursive: true })

  cached = cfg
  return cfg
}

export function saveConfig (patch) {
  let current = {}
  if (fs.existsSync(CONFIG_PATH)) {
    current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  }
  const next = deepMerge(current, patch)
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  cached = null
  return next
}

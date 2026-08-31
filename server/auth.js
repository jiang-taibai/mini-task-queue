import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)

const KEY_LEN = 64
const COOKIE_NAME = 'mtq_session'

export async function hashPassword (password, salt = null) {
  const useSalt = salt ?? crypto.randomBytes(16).toString('hex')
  const derived = await scrypt(password, useSalt, KEY_LEN)
  return { salt: useSalt, hash: derived.toString('hex') }
}

export async function verifyPassword (password, salt, expectedHash) {
  if (!salt || !expectedHash) return false
  const { hash } = await hashPassword(password, salt)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * 会话存内存即可：单用户单进程，重启登出完全可接受（本来就是手动重启）。
 *
 * 用 Cookie 而不是 JWT 有一条硬约束：EventSource 不支持自定义请求头。
 * 走 JWT + Authorization 的话，SSE 那条路就认证不了，只能把 token 塞进
 * query string——那会进 access log 和浏览器历史。Cookie 天然覆盖 SSE。
 */
export class SessionStore {
  constructor (ttlHours) {
    this.ttlMs = ttlHours * 3600 * 1000
    this.sessions = new Map()
    this.timer = setInterval(() => this.sweep(), 10 * 60 * 1000)
    this.timer.unref()
  }

  create () {
    const token = crypto.randomBytes(32).toString('hex')
    this.sessions.set(token, { createdAt: Date.now(), lastSeen: Date.now() })
    return token
  }

  validate (token) {
    if (!token) return false
    const s = this.sessions.get(token)
    if (!s) return false
    if (Date.now() - s.createdAt > this.ttlMs) {
      this.sessions.delete(token)
      return false
    }
    s.lastSeen = Date.now()
    return true
  }

  destroy (token) {
    this.sessions.delete(token)
  }

  sweep () {
    const now = Date.now()
    for (const [token, s] of this.sessions) {
      if (now - s.createdAt > this.ttlMs) this.sessions.delete(token)
    }
  }
}

/**
 * 登录失败限流。
 *
 * 服务绑在 0.0.0.0 上，任何人都能对着登录接口跑字典，所以这条是必需品。
 * 注意它依赖 Express 的 trust proxy 设置：经 frp -> nginx 访问时若不配，
 * req.ip 会全部变成代理地址，所有外网请求共用一个计数器——攻击者失败 5 次
 * 就把你自己也锁在门外，白送一个 DoS。
 */
export class LoginLimiter {
  constructor ({ maxFailures, lockMinutes }) {
    this.maxFailures = maxFailures
    this.lockMs = lockMinutes * 60 * 1000
    this.entries = new Map()
  }

  check (ip) {
    const e = this.entries.get(ip)
    if (!e) return { locked: false }
    if (e.lockedUntil && Date.now() < e.lockedUntil) {
      return { locked: true, retryAfterMs: e.lockedUntil - Date.now() }
    }
    if (e.lockedUntil && Date.now() >= e.lockedUntil) {
      this.entries.delete(ip)
    }
    return { locked: false }
  }

  recordFailure (ip) {
    const e = this.entries.get(ip) ?? { failures: 0, lockedUntil: null }
    e.failures += 1
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = Date.now() + this.lockMs
      e.failures = 0
    }
    this.entries.set(ip, e)
    return e
  }

  reset (ip) {
    this.entries.delete(ip)
  }
}

export function createAuthMiddleware ({ sessions, cfg }) {
  /**
   * CSRF 第二道防线（第一道是 Cookie 的 SameSite=Strict）。
   *
   * 在一个能执行任意 shell 命令的系统上，CSRF 是致命的：你登录着，
   * 另开一个标签页访问了恶意网页，那个页面就能向本服务发 POST，
   * 浏览器自动带上 Cookie，于是以你的身份执行任意命令——你什么都没点。
   */
  const checkOrigin = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()

    const origin = req.get('origin')
    if (!origin) return next() // 非浏览器客户端（curl 等）没有 Origin

    const allowed = cfg.allowedOrigins ?? []
    if (allowed.length === 0) return next() // 未配置则跳过，便于本地开发

    if (!allowed.includes(origin)) {
      return res.status(403).json({ error: `Origin 不在白名单内：${origin}` })
    }
    next()
  }

  const requireAuth = (req, res, next) => {
    const token = req.cookies?.[COOKIE_NAME]
    if (!sessions.validate(token)) {
      return res.status(401).json({ error: '未登录或会话已过期' })
    }
    req.sessionToken = token
    next()
  }

  return { checkOrigin, requireAuth }
}

export function setSessionCookie (req, res, token, cfg) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,        // 日志内容是不可信输入，XSS 面比一般应用大，必须挡住 JS 读取
    sameSite: 'strict',    // CSRF 第一道防线
    secure: req.secure,    // 依赖 trust proxy 才能正确识别 nginx 终结的 HTTPS
    maxAge: cfg.auth.sessionTtlHours * 3600 * 1000,
    path: '/'
  })
}

export function clearSessionCookie (res) {
  res.clearCookie(COOKIE_NAME, { path: '/' })
}

export { COOKIE_NAME }

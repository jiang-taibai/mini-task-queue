import express from 'express'
import { verifyPassword, setSessionCookie, clearSessionCookie, COOKIE_NAME } from '../auth.js'

export function createSystemRouter ({ cfg, sessions, limiter, gpu, scheduler, requireAuth }) {
  const router = express.Router()

  router.post('/login', async (req, res) => {
    const ip = req.ip

    const state = limiter.check(ip)
    if (state.locked) {
      const minutes = Math.ceil(state.retryAfterMs / 60000)
      return res.status(429).json({ error: `尝试次数过多，请在 ${minutes} 分钟后重试` })
    }

    if (!cfg.auth.salt || !cfg.auth.hash) {
      return res.status(500).json({ error: '尚未设置密码，请先在服务器上运行 npm run setup' })
    }

    const password = String(req.body?.password ?? '')
    const ok = await verifyPassword(password, cfg.auth.salt, cfg.auth.hash)

    if (!ok) {
      const entry = limiter.recordFailure(ip)
      const remaining = cfg.auth.maxFailures - entry.failures
      return res.status(401).json({
        error: remaining > 0 ? `密码错误，还可尝试 ${remaining} 次` : '密码错误，已触发锁定'
      })
    }

    limiter.reset(ip)
    const token = sessions.create()
    setSessionCookie(req, res, token, cfg)
    res.json({ ok: true })
  })

  router.post('/logout', (req, res) => {
    const token = req.cookies?.[COOKIE_NAME]
    if (token) sessions.destroy(token)
    clearSessionCookie(res)
    res.json({ ok: true })
  })

  router.get('/me', (req, res) => {
    const token = req.cookies?.[COOKIE_NAME]
    res.json({ authenticated: sessions.validate(token) })
  })

  router.get('/gpu', requireAuth, (req, res) => {
    res.json(scheduler.annotateState(gpu.getState()))
  })

  router.get('/config', requireAuth, (req, res) => {
    // 只暴露前端需要的部分，绝不返回 auth 段
    res.json({
      gpuSource: cfg.gpu.source,
      scheduler: {
        warmupSeconds: cfg.scheduler.warmupSeconds,
        maxPerGpu: cfg.scheduler.maxPerGpu,
        maxRetries: cfg.scheduler.maxRetries,
        oomWindowSeconds: cfg.scheduler.oomWindowSeconds
      }
    })
  })

  /**
   * Mock 数据源的控制接口——开发机只有单卡，靠它构造双卡场景来验证
   * 分流、账本与预热期。真实数据源下整段不注册。
   */
  if (gpu.mock) {
    router.post('/mock/external', requireAuth, (req, res) => {
      const { gpuIndex, memMb } = req.body ?? {}
      if (!Number.isInteger(gpuIndex)) return res.status(400).json({ error: 'gpuIndex 必须是整数' })
      gpu.mock.setExternal(gpuIndex, Number(memMb) || 0)
      res.json({ ok: true, state: gpu.getState() })
    })

    router.post('/mock/drift', requireAuth, (req, res) => {
      gpu.mock.setDrift(!!req.body?.enabled)
      res.json({ ok: true, drift: !!req.body?.enabled })
    })

    router.post('/mock/fluctuate', requireAuth, (req, res) => {
      gpu.mock.setFluctuate(!!req.body?.enabled)
      res.json({ ok: true, fluctuate: !!req.body?.enabled })
    })
  }

  return router
}

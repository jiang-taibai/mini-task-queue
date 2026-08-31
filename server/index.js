import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import fs from 'node:fs'

import { loadConfig, ROOT } from './config.js'
import { getDb } from './db.js'
import { GpuMonitor } from './gpu/index.js'
import { Runner } from './runner.js'
import { Scheduler } from './scheduler.js'
import { SessionStore, LoginLimiter, createAuthMiddleware } from './auth.js'
import { createTasksRouter } from './routes/tasks.js'
import { createEventsRouter } from './routes/events.js'
import { createSystemRouter } from './routes/system.js'

const cfg = loadConfig()
const db = getDb()
const gpu = new GpuMonitor(cfg)
const runner = new Runner(cfg)
const scheduler = new Scheduler(cfg, db, gpu, runner)

const sessions = new SessionStore(cfg.auth.sessionTtlHours)
const limiter = new LoginLimiter(cfg.auth)
const { checkOrigin, requireAuth } = createAuthMiddleware({ sessions, cfg })

const app = express()

// 经 frp -> nginx 访问时必须启用，否则 req.ip 全是代理地址：
// 登录限流会退化成全局计数器，且 req.secure 恒为 false 导致 Cookie 的
// Secure 标志设不上
app.set('trust proxy', cfg.trustProxy)
app.disable('x-powered-by')

app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(checkOrigin)

app.use('/api', createSystemRouter({ cfg, sessions, limiter, gpu, scheduler, requireAuth }))
app.use('/api/tasks', requireAuth, createTasksRouter({ db, scheduler, gpu, cfg }))
app.use('/api/events', requireAuth, createEventsRouter({ db, scheduler, gpu }))

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }))

// 前端构建产物由后端直接托管：单端口单进程，不用配反向代理也不用处理跨域
const publicDir = path.join(ROOT, 'server', 'public')
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir))
  // SPA 回退用无路径中间件而非 app.get('/*splat')：
  // Express 5 的命名通配符不匹配根路径 '/'，直接访问首页会掉进 404
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next()
    res.sendFile(path.join(publicDir, 'index.html'))
  })
} else {
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next()
    res.status(503).type('text/plain; charset=utf-8')
      .send('前端尚未构建。请先运行：npm run build')
  })
}

app.use((err, req, res, next) => {
  console.error('[http]', err)
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' })
})

async function main () {
  if (!cfg.auth.salt || !cfg.auth.hash) {
    console.warn('\n⚠️  尚未设置登录密码，任何人都无法登录。请先运行：npm run setup\n')
  }
  if ((cfg.allowedOrigins ?? []).length === 0) {
    console.warn('⚠️  allowedOrigins 为空，CSRF 的 Origin 校验已跳过（仅依赖 Cookie 的 SameSite=Strict）')
  } else {
    // 打印出来，方便确认改动确实被加载了——配置只在启动时读取
    console.log(`[auth] Origin 白名单：${cfg.allowedOrigins.join('、')}`)
  }
  console.log(`[auth] trust proxy = ${cfg.trustProxy}`)

  try {
    await gpu.start()
    console.log(`[gpu] 数据源：${cfg.gpu.source}，检测到 ${gpu.getDeviceCount()} 张卡`)
  } catch (err) {
    // 起不来也要让服务活着：GPU 数据保持"失联"状态，调度器因此不会派出任何任务，
    // 界面上能看到明确的错误，比进程直接退出好排查
    console.error('[gpu] 启动失败，调度将保持暂停：', err.message)
  }

  scheduler.start()

  app.listen(cfg.port, cfg.host, () => {
    console.log(`\n  mini-task-queue 已启动`)
    console.log(`  监听 http://${cfg.host}:${cfg.port}`)
    console.log(`  数据目录 ${cfg.dataDir}`)
    console.log(`\n  提示：用 tmux 或 nohup 启动，否则 SSH 断开会让服务被 SIGHUP 终止`)
    console.log(`  （已在跑的任务不受影响，但队列会停止调度）\n`)
  })
}

function shutdown (signal) {
  console.log(`\n[server] 收到 ${signal}，正在关闭……`)
  // 刻意不动正在运行的任务：它们是 detached 启动的独立进程组，
  // 服务重启后会被重新认领
  scheduler.stop()
  gpu.stop()
  try {
    db.close()
  } catch { /* ignore */ }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

main().catch(err => {
  console.error('启动失败：', err)
  process.exit(1)
})

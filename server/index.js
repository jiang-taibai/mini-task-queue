import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import fs from 'node:fs'

import { loadConfig, ROOT } from './config.js'
import { getDb } from './db.js'
import { GpuMonitor } from './gpu/index.js'
import { Runner } from './runner.js'
import { Scheduler } from './scheduler.js'
import { acquireLock, takeover, describeHolder } from './lock.js'
import { SessionStore, LoginLimiter, createAuthMiddleware } from './auth.js'
import { createTasksRouter } from './routes/tasks.js'
import { createEventsRouter } from './routes/events.js'
import { createSystemRouter } from './routes/system.js'

/**
 * 这个文件是服务入口，不是测试文件——被 test runner 加载就是个事故。
 *
 * `node --test server/` 会把目录下每个文件都当测试跑，包括这一个。它没有
 * 任何 test() 用例，于是「跑」的方式就是从头执行一遍：打开数据库、跑迁移、
 * 启动调度器、占住端口。测试跑完 runner 退出了，这个服务却留在后台，
 * 拿着 data/queue.db 继续派发任务——一个谁都不知道它存在的调度器。
 *
 * 真发生过一次：进程活了近两个小时，而 `pgrep -f 'node server/index.js'`
 * 找不到它（它的命令行是 `node --test ... server`）。
 *
 * npm test 用的是 server/*.test.js 通配，不会碰到这里；这道闸门防的是
 * 手滑写成目录的那次。必须放在 getDb() 之前——那一行就已经在动数据库了。
 */
if (process.env.NODE_TEST_CONTEXT) {
  console.error('\n[启动被拒绝] server/index.js 被 Node test runner 加载了。')
  console.error('  它是服务入口而非测试文件，跑起来会占用端口并连上数据库跑调度器。')
  console.error('  跑测试请用：npm test（等价于 node --test server/*.test.js）')
  console.error('  不要用：node --test server/\n')
  process.exit(1)
}

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

/**
 * 抢单实例锁，抢不到就退出。
 *
 * 必须在 scheduler.start() 之前完成。调度器一旦跑起来就会派任务、写库、
 * spawn 进程，而多开的实例在运行时没有任何症状——端口只有一个能绑上，
 * 绑不上的那几个照样调度。
 */
async function claimSingleInstance () {
  const lockPath = path.join(cfg.dataDir, 'server.lock')
  let lock = acquireLock(lockPath)

  if (!lock.ok && lock.holder && process.argv.includes('--takeover')) {
    console.log(`[lock] 已有实例在运行（${describeHolder(lock.holder)}），正在请求它退出……`)
    const result = await takeover(lockPath, lock.holder)
    if (!result.ok) {
      console.error(`[lock] 接管失败：${result.reason}`)
      console.error('[lock] 请手动确认那个进程的状态，不要用 kill -9——它会跳过关库流程')
      process.exit(1)
    }
    console.log('[lock] 旧实例已退出')
    lock = acquireLock(lockPath)
  }

  if (!lock.ok) {
    console.error(`\n[lock] 已有实例在运行（${describeHolder(lock.holder)}），本进程退出。`)
    console.error('  同一个 data/ 上跑多个实例会让多个调度器抢同一个队列：')
    console.error('  重复派发、同一个任务起两个进程、显存账本对不上。')
    console.error('\n  要替换正在跑的那个：npm start -- --takeover')
    console.error('  （正在跑的任务不受影响，它们是独立进程组，新实例起来后会重新认领）\n')
    process.exit(1)
  }

  // 覆盖所有退出路径：正常 shutdown、未捕获异常、process.exit
  process.on('exit', () => lock.release())
}

/** listen 失败必须让进程真的失败——否则调度器会在一个「启动失败」的进程里继续跑 */
function listen () {
  return new Promise((resolve, reject) => {
    const server = app.listen(cfg.port, cfg.host, () => resolve(server))
    server.on('error', reject)
  })
}

async function main () {
  if (!cfg.auth.salt || !cfg.auth.hash) {
    console.warn('\n⚠️  尚未设置登录密码，任何人都无法登录。请先运行：npm run setup\n')
  }
  if ((cfg.allowedOrigins ?? []).length === 0) {
    console.warn('⚠️  allowedOrigins 为空，CSRF 的 Origin 校验已跳过（仅依赖 Cookie 的 SameSite=Strict）')
  }

  await claimSingleInstance()

  try {
    await gpu.start()
    console.log(`[gpu] 数据源：${cfg.gpu.source}，检测到 ${gpu.getDeviceCount()} 张卡`)
  } catch (err) {
    // 起不来也要让服务活着：GPU 数据保持"失联"状态，调度器因此不会派出任何任务，
    // 界面上能看到明确的错误，比进程直接退出好排查
    console.error('[gpu] 启动失败，调度将保持暂停：', err.message)
  }

  // 先确认端口真的拿到了，再启动调度器。反过来的话，一个绑不上端口的进程
  // 也会开始派任务——线上那 5 个幽灵调度器就是这么来的
  await listen()
  scheduler.start()

  console.log(`\n  mini-task-queue 已启动`)
  console.log(`  监听 http://${cfg.host}:${cfg.port}`)
  console.log(`  数据目录 ${cfg.dataDir}`)
  console.log(`\n  提示：用 tmux 或 nohup 启动，否则 SSH 断开会让服务被 SIGHUP 终止`)
  console.log(`  （已在跑的任务不受影响，但队列会停止调度）\n`)
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
  if (err?.code === 'EADDRINUSE') {
    console.error(`\n启动失败：端口 ${cfg.port} 已被占用。`)
    console.error('  若占用者是本服务的另一个实例：npm start -- --takeover')
    console.error('  否则改 config.json 里的 port，或用 PORT=xxxx npm start\n')
  } else {
    console.error('启动失败：', err)
  }
  process.exit(1)
})

import express from 'express'
import { rowToTask } from '../db.js'

/**
 * 状态总线 SSE。
 *
 * 与日志流刻意分开：日志每秒可能几十行，若共用一条连接，打开任务详情页会让
 * 整个界面的状态刷新被日志噪声拖累。这条只走低频的结构化状态。
 */
export function createEventsRouter ({ db, scheduler, gpu }) {
  const router = express.Router()
  const clients = new Set()

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) {
      try {
        res.write(payload)
      } catch {
        clients.delete(res)
      }
    }
  }

  const snapshotTasks = () => ({
    tasks: db.prepare('SELECT * FROM tasks ORDER BY queue_order ASC, id ASC').all().map(rowToTask),
    blocking: scheduler.getBlockingInfo()
  })

  // 任务变更可能在一拍内连续触发多次（级联取消、批量重排），合并后再推
  let pending = null
  const scheduleTaskBroadcast = () => {
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      if (clients.size > 0) broadcast('tasks', snapshotTasks())
    }, 200)
  }

  scheduler.on('change', scheduleTaskBroadcast)
  scheduler.on('log', message => broadcast('log', { at: Date.now(), message }))

  gpu.on('update', () => {
    if (clients.size > 0) broadcast('gpu', gpu.getState())
  })
  gpu.on('warn', entry => broadcast('warn', entry))

  // GPU 失联时不会再有 update 事件，靠这个心跳把"已失联"状态推给前端
  setInterval(() => {
    if (clients.size > 0 && gpu.isStale()) broadcast('gpu', gpu.getState())
  }, 2000).unref()

  router.get('/', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(': connected\n\n')

    clients.add(res)

    // 立刻推一份全量，避免前端在首次变更前一直空着
    res.write(`event: gpu\ndata: ${JSON.stringify(gpu.getState())}\n\n`)
    res.write(`event: tasks\ndata: ${JSON.stringify(snapshotTasks())}\n\n`)

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(heartbeat)
      }
    }, 20000)

    req.on('close', () => {
      clients.delete(res)
      clearInterval(heartbeat)
    })
  })

  return router
}

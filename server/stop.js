import path from 'node:path'
import { loadConfig } from './config.js'
import { readHolder, takeover, describeHolder } from './lock.js'

/**
 * 停掉正在运行的实例。
 *
 * 只认锁文件里的那一个。升级到本版本之前起的进程没有写过锁，这里看不见它们，
 * 得先用 ps 找出来手动 kill——锁管不了自己出现之前的事。
 */
const cfg = loadConfig()
const lockPath = path.join(cfg.dataDir, 'server.lock')
const holder = readHolder(lockPath)

if (!holder) {
  console.log(`没有正在运行的实例（${lockPath} 没有活着的持有者）。`)
  console.log('若确信还有服务在跑，它多半是升级前启动的，用 ps 找出来：')
  console.log("  pgrep -af 'node server/index.js'")
  process.exit(0)
}

console.log(`正在请求 ${describeHolder(holder)} 退出……`)

const result = await takeover(lockPath, holder)
if (!result.ok) {
  console.error(`停止失败：${result.reason}`)
  console.error('别用 kill -9：它会跳过关库流程。先看看那个进程卡在哪。')
  process.exit(1)
}

console.log('已停止。正在跑的任务不受影响——它们是独立进程组，下次启动会被重新认领。')

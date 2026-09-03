import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadConfig } from './config.js'
import { getPgid } from './runner.js'

/**
 * 找出「在 GPU 上吃着显存，但不在调度器账本里」的进程。
 *
 * 调度器只认 tasks 表里 status='running' 的行来算显存（countRunningByGpu、
 * reservedOn）。账本外的进程它完全看不见，但那些进程照样占着卡：于是调度器
 * 以为卡是空的、继续往上派任务，新任务起来就 OOM。日志里只有一句
 * CUDA out of memory，真凶不在任何界面上。
 *
 * 孤儿的两个来源都真实发生过：重复派发时记账失败（进程已 spawn，任务却被标
 * failed），以及手动 kill 打偏（杀掉 sh -c 包装层，真正的进程活了下来）。
 * 它们不会随服务重启消失。
 *
 * 只报告，不动手：那台机器上还有同事在用，误杀一次的代价远大于多看一眼。
 */

/** 归属判据与调度器保持一致：nvidia-smi 报的是 python 进程，我们记的是 bash wrapper，靠 pgid 对上 */
export const UNMATCHED = 'unmatched'
export const FOREIGN = 'foreign'
export const ORPHAN = 'orphan'
export const TRACKED = 'tracked'

/**
 * 把 GPU 进程分成四类。纯函数，便于在没有真实 GPU 的机器上测。
 *
 * @param gpuProcs  [{ gpuIndex, pid, usedMemoryMb, user }]
 * @param running   [{ id, name, pgid, gpuIndices }]  status='running' 的任务
 * @param attempts  [{ taskId, taskName, attemptNo, pgid, taskStatus, finishedAt }] 历史尝试
 * @param pgidOf    pid -> pgid（注入以便测试）
 * @param selfUser  当前用户名；判不出属主时按「不是别人的」处理
 */
export function classifyProcesses ({ gpuProcs, running, attempts, pgidOf, selfUser }) {
  const runningByPgid = new Map()
  for (const t of running) {
    if (t.pgid) runningByPgid.set(t.pgid, t)
  }
  // 同一个 pgid 可能有多条历史尝试，保留最近的那次
  const attemptByPgid = new Map()
  for (const a of attempts) {
    if (!a.pgid) continue
    const prev = attemptByPgid.get(a.pgid)
    if (!prev || (a.attemptNo ?? 0) > (prev.attemptNo ?? 0)) attemptByPgid.set(a.pgid, a)
  }

  return gpuProcs.map(p => {
    const pgid = pgidOf(p.pid)
    const base = { ...p, pgid }

    // 属主不是自己 -> 同事的进程，任何情况下都不该动
    if (p.user && selfUser && p.user !== selfUser) return { ...base, kind: FOREIGN }

    const live = pgid === null ? undefined : runningByPgid.get(pgid)
    if (live) return { ...base, kind: TRACKED, task: live }

    // 出现在 attempts 里 = 我们确实启动过它，而那个任务已经结束了。
    // 这是最强的证据：白纸黑字记着这个 pgid 是我们派出去的
    const past = pgid === null ? undefined : attemptByPgid.get(pgid)
    if (past) return { ...base, kind: ORPHAN, attempt: past }

    return { ...base, kind: UNMATCHED }
  })
}

/** nvidia-smi 的两次查询：uuid->卡号 映射，以及正在跑 CUDA 的进程 */
function queryGpu () {
  const run = args => execFileSync('nvidia-smi', args, { encoding: 'utf8', timeout: 15000 })

  const uuidToIndex = new Map()
  for (const line of run(['--query-gpu=index,uuid', '--format=csv,noheader']).trim().split('\n')) {
    const [index, uuid] = line.split(',').map(s => s.trim())
    if (uuid) uuidToIndex.set(uuid, Number(index))
  }

  const out = run(['--query-compute-apps=gpu_uuid,pid,used_memory', '--format=csv,noheader,nounits']).trim()
  if (!out) return []

  return out.split('\n').map(line => {
    const [uuid, pid, mem] = line.split(',').map(s => s.trim())
    return {
      gpuIndex: uuidToIndex.get(uuid) ?? null,
      pid: Number(pid),
      // 部分驱动版本对 used_memory 会返回 [N/A]，Number() 会得到 NaN
      usedMemoryMb: Number.isFinite(Number(mem)) ? Number(mem) : null,
      user: ownerOf(Number(pid))
    }
  })
}

/** 进程属主。读 /proc 而不是调 ps：少一次 spawn，也不受 ps 输出格式影响 */
function ownerOf (pid) {
  try {
    const uid = fs.statSync(`/proc/${pid}`).uid
    const line = fs.readFileSync('/etc/passwd', 'utf8')
      .split('\n').find(l => Number(l.split(':')[2]) === uid)
    return line ? line.split(':')[0] : String(uid)
  } catch {
    return null
  }
}

function procInfo (pid) {
  const read = f => {
    try { return fs.readFileSync(`/proc/${pid}/${f}`, 'utf8') } catch { return '' }
  }
  const link = f => {
    try { return fs.readlinkSync(`/proc/${pid}/${f}`) } catch { return null }
  }
  return {
    cmdline: read('cmdline').replace(/\0/g, ' ').trim() || null,
    cwd: link('cwd'),
    ppid: Number(read('status').match(/^PPid:\s*(\d+)/m)?.[1] ?? 0) || null
  }
}

function formatMb (mb) {
  if (mb === null) return '未知'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

function main () {
  const cfg = loadConfig()
  const dbPath = path.join(cfg.dataDir, 'queue.db')
  if (!fs.existsSync(dbPath)) {
    console.error(`找不到数据库：${dbPath}`)
    process.exit(1)
  }

  // 直接开库、只跑 SELECT。刻意不走 getDb()——那个会跑 migrate，
  // 一个诊断脚本不该改生产库的 schema
  const db = new DatabaseSync(dbPath)

  let gpuProcs
  try {
    gpuProcs = queryGpu()
  } catch (err) {
    console.error(`nvidia-smi 调用失败：${err.message}`)
    console.error('这个脚本要在装了 NVIDIA 驱动的机器上跑。')
    process.exit(1)
  }

  if (gpuProcs.length === 0) {
    console.log('GPU 上没有任何计算进程，无需对账。')
    return
  }

  const running = db.prepare(`
    SELECT id, name, pgid, gpu_indices FROM tasks WHERE status = 'running'
  `).all().map(r => ({ id: r.id, name: r.name, pgid: r.pgid }))

  const attempts = db.prepare(`
    SELECT a.task_id, a.attempt_no, a.pgid, a.finished_at,
           t.name AS task_name, t.status AS task_status
    FROM attempts a JOIN tasks t ON t.id = a.task_id
    WHERE a.pgid IS NOT NULL AND t.status <> 'running'
  `).all().map(r => ({
    taskId: r.task_id,
    taskName: r.task_name,
    attemptNo: r.attempt_no,
    pgid: r.pgid,
    taskStatus: r.task_status,
    finishedAt: r.finished_at
  }))

  const selfUser = ownerOf(process.pid)
  const rows = classifyProcesses({ gpuProcs, running, attempts, pgidOf: getPgid, selfUser })

  const by = kind => rows.filter(r => r.kind === kind)
  const orphans = by(ORPHAN)
  const unmatched = by(UNMATCHED)

  console.log(`\nGPU 上共 ${rows.length} 个计算进程：`)
  console.log(`  ${by(TRACKED).length} 个在账本内（正常）`)
  console.log(`  ${by(FOREIGN).length} 个属于其他用户（不该动）`)
  console.log(`  ${orphans.length} 个确认的孤儿`)
  console.log(`  ${unmatched.length} 个无法归属`)

  const describe = r => {
    const info = procInfo(r.pid)
    console.log(`\n  GPU ${r.gpuIndex ?? '?'} · pid ${r.pid}（pgid ${r.pgid ?? '?'}）· ${formatMb(r.usedMemoryMb)} · 属主 ${r.user ?? '未知'}`)
    if (r.attempt) {
      const when = r.attempt.finishedAt ? new Date(r.attempt.finishedAt).toLocaleString() : '未知时间'
      console.log(`    来自任务 #${r.attempt.taskId}「${r.attempt.taskName}」第 ${r.attempt.attemptNo} 次尝试`)
      console.log(`    该任务已于 ${when} 记为 ${r.attempt.taskStatus}，进程却还活着`)
    }
    if (info.cmdline) console.log(`    命令 ${info.cmdline.slice(0, 160)}`)
    if (info.cwd) console.log(`    目录 ${info.cwd}`)
    if (info.ppid === 1) console.log('    父进程已是 init（1），说明它被托孤了')
  }

  if (orphans.length) {
    console.log('\n=== 确认的孤儿：我们启动过，任务已结束，进程还占着卡 ===')
    orphans.forEach(describe)
    const pgids = [...new Set(orphans.map(r => r.pgid).filter(Boolean))]
    console.log('\n  确认无误后，按进程组终止（连同 DataLoader worker 一起）：')
    for (const g of pgids) console.log(`    kill -- -${g}`)
  }

  if (unmatched.length) {
    console.log('\n=== 无法归属：属主是你，但账本和历史记录里都没有 ===')
    console.log('（可能是手动跑的实验，也可能是记录丢失的孤儿——看命令自行判断）')
    unmatched.forEach(describe)
  }

  if (!orphans.length && !unmatched.length) {
    console.log('\n没有发现账本之外的进程。')
  }
  console.log()
  db.close()
}

// 被 import 时（测试）不执行主流程
if (import.meta.filename === process.argv[1]) main()

import { reactive, computed, watch } from 'vue'
import { api } from './api.js'

export const state = reactive({
  authenticated: false,
  checking: true,
  connected: false,
  config: null,

  gpu: {
    stale: true,
    lastUpdate: null,
    source: null,
    devices: [],
    processes: [],
    processesAvailable: false,
    warnings: []
  },

  tasks: [],
  blocking: null,
  events: []
})

export const runningTasks = computed(() => state.tasks.filter(t => t.status === 'running'))
export const queuedTasks = computed(() =>
  state.tasks.filter(t => t.status === 'pending' || t.status === 'blocked')
)
const SORT_STORAGE_KEY = 'mtq-finished-sort'
export const FINISHED_SORT_KEYS = ['id', 'finishedAt', 'createdAt']

/**
 * 已结束列表的排序偏好，存本地。
 *
 * 这一栏是回头翻结果用的——按创建顺序看一批实验、或者按序号定位某个任务，
 * 每次刷新都被打回「最近结束的在前」会很烦。
 */
export const finishedSort = reactive(loadSort())

function loadSort () {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY))
    if (FINISHED_SORT_KEYS.includes(saved?.by)) return { by: saved.by, desc: !!saved.desc }
  } catch { /* 存坏了就当没存过 */ }
  return { by: 'finishedAt', desc: true }
}

watch(finishedSort, v => localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(v)), { deep: true })

export const finishedTasks = computed(() => {
  const { by, desc } = finishedSort
  const dir = desc ? -1 : 1
  return state.tasks
    .filter(t => ['succeeded', 'failed', 'cancelled'].includes(t.status))
    .sort((a, b) => {
      // 批量取消时一堆任务的时间戳会撞在同一毫秒，用 id 兜底，
      // 否则它们的相对顺序每次推送都可能变一次
      const diff = (a[by] ?? 0) - (b[by] ?? 0)
      return (diff || a.id - b.id) * dir
    })
})

let source = null
let retryTimer = null

export function connectEvents () {
  if (source) return

  source = new EventSource('/api/events')

  source.onopen = () => { state.connected = true }

  source.addEventListener('gpu', e => { state.gpu = JSON.parse(e.data) })

  source.addEventListener('tasks', e => {
    const payload = JSON.parse(e.data)
    state.tasks = payload.tasks
    state.blocking = payload.blocking
  })

  source.addEventListener('log', e => pushEvent(JSON.parse(e.data)))
  source.addEventListener('warn', e => pushEvent({ ...JSON.parse(e.data), level: 'warn' }))

  source.onerror = () => {
    state.connected = false
    // EventSource 会自行重连，但若是会话过期就会无限重试 401。
    // 主动探一次登录态，失效则退出到登录页而不是空转。
    if (retryTimer) return
    retryTimer = setTimeout(async () => {
      retryTimer = null
      try {
        const me = await api.me()
        if (!me.authenticated) {
          state.authenticated = false
          disconnectEvents()
        }
      } catch { /* 网络还没恢复，交给 EventSource 继续重连 */ }
    }, 3000)
  }
}

export function disconnectEvents () {
  if (source) {
    source.close()
    source = null
  }
  state.connected = false
}

function pushEvent (entry) {
  state.events.unshift(entry)
  state.events = state.events.slice(0, 50)
}

export async function refreshAll () {
  const [tasks, gpu] = await Promise.all([api.listTasks(), api.gpu()])
  state.tasks = tasks.tasks
  state.blocking = tasks.blocking
  state.gpu = gpu
}

export async function checkAuth () {
  state.checking = true
  try {
    const me = await api.me()
    state.authenticated = me.authenticated
    if (me.authenticated) {
      state.config = await api.config()
      await refreshAll()
      connectEvents()
    }
  } catch {
    state.authenticated = false
  } finally {
    state.checking = false
  }
}

// 标签页标题带上状态摘要：扫一眼标签栏就知道队列情况，不必切回来看
watch(
  () => [runningTasks.value.length, queuedTasks.value.length, state.authenticated],
  ([running, queued, auth]) => {
    document.title = auth ? `(${running}跑/${queued}等) GPU 队列` : 'GPU 队列'
  },
  { immediate: true }
)

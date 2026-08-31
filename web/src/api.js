async function request (url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  })

  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }

  if (!res.ok) {
    const err = new Error(data?.error || `请求失败（HTTP ${res.status}）`)
    err.status = res.status
    err.payload = data
    throw err
  }
  return data
}

export const api = {
  login: password => request('/api/login', { method: 'POST', body: { password } }),
  logout: () => request('/api/logout', { method: 'POST' }),
  me: () => request('/api/me'),
  config: () => request('/api/config'),
  gpu: () => request('/api/gpu'),

  listTasks: () => request('/api/tasks'),
  getTask: id => request(`/api/tasks/${id}`),
  createTask: body => request('/api/tasks', { method: 'POST', body }),
  updateTask: (id, body) => request(`/api/tasks/${id}`, { method: 'PATCH', body }),
  deleteTask: id => request(`/api/tasks/${id}`, { method: 'DELETE' }),
  stopTask: id => request(`/api/tasks/${id}/stop`, { method: 'POST' }),
  requeueTask: id => request(`/api/tasks/${id}/requeue`, { method: 'POST' }),
  reorder: ids => request('/api/tasks/reorder', { method: 'POST', body: { ids } }),

  logs: (id, { attempt, offset, maxBytes } = {}) => {
    const params = new URLSearchParams()
    if (attempt !== undefined) params.set('attempt', attempt)
    if (offset !== undefined && offset !== null) params.set('offset', offset)
    if (maxBytes !== undefined) params.set('maxBytes', maxBytes)
    return request(`/api/tasks/${id}/logs?${params}`)
  },

  setMockExternal: (gpuIndex, memMb) =>
    request('/api/mock/external', { method: 'POST', body: { gpuIndex, memMb } }),
  setMockFluctuate: enabled =>
    request('/api/mock/fluctuate', { method: 'POST', body: { enabled } })
}

export function formatMb (mb) {
  if (mb === null || mb === undefined) return '—'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

export function formatBytes (bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDuration (ms) {
  if (ms === null || ms === undefined) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

export function formatTime (ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const STATUS_META = {
  blocked: { label: '等待依赖', type: 'default' },
  pending: { label: '排队中', type: 'info' },
  running: { label: '运行中', type: 'success' },
  succeeded: { label: '已完成', type: 'success' },
  failed: { label: '失败', type: 'error' },
  cancelled: { label: '已取消', type: 'warning' }
}

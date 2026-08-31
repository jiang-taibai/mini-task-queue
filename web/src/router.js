import { watch } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { state, checkAuth, disconnectEvents } from './store.js'

import Home from './views/Home.vue'
import Login from './views/Login.vue'
import TaskDetail from './views/TaskDetail.vue'

const routes = [
  { path: '/', name: 'home', component: Home },
  { path: '/login', name: 'login', component: Login },
  // 详情用独立路由而非抽屉：日志需要大空间，而且这样每个任务都有可收藏的地址
  { path: '/task/:id', name: 'task', component: TaskDetail, props: true },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

export const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(async to => {
  if (state.checking) await checkAuth()

  if (!state.authenticated && to.name !== 'login') {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (state.authenticated && to.name === 'login') {
    return { path: '/' }
  }
  // Vue Router 5 起 next() 已废弃，守卫改为返回值风格
})

/**
 * 会话失效时主动退回登录页。
 *
 * 路由守卫只在导航时触发，而会话是在停留期间过期的（比如服务被手动重启）。
 * 不处理的话，页面会停在原地，各条 SSE 连接则不停重连、不停收 401。
 * 跳走能让所有流随组件卸载一起关闭。
 */
watch(() => state.authenticated, authenticated => {
  if (authenticated) return
  disconnectEvents()
  const current = router.currentRoute.value
  if (current.name !== 'login') {
    router.push({ name: 'login', query: { redirect: current.fullPath } })
  }
})

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage, useDialog } from 'naive-ui'
import { VueDraggable } from 'vue-draggable-plus'

import GpuCard from '../components/GpuCard.vue'
import TaskCard from '../components/TaskCard.vue'
import TaskForm from '../components/TaskForm.vue'

import { api, formatMb, formatDuration } from '../api.js'
import {
  state, runningTasks, queuedTasks, finishedTasks, finishedSort, refreshAll, disconnectEvents
} from '../store.js'
import { toggleTheme, isDark } from '../theme.js'

const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const showForm = ref(false)
const editTask = ref(null)
const cloneFrom = ref(null)

// 用于让"已运行/已等待"这类相对时间自己走字
const now = ref(Date.now())
let ticker = null
onMounted(() => { ticker = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(ticker))

// 拖拽期间冻结列表：SSE 每秒都在推新数据，不冻结的话正拖着的行会被顶掉
const dragging = ref(false)
const localQueue = ref([])
watch(queuedTasks, list => {
  if (!dragging.value) localQueue.value = [...list]
}, { immediate: true, deep: true })

const processesByGpu = computed(() => {
  const map = new Map()
  for (const p of state.gpu.processes ?? []) {
    if (p.gpuIndex === null) continue
    if (!map.has(p.gpuIndex)) map.set(p.gpuIndex, [])
    map.get(p.gpuIndex).push(p)
  }
  return map
})

const showFinished = ref(false)

const sortOptions = [
  { label: '按序号', value: 'id' },
  { label: '按结束时间', value: 'finishedAt' },
  { label: '按创建时间', value: 'createdAt' }
]

function openCreate () {
  editTask.value = null
  cloneFrom.value = null
  showForm.value = true
}
function openEdit (task) {
  editTask.value = task
  cloneFrom.value = null
  showForm.value = true
}
function openClone (task) {
  editTask.value = null
  cloneFrom.value = task
  showForm.value = true
}

async function onDragEnd () {
  dragging.value = false
  try {
    await api.reorder(localQueue.value.map(t => t.id))
  } catch (err) {
    message.error(`排序失败：${err.message}`)
    await refreshAll()
  }
}

async function stopTask (task) {
  try {
    const r = await api.stopTask(task.id)
    message.success(r.message)
  } catch (err) {
    message.error(err.message)
  }
}

async function requeueTask (task) {
  try {
    await api.requeueTask(task.id)
    message.success(`任务 #${task.id} 已重新排队`)
  } catch (err) {
    message.error(err.message)
  }
}

function removeTask (task) {
  dialog.warning({
    title: '删除任务',
    content: `确定删除 #${task.id}「${task.name}」？其日志文件也会一并删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deleteTask(task.id)
        message.success('已删除')
      } catch (err) {
        message.error(err.message)
      }
    }
  })
}

async function logout () {
  await api.logout()
  disconnectEvents()
  state.authenticated = false
  router.push('/login')
}
</script>

<template>
  <n-layout style="min-height: 100vh;">
    <n-layout-header bordered class="header">
      <n-space align="center" :size="12">
        <n-text strong style="font-size: 16px;">GPU 任务队列</n-text>
        <n-tag v-if="state.connected" size="small" type="success" :bordered="false">已连接</n-tag>
        <n-tag v-else size="small" type="warning" :bordered="false">连接中断</n-tag>
        <n-tag v-if="state.gpu.source === 'mock'" size="small" type="warning" :bordered="false">
          Mock 数据源
        </n-tag>
      </n-space>

      <n-space align="center" :size="8">
        <n-button size="small" quaternary @click="toggleTheme">
          {{ isDark ? '浅色' : '深色' }}
        </n-button>
        <n-button size="small" quaternary @click="logout">退出</n-button>
        <n-button size="small" type="primary" @click="openCreate">新建任务</n-button>
      </n-space>
    </n-layout-header>

    <n-layout-content class="content">
      <!-- 监控失联时调度会整体暂停，这条必须最醒目 -->
      <n-alert v-if="state.gpu.stale" type="error" title="GPU 监控已失联" style="margin-bottom: 16px;">
        显存读数已过期，调度器已暂停派发新任务。正在运行的任务不受影响。
        <template v-if="state.gpu.warnings?.length">
          <div v-for="(w, i) in state.gpu.warnings" :key="i" style="margin-top: 4px; font-size: 12px;">
            {{ w.message }}
          </div>
        </template>
      </n-alert>

      <!-- 严格门控 + 手动排序的代价：队头挡住所有人时，卡可能空转 -->
      <n-alert
        v-else-if="state.blocking"
        type="warning"
        style="margin-bottom: 16px;"
        :title="`队列被 #${state.blocking.taskId}「${state.blocking.taskName}」阻塞`"
      >
        {{ state.blocking.reason }}，已等待 {{ formatDuration(state.blocking.waitingMs) }}，
        后方还有 {{ state.blocking.queueLength - 1 }} 个任务在等。
        <template v-if="state.blocking.idleGpus.length">
          当前空闲：{{ state.blocking.idleGpus.map(g => `GPU ${g.index}（可派 ${formatMb(g.availableMb)}）`).join('、') }}。
          如需让后方任务先跑，请拖动调整顺序。
        </template>
      </n-alert>

      <n-grid :cols="state.gpu.devices.length || 1" :x-gap="12" style="margin-bottom: 20px;">
        <n-gi v-for="d in state.gpu.devices" :key="d.index">
          <GpuCard
            :device="d"
            :processes="processesByGpu.get(d.index) ?? []"
            :reserved-mb="state.gpu.reserved?.[d.index] ?? 0"
            :stale="state.gpu.stale"
            :processes-available="state.gpu.processesAvailable"
          />
        </n-gi>
      </n-grid>

      <n-space vertical :size="20">
        <div>
          <n-h3 prefix="bar" style="margin-bottom: 10px;">
            运行中
            <n-text depth="3" style="font-size: 13px; font-weight: normal;">
              （{{ runningTasks.length }}）
            </n-text>
          </n-h3>
          <n-empty v-if="runningTasks.length === 0" description="暂无运行中的任务" size="small" />
          <TaskCard
            v-for="t in runningTasks"
            :key="t.id"
            :task="t"
            :now="now"
            @stop="stopTask"
            @edit="openEdit"
            @clone="openClone"
            @remove="removeTask"
            @requeue="requeueTask"
          />
        </div>

        <div>
          <n-h3 prefix="bar" style="margin-bottom: 10px;">
            队列
            <n-text depth="3" style="font-size: 13px; font-weight: normal;">
              （{{ localQueue.length }}，自上而下依次派发，拖动可调整顺序）
            </n-text>
          </n-h3>
          <n-empty v-if="localQueue.length === 0" description="队列为空" size="small" />
          <VueDraggable
            v-model="localQueue"
            :animation="150"
            handle=".drag-handle"
            @start="dragging = true"
            @end="onDragEnd"
          >
            <TaskCard
              v-for="t in localQueue"
              :key="t.id"
              :task="t"
              :now="now"
              draggable
              @stop="stopTask"
              @edit="openEdit"
              @clone="openClone"
              @remove="removeTask"
              @requeue="requeueTask"
            />
          </VueDraggable>
        </div>

        <div>
          <n-space align="center" :size="8" style="margin-bottom: 10px;">
            <n-h3 prefix="bar" style="margin: 0;">
              已结束
              <n-text depth="3" style="font-size: 13px; font-weight: normal;">
                （{{ finishedTasks.length }}）
              </n-text>
            </n-h3>
            <n-button size="tiny" quaternary @click="showFinished = !showFinished">
              {{ showFinished ? '收起' : '展开' }}
            </n-button>
            <template v-if="showFinished && finishedTasks.length > 1">
              <n-select
                v-model:value="finishedSort.by"
                size="tiny"
                :options="sortOptions"
                style="width: 108px;"
              />
              <!-- 正逆序做成一个按钮而不是第二个下拉：它只有两个状态，
                   点一下就翻转比展开菜单再选快得多 -->
              <n-button
                size="tiny"
                quaternary
                :title="finishedSort.desc ? '当前逆序，点击改为正序' : '当前正序，点击改为逆序'"
                @click="finishedSort.desc = !finishedSort.desc"
              >
                {{ finishedSort.desc ? '↓ 逆序' : '↑ 正序' }}
              </n-button>
            </template>
          </n-space>
          <template v-if="showFinished">
            <n-empty v-if="finishedTasks.length === 0" description="暂无已结束的任务" size="small" />
            <TaskCard
              v-for="t in finishedTasks"
              :key="t.id"
              :task="t"
              :now="now"
              @stop="stopTask"
              @edit="openEdit"
              @clone="openClone"
              @remove="removeTask"
              @requeue="requeueTask"
            />
          </template>
        </div>
      </n-space>
    </n-layout-content>

    <TaskForm
      v-model:show="showForm"
      :edit-task="editTask"
      :clone-from="cloneFrom"
    />
  </n-layout>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  position: sticky;
  top: 0;
  z-index: 10;
}
.content {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}
</style>

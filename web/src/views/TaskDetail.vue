<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage, useDialog } from 'naive-ui'

import LogViewer from '../components/LogViewer.vue'
import TaskForm from '../components/TaskForm.vue'
import { api, formatMb, formatBytes, formatTime, formatDuration, STATUS_META } from '../api.js'
import { state } from '../store.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const detail = ref(null)
const loading = ref(true)
const selectedAttempt = ref(null)
const showForm = ref(false)
const formMode = ref('edit')

const now = ref(Date.now())
let ticker = null

const task = computed(() => detail.value?.task ?? null)
const meta = computed(() => STATUS_META[task.value?.status] ?? { label: '—', type: 'default' })
const isRunning = computed(() => task.value?.status === 'running')

const elapsed = computed(() => {
  const t = task.value
  if (!t?.startedAt) return null
  return (t.finishedAt ?? now.value) - t.startedAt
})

// 跑到分配集合之外的卡上才算漂移；只用了其中一部分是「声明多了」，另作提示
const gpuDrift = computed(() => {
  const t = task.value
  if (!t?.actualGpus?.length || !t.gpuIndices?.length) return null
  const strays = t.actualGpus.filter(g => !t.gpuIndices.includes(g))
  return strays.length ? strays.join('、') : null
})

const partialUse = computed(() => {
  const t = task.value
  if (t?.status !== 'running' || !t.actualGpus?.length || !t.gpuIndices?.length) return null
  if (t.actualGpus.some(g => !t.gpuIndices.includes(g))) return null
  const idle = t.gpuIndices.filter(g => !t.actualGpus.includes(g))
  return idle.length ? idle.join('、') : null
})

const assignedGpus = computed(() =>
  task.value?.gpuIndices?.length ? `GPU ${task.value.gpuIndices.join('、')}` : '—'
)

const memDemand = computed(() => {
  const mems = task.value?.gpuMems
  if (!mems?.length) return '—'
  return mems.length === 1 ? formatMb(mems[0]) : mems.map(formatMb).join(' + ')
})

const peakDisplay = computed(() => {
  const t = task.value
  if (!t?.peakMemMb) return formatMb(t?.peakMemMb)
  const perGpu = t.peakMemPerGpu
  return perGpu?.length > 1 ? perGpu.map(formatMb).join(' + ') : formatMb(t.peakMemMb)
})

const attemptOptions = computed(() =>
  (detail.value?.attempts ?? []).map(a => ({
    label: `第 ${a.attemptNo} 次 · ${outcomeLabel(a.outcome)} · ${formatBytes(a.logSize)}`,
    value: a.attemptNo
  }))
)

function outcomeLabel (outcome) {
  return {
    succeeded: '成功',
    failed: '失败',
    oom_requeue: '抢卡失败已重排',
    killed: '被停止',
    timeout: '超时',
    unknown: '结果未知'
  }[outcome] ?? '运行中'
}

async function load () {
  try {
    detail.value = await api.getTask(props.id)
    const attempts = detail.value.attempts
    if (selectedAttempt.value === null && attempts.length) {
      selectedAttempt.value = attempts[attempts.length - 1].attemptNo
    }
  } catch (err) {
    message.error(err.message)
    router.push('/')
  } finally {
    loading.value = false
  }
}

// 详情页的结构性信息（尝试次数、结束时间）随全局任务流变化而重取
watch(() => state.tasks.find(t => t.id === Number(props.id)), (next, prev) => {
  if (!prev || !next) return
  if (next.status !== prev.status || next.attemptCount !== prev.attemptCount) load()
})

onMounted(() => {
  load()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => clearInterval(ticker))

async function stopTask () {
  try {
    const r = await api.stopTask(task.value.id)
    message.success(r.message)
    await load()
  } catch (err) {
    message.error(err.message)
  }
}

async function requeueTask () {
  try {
    await api.requeueTask(task.value.id)
    message.success('已重新排队')
    selectedAttempt.value = null
    await load()
  } catch (err) {
    message.error(err.message)
  }
}

function removeTask () {
  dialog.warning({
    title: '删除任务',
    content: `确定删除 #${task.value.id}「${task.value.name}」？日志文件会一并删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await api.deleteTask(task.value.id)
      message.success('已删除')
      router.push('/')
    }
  })
}

function openEdit () {
  formMode.value = 'edit'
  showForm.value = true
}
function openClone () {
  formMode.value = 'clone'
  showForm.value = true
}
function onSaved (saved) {
  if (formMode.value === 'clone') router.push(`/task/${saved.id}`)
  else load()
}

const envEntries = computed(() => Object.entries(task.value?.env ?? {}))
</script>

<template>
  <n-layout style="min-height: 100vh;">
    <n-layout-header bordered class="header">
      <n-space align="center" :size="12">
        <n-button size="small" quaternary @click="router.push('/')">← 返回</n-button>
        <template v-if="task">
          <n-tag :type="meta.type" size="small" :bordered="false">{{ meta.label }}</n-tag>
          <n-text strong style="font-size: 15px;">#{{ task.id }} {{ task.name }}</n-text>
        </template>
      </n-space>

      <n-space v-if="task" :size="6">
        <n-button v-if="['running','pending','blocked'].includes(task.status)" size="small" @click="stopTask">
          {{ isRunning ? '停止' : '取消' }}
        </n-button>
        <n-button v-else size="small" @click="requeueTask">重新排队</n-button>
        <n-button v-if="!isRunning" size="small" quaternary @click="openEdit">编辑</n-button>
        <n-button size="small" quaternary @click="openClone">克隆</n-button>
        <n-button v-if="!isRunning" size="small" quaternary type="error" @click="removeTask">删除</n-button>
      </n-space>
    </n-layout-header>

    <n-layout-content class="content">
      <n-spin :show="loading">
        <template v-if="task">
          <n-alert v-if="gpuDrift" type="error" title="分流被绕过" style="margin-bottom: 16px;">
            调度器把它分配到 <strong>{{ assignedGpus }}</strong>，但 nvidia-smi 观测到它还占用了
            <strong>GPU {{ gpuDrift }}</strong>。
            常见原因：工作目录下的 .env 设置了 CUDA_VISIBLE_DEVICES 且以覆盖方式加载
            （<n-text code>load_dotenv(override=True)</n-text>、<n-text code>source .env</n-text>、direnv），
            或代码里硬编码了卡号。此时显存账本对涉及的卡的记账都已不可信。
          </n-alert>

          <n-alert v-else-if="partialUse" type="warning" title="申请的卡没用满" style="margin-bottom: 16px;">
            这个任务分配到 <strong>{{ assignedGpus }}</strong>，但只在其中一部分上观测到显存占用，
            <strong>GPU {{ partialUse }}</strong> 被预留着却闲置。
            常见原因是 <n-text code>device_map="auto"</n-text> 发现模型塞得下就没用第二张卡——
            这种情况把它改成更少的卡数即可。
            若那张在用的卡实际占用远超声明值，则更可能是 .env 把 CUDA_VISIBLE_DEVICES 覆盖成了单卡。
          </n-alert>

          <n-alert v-if="task.failReason" :type="task.status === 'failed' ? 'error' : 'warning'" style="margin-bottom: 16px;">
            {{ task.failReason }}
          </n-alert>

          <n-grid :cols="4" :x-gap="12" style="margin-bottom: 16px;">
            <n-gi>
              <n-statistic label="运行时长" :value="elapsed !== null ? formatDuration(elapsed) : '—'" />
            </n-gi>
            <n-gi>
              <n-statistic label="分配 GPU" :value="assignedGpus" />
            </n-gi>
            <n-gi>
              <n-statistic :label="task.gpuMems?.length > 1 ? '显存需求（每卡）' : '显存需求'" :value="memDemand" />
            </n-gi>
            <n-gi>
              <n-statistic :label="task.peakMemPerGpu?.length > 1 ? '实测峰值（每卡）' : '实测峰值'" :value="peakDisplay" />
            </n-gi>
          </n-grid>

          <n-card size="small" title="配置" style="margin-bottom: 16px;">
            <n-descriptions :column="2" label-placement="left" size="small" bordered>
              <n-descriptions-item label="工作目录">
                <n-text code>{{ task.cwd }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item label="尝试次数">
                {{ task.attemptCount }}
              </n-descriptions-item>
              <n-descriptions-item label="命令" :span="2">
                <n-text code style="white-space: pre-wrap; word-break: break-all;">{{ task.command }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item label="限定 GPU">
                {{ task.allowedGpus ? task.allowedGpus.map(i => `GPU ${i}`).join('、') : '不限' }}
              </n-descriptions-item>
              <n-descriptions-item label="超时设置">
                {{ task.timeoutSeconds ? `${task.timeoutSeconds} 秒` : '不限时' }}
              </n-descriptions-item>
              <n-descriptions-item label="创建时间">{{ formatTime(task.createdAt) }}</n-descriptions-item>
              <n-descriptions-item label="开始时间">{{ formatTime(task.startedAt) }}</n-descriptions-item>
              <n-descriptions-item label="结束时间">{{ formatTime(task.finishedAt) }}</n-descriptions-item>
              <n-descriptions-item label="退出码">
                {{ task.exitCode === null ? '—' : task.exitCode }}
              </n-descriptions-item>
              <n-descriptions-item v-if="envEntries.length" label="环境变量" :span="2">
                <div v-for="([k, v]) in envEntries" :key="k">
                  <n-text code>{{ k }}={{ v }}</n-text>
                </div>
              </n-descriptions-item>
              <n-descriptions-item v-if="detail.dependencies.length" label="前置任务" :span="2">
                <n-space :size="6">
                  <n-tag
                    v-for="d in detail.dependencies"
                    :key="d.id"
                    size="small"
                    :type="STATUS_META[d.status]?.type ?? 'default'"
                    style="cursor: pointer;"
                    @click="router.push(`/task/${d.id}`)"
                  >
                    #{{ d.id }} {{ d.name }}
                  </n-tag>
                </n-space>
              </n-descriptions-item>
              <n-descriptions-item v-if="detail.dependents.length" label="下游任务" :span="2">
                <n-space :size="6">
                  <n-tag
                    v-for="d in detail.dependents"
                    :key="d.id"
                    size="small"
                    :type="STATUS_META[d.status]?.type ?? 'default'"
                    style="cursor: pointer;"
                    @click="router.push(`/task/${d.id}`)"
                  >
                    #{{ d.id }} {{ d.name }}
                  </n-tag>
                </n-space>
              </n-descriptions-item>
            </n-descriptions>
          </n-card>

          <n-card size="small" title="日志">
            <template #header-extra>
              <!-- 每次重试都是独立文件：覆盖的话就永远看不到第一次为什么失败了 -->
              <n-select
                v-if="attemptOptions.length > 1"
                v-model:value="selectedAttempt"
                :options="attemptOptions"
                size="small"
                style="width: 280px;"
              />
            </template>

            <LogViewer
              v-if="selectedAttempt"
              :task-id="task.id"
              :attempt="selectedAttempt"
              :live="isRunning && selectedAttempt === task.attemptCount"
            />
            <n-empty v-else description="任务尚未开始，暂无日志" size="small" />
          </n-card>
        </template>
      </n-spin>
    </n-layout-content>

    <TaskForm
      v-if="task"
      v-model:show="showForm"
      :edit-task="formMode === 'edit' ? task : null"
      :clone-from="formMode === 'clone' ? task : null"
      @saved="onSaved"
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

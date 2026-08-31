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

const gpuDrift = computed(() => {
  const t = task.value
  if (!t?.actualGpus?.length || t.gpuIndex === null) return null
  if (t.actualGpus.includes(t.gpuIndex)) return null
  return t.actualGpus.join('、')
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
            调度器把它分配到 <strong>GPU {{ task.gpuIndex }}</strong>，但 nvidia-smi 观测到它实际运行在
            <strong>GPU {{ gpuDrift }}</strong> 上。
            常见原因：工作目录下的 .env 设置了 CUDA_VISIBLE_DEVICES 且以覆盖方式加载
            （<n-text code>load_dotenv(override=True)</n-text>、<n-text code>source .env</n-text>、direnv），
            或代码里硬编码了卡号。此时显存账本对这两张卡的记账都已不可信。
          </n-alert>

          <n-alert v-if="task.failReason" :type="task.status === 'failed' ? 'error' : 'warning'" style="margin-bottom: 16px;">
            {{ task.failReason }}
          </n-alert>

          <n-grid :cols="4" :x-gap="12" style="margin-bottom: 16px;">
            <n-gi>
              <n-statistic label="运行时长" :value="elapsed !== null ? formatDuration(elapsed) : '—'" />
            </n-gi>
            <n-gi>
              <n-statistic label="分配 GPU" :value="task.gpuIndex !== null ? `GPU ${task.gpuIndex}` : '—'" />
            </n-gi>
            <n-gi>
              <n-statistic label="显存需求" :value="formatMb(task.memRequiredMb)" />
            </n-gi>
            <n-gi>
              <n-statistic label="实测峰值" :value="formatMb(task.peakMemMb)" />
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

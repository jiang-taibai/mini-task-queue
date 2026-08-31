<script setup>
import { ref, computed, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { api, formatMb } from '../api.js'
import { state } from '../store.js'

const props = defineProps({
  show: { type: Boolean, default: false },
  // 传入表示编辑，为空表示新建
  editTask: { type: Object, default: null },
  // 克隆来源：预填全部字段但作为新任务提交
  cloneFrom: { type: Object, default: null }
})
const emit = defineEmits(['update:show', 'saved'])

const message = useMessage()
const submitting = ref(false)
const warnings = ref([])

const form = ref(blank())

function blank () {
  return {
    name: '',
    cwd: '',
    command: '',
    memGb: 8,
    allowedGpus: null,
    envRows: [],
    dependsOn: [],
    timeoutSeconds: null
  }
}

function fromTask (task, { isClone = false } = {}) {
  return {
    name: isClone ? `${task.name} 副本` : task.name,
    cwd: task.cwd,
    command: task.command,
    // 跑过一次之后就不用再猜显存了：拿实测峰值加 15% 余量作为建议值
    memGb: isClone && task.peakMemMb
      ? Math.round((task.peakMemMb * 1.15) / 1024 * 10) / 10
      : Math.round(task.memRequiredMb / 1024 * 10) / 10,
    allowedGpus: task.allowedGpus,
    envRows: Object.entries(task.env || {}).map(([key, value]) => ({ key, value })),
    dependsOn: isClone ? [] : task.dependsOn,
    timeoutSeconds: task.timeoutSeconds
  }
}

watch(() => props.show, show => {
  if (!show) return
  warnings.value = []
  if (props.editTask) form.value = fromTask(props.editTask)
  else if (props.cloneFrom) form.value = fromTask(props.cloneFrom, { isClone: true })
  else form.value = blank()
})

const title = computed(() => {
  if (props.editTask) return `编辑任务 #${props.editTask.id}`
  if (props.cloneFrom) return `克隆自 #${props.cloneFrom.id}`
  return '新建任务'
})

const peakHint = computed(() => {
  const src = props.cloneFrom ?? props.editTask
  if (!src?.peakMemMb) return null
  return `上次实测峰值 ${formatMb(src.peakMemMb)}，已按 ×1.15 预填`
})

const gpuOptions = computed(() =>
  state.gpu.devices.map(d => ({ label: `GPU ${d.index} · ${d.name}`, value: d.index }))
)

const dependencyOptions = computed(() =>
  state.tasks
    .filter(t => !props.editTask || t.id !== props.editTask.id)
    .map(t => ({ label: `#${t.id} ${t.name}`, value: t.id }))
)

function addEnvRow () {
  form.value.envRows.push({ key: '', value: '' })
}
function removeEnvRow (index) {
  form.value.envRows.splice(index, 1)
}

function buildPayload () {
  const env = {}
  for (const row of form.value.envRows) {
    const key = row.key.trim()
    if (key) env[key] = row.value
  }
  return {
    name: form.value.name.trim(),
    cwd: form.value.cwd.trim(),
    command: form.value.command.trim(),
    memRequiredMb: Math.round((form.value.memGb || 0) * 1024),
    allowedGpus: form.value.allowedGpus?.length ? form.value.allowedGpus : null,
    env,
    dependsOn: form.value.dependsOn ?? [],
    timeoutSeconds: form.value.timeoutSeconds || null
  }
}

async function submit () {
  submitting.value = true
  warnings.value = []
  try {
    const payload = buildPayload()
    const result = props.editTask
      ? await api.updateTask(props.editTask.id, payload)
      : await api.createTask(payload)

    warnings.value = result.warnings ?? []
    message.success(props.editTask ? '已保存' : `任务 #${result.task.id} 已加入队列`)

    // 有警告时留在表单上让用户看清楚，没有就直接关闭
    if (warnings.value.length === 0) emit('update:show', false)
    emit('saved', result.task)
  } catch (err) {
    message.error(err.message)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="max-width: 720px;"
    @update:show="v => emit('update:show', v)"
  >
    <n-form label-placement="top" size="small">
      <n-grid :cols="2" :x-gap="12">
        <n-gi>
          <n-form-item label="任务名称">
            <n-input v-model:value="form.name" placeholder="例如：llama3-lr3e5" />
          </n-form-item>
        </n-gi>
        <n-gi>
          <n-form-item label="显存需求（GB）">
            <n-input-number
              v-model:value="form.memGb"
              :min="0.1"
              :step="0.5"
              style="width: 100%;"
            />
          </n-form-item>
        </n-gi>
      </n-grid>

      <n-text v-if="peakHint" depth="3" style="font-size: 12px; display: block; margin: -8px 0 12px;">
        {{ peakHint }}
      </n-text>

      <n-form-item label="工作目录">
        <n-input v-model:value="form.cwd" placeholder="/home/you/projects/myexp" />
      </n-form-item>

      <n-form-item label="命令">
        <n-input
          v-model:value="form.command"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          placeholder="/home/you/miniconda3/envs/torch/bin/python train.py --lr 3e-5"
        />
      </n-form-item>
      <n-text depth="3" style="font-size: 12px; display: block; margin: -12px 0 16px; line-height: 1.6;">
        建议直接写 python 绝对路径，绕开 conda activate（非交互 shell 里它默认不可用）。<br />
        分流由 CUDA_VISIBLE_DEVICES 完成，代码中请统一使用 <n-text code>cuda:0</n-text>，不要硬编码卡号。
      </n-text>

      <n-grid :cols="2" :x-gap="12">
        <n-gi>
          <n-form-item label="限定 GPU（留空表示不限）">
            <n-select
              v-model:value="form.allowedGpus"
              multiple
              clearable
              :options="gpuOptions"
              placeholder="不限"
            />
          </n-form-item>
        </n-gi>
        <n-gi>
          <n-form-item label="前置任务（全部成功后才开始）">
            <n-select
              v-model:value="form.dependsOn"
              multiple
              clearable
              filterable
              :options="dependencyOptions"
              placeholder="无"
            />
          </n-form-item>
        </n-gi>
      </n-grid>

      <n-form-item label="最大运行时长（秒，留空表示不限）">
        <n-input-number
          v-model:value="form.timeoutSeconds"
          :min="1"
          clearable
          style="width: 100%;"
          placeholder="不限时"
        />
      </n-form-item>

      <n-form-item label="额外环境变量">
        <n-space vertical style="width: 100%;">
          <n-space v-for="(row, i) in form.envRows" :key="i" :size="8" align="center">
            <n-input v-model:value="row.key" placeholder="KEY" style="width: 200px;" />
            <n-input v-model:value="row.value" placeholder="value" style="width: 320px;" />
            <n-button quaternary size="small" @click="removeEnvRow(i)">删除</n-button>
          </n-space>
          <n-button dashed size="small" @click="addEnvRow">+ 添加环境变量</n-button>
        </n-space>
      </n-form-item>

      <n-alert v-if="warnings.length" type="warning" title="请注意">
        <div v-for="(w, i) in warnings" :key="i">{{ w }}</div>
      </n-alert>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <n-button @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submit">
          {{ editTask ? '保存' : '提交到队列' }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

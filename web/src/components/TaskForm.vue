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

// 本轮已经提交成功的任务。有警告时弹窗要留着让人读完，但表单此刻已经「用过了」——
// 不记住这个状态，再点一次提交就会建出一个重复任务，而「取消」看着又像能撤销。
const submitted = ref(null)

const form = ref(blank())

const toGb = mb => Math.round(mb / 1024 * 10) / 10

function blank () {
  return {
    name: '',
    cwd: '',
    command: '',
    // 每个元素是一张卡的需求（GB），下标即脚本里的 cuda:i
    memGbs: [8],
    allowedGpus: null,
    envRows: [],
    dependsOn: [],
    timeoutSeconds: null
  }
}

function fromTask (task, { isClone = false } = {}) {
  // 跑过一次之后就不用再猜显存了：拿实测峰值加 15% 余量作为建议值。
  // 峰值按槽位记录，所以逐个框各填各的——克隆时的物理卡号可能和上次完全不同，
  // 但脚本行为不变，cuda:0 上次吃多少这次就吃多少。
  const source = isClone && task.peakMemPerGpu?.length ? task.peakMemPerGpu : null
  const memGbs = source
    ? source.map(mb => toGb(mb * 1.15))
    : (task.gpuMems ?? [task.memRequiredMb]).map(toGb)

  return {
    name: isClone ? `${task.name} 副本` : task.name,
    cwd: task.cwd,
    command: task.command,
    memGbs,
    allowedGpus: task.allowedGpus,
    envRows: Object.entries(task.env || {}).map(([key, value]) => ({ key, value })),
    dependsOn: isClone ? [] : task.dependsOn,
    timeoutSeconds: task.timeoutSeconds
  }
}

watch(() => props.show, show => {
  if (!show) return
  warnings.value = []
  submitted.value = null
  if (props.editTask) form.value = fromTask(props.editTask)
  else if (props.cloneFrom) form.value = fromTask(props.cloneFrom, { isClone: true })
  else form.value = blank()
})

// 提交成功后要把「任务已经建好了」说明白，否则弹窗没关会让人以为提交失败
const warningTitle = computed(() => {
  if (!submitted.value) return '请注意'
  return props.editTask
    ? '已保存，但有几点需要注意'
    : `任务 #${submitted.value.id} 已加入队列，但有几点需要注意`
})

const title = computed(() => {
  if (props.editTask) return `编辑任务 #${props.editTask.id}`
  if (props.cloneFrom) return `克隆自 #${props.cloneFrom.id}`
  return '新建任务'
})

const peakHint = computed(() => {
  const src = props.cloneFrom ?? props.editTask
  if (!src?.peakMemMb) return null
  const perGpu = src.peakMemPerGpu
  if (perGpu?.length > 1) {
    const parts = perGpu.map((mb, i) => `cuda:${i} ${formatMb(mb)}`).join(' / ')
    return `上次实测峰值 ${parts}，已按 ×1.15 预填`
  }
  return `上次实测峰值 ${formatMb(src.peakMemMb)}，已按 ×1.15 预填`
})

const gpuOptions = computed(() =>
  state.gpu.devices.map(d => ({ label: `GPU ${d.index} · ${d.name}`, value: d.index }))
)

// 上限就是本机卡数：申请更多的话任务永远排不上，后端也会直接拒绝
const deviceCount = computed(() => Math.max(state.gpu.devices.length, 1))
const gpuCountOptions = computed(() =>
  Array.from({ length: deviceCount.value }, (_, i) => ({ label: `${i + 1} 张`, value: i + 1 }))
)

/** 加卡时复制第一个框的值——各卡需求相同是常态，省掉一次交互 */
function setGpuCount (count) {
  const next = form.value.memGbs.slice(0, count)
  while (next.length < count) next.push(form.value.memGbs[0] ?? 8)
  form.value.memGbs = next
}

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
    gpuMems: form.value.memGbs.map(gb => Math.round((gb || 0) * 1024)),
    allowedGpus: form.value.allowedGpus?.length ? form.value.allowedGpus : null,
    env,
    dependsOn: form.value.dependsOn ?? [],
    timeoutSeconds: form.value.timeoutSeconds || null
  }
}

async function submit () {
  if (submitted.value) return // 已经提交过了，再点就是重复建任务
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
    else submitted.value = result.task
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
          <n-form-item label="需要 GPU 数量">
            <n-select
              :value="form.memGbs.length"
              :options="gpuCountOptions"
              style="width: 100%;"
              @update:value="setGpuCount"
            />
          </n-form-item>
        </n-gi>
      </n-grid>

      <!-- 单卡时维持原来的单框外观，不给绝大多数任务增加认知负担 -->
      <n-form-item v-if="form.memGbs.length === 1" label="显存需求（GB）">
        <n-input-number v-model:value="form.memGbs[0]" :min="0.1" :step="0.5" style="width: 100%;" />
      </n-form-item>

      <!-- 多卡时把槽位语义摆在脸上：第 i 个框就是脚本里的 cuda:i -->
      <n-form-item v-else label="每张卡的显存需求（GB）">
        <n-space :size="12" style="width: 100%;">
          <div v-for="(_, i) in form.memGbs" :key="i">
            <n-text depth="3" style="font-size: 12px; display: block; margin-bottom: 4px;">
              cuda:{{ i }}
            </n-text>
            <n-input-number
              v-model:value="form.memGbs[i]"
              :min="0.1"
              :step="0.5"
              style="width: 140px;"
            />
          </div>
        </n-space>
      </n-form-item>

      <n-text
        v-if="form.memGbs.length > 1"
        depth="3"
        style="font-size: 12px; display: block; margin: -12px 0 12px; line-height: 1.6;"
      >
        每个框填的是<strong>单张卡</strong>的需求，不是总量。调度器会找一组满足各自门槛的卡，
        并按这个顺序设置 CUDA_VISIBLE_DEVICES——第一个框对应脚本里的
        <n-text code>cuda:0</n-text>。
      </n-text>

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
        <template v-if="form.memGbs.length === 1">
          分流由 CUDA_VISIBLE_DEVICES 完成，代码中请统一使用 <n-text code>cuda:0</n-text>，不要硬编码卡号。
        </template>
        <template v-else>
          分流由 CUDA_VISIBLE_DEVICES 完成，脚本只看得见
          <n-text code>cuda:0</n-text> 到 <n-text code>cuda:{{ form.memGbs.length - 1 }}</n-text>，
          物理卡号由调度器决定。用 <n-text code>device_map="auto"</n-text> 或 torchrun 让脚本自己铺开即可。
        </template>
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

      <n-alert v-if="warnings.length" type="warning" :title="warningTitle">
        <div v-for="(w, i) in warnings" :key="i">{{ w }}</div>
      </n-alert>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <!-- 提交成功后按钮整组换掉：此时「取消」撤销不了任何东西，
             而再点一次「提交到队列」会建出重复任务 -->
        <template v-if="submitted">
          <n-button type="primary" @click="emit('update:show', false)">知道了</n-button>
        </template>
        <template v-else>
          <n-button @click="emit('update:show', false)">取消</n-button>
          <n-button type="primary" :loading="submitting" @click="submit">
            {{ editTask ? '保存' : '提交到队列' }}
          </n-button>
        </template>
      </n-space>
    </template>
  </n-modal>
</template>

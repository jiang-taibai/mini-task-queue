<script setup>
import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import { useMessage } from 'naive-ui'
import { api, formatBytes } from '../api.js'

const props = defineProps({
  taskId: { type: [Number, String], required: true },
  attempt: { type: Number, required: true },
  live: { type: Boolean, default: false }
})

const message = useMessage()

const logRef = ref(null)
const content = ref('')
// 尚未换行的最后一行单独存放：进度条要原地刷新，不能一段段往后拼
const partial = ref('')
const startOffset = ref(0)
const endOffset = ref(0)
const fileSize = ref(0)
const loading = ref(false)
const follow = ref(true)

const displayed = computed(() => {
  const body = content.value + partial.value
  return body || '（暂无日志输出）'
})

const CHUNK = 200 * 1024

let stream = null

function closeStream () {
  if (stream) {
    stream.close()
    stream = null
  }
}

async function loadTail () {
  loading.value = true
  try {
    // 默认只取末尾一段：训练日志一夜能到几个 G，整个塞进浏览器会把标签页搞崩
    const res = await api.logs(props.taskId, { attempt: props.attempt, maxBytes: CHUNK })
    const lastBreak = res.content.lastIndexOf('\n')
    content.value = lastBreak >= 0 ? res.content.slice(0, lastBreak + 1) : ''
    partial.value = lastBreak >= 0 ? res.content.slice(lastBreak + 1) : res.content
    startOffset.value = res.start
    endOffset.value = res.end
    fileSize.value = res.size
    await nextTick()
    scrollToBottom()
  } catch (err) {
    message.error(`日志加载失败：${err.message}`)
  } finally {
    loading.value = false
  }
}

async function loadEarlier () {
  if (startOffset.value <= 0 || loading.value) return
  loading.value = true
  try {
    const from = Math.max(0, startOffset.value - CHUNK)
    const res = await api.logs(props.taskId, {
      attempt: props.attempt,
      offset: from,
      maxBytes: startOffset.value - from
    })
    content.value = res.content + content.value
    startOffset.value = res.start
    fileSize.value = res.size
  } catch (err) {
    message.error(err.message)
  } finally {
    loading.value = false
  }
}

function scrollToBottom () {
  logRef.value?.scrollTo({ position: 'bottom', silent: true })
}

function openStream () {
  closeStream()
  if (!props.live) return

  const params = new URLSearchParams({ attempt: props.attempt, offset: endOffset.value })
  stream = new EventSource(`/api/tasks/${props.taskId}/logs/stream?${params}`)

  stream.addEventListener('append', e => {
    const payload = JSON.parse(e.data)
    content.value += payload.content
    partial.value = payload.partial ?? ''
    endOffset.value = payload.offset
    fileSize.value = payload.size
    if (follow.value) nextTick(scrollToBottom)
  })
}

watch(
  () => [props.taskId, props.attempt],
  async () => {
    closeStream()
    await loadTail()
    openStream()
  },
  { immediate: true }
)

watch(() => props.live, live => {
  if (live) openStream()
  else closeStream()
})

onUnmounted(closeStream)

defineExpose({ reload: loadTail })
</script>

<template>
  <div>
    <n-space align="center" justify="space-between" style="margin-bottom: 8px;">
      <n-space align="center" :size="10">
        <n-text depth="3" style="font-size: 12px;">
          文件 {{ formatBytes(fileSize) }}
          <template v-if="startOffset > 0">
            · 已加载末尾 {{ formatBytes(fileSize - startOffset) }}
          </template>
        </n-text>
        <n-button v-if="startOffset > 0" size="tiny" quaternary :loading="loading" @click="loadEarlier">
          加载更早的 {{ formatBytes(Math.min(CHUNK, startOffset)) }}
        </n-button>
      </n-space>

      <n-space align="center" :size="10">
        <n-checkbox v-if="live" v-model:checked="follow" size="small">自动滚动</n-checkbox>
        <n-button size="tiny" quaternary :loading="loading" @click="loadTail">刷新</n-button>
      </n-space>
    </n-space>

    <n-log
      ref="logRef"
      :log="displayed"
      :rows="26"
      :font-size="12"
      :line-height="1.5"
      trim
      @require-more="from => from === 'top' && loadEarlier()"
    />

    <n-text depth="3" style="font-size: 11px; display: block; margin-top: 6px;">
      日志已剥离 ANSI 控制符，并把 tqdm 之类的回车覆盖折叠为最终状态。
    </n-text>
  </div>
</template>

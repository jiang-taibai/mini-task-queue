<script setup>
import { computed } from 'vue'
import { formatMb, formatDuration, formatTime, STATUS_META } from '../api.js'

const props = defineProps({
  task: { type: Object, required: true },
  draggable: { type: Boolean, default: false },
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['stop', 'edit', 'clone', 'remove', 'requeue'])

const meta = computed(() => STATUS_META[props.task.status] ?? { label: props.task.status, type: 'default' })

const elapsed = computed(() => {
  const t = props.task
  if (t.status === 'running' && t.startedAt) return props.now - t.startedAt
  if (t.startedAt && t.finishedAt) return t.finishedAt - t.startedAt
  return null
})

// 队列里的等待时长要显眼：严格门控下一个排不上的任务会挡住所有人，
// 你需要一眼看出该不该插手。
//
// 从 queuedAt 而不是 createdAt 算起：重新排队的任务是刚排上队的，
// 按创建时间算会显示「已等待 20 小时」，把真正该关注的队头淹掉
const waiting = computed(() => {
  const t = props.task
  if (t.status !== 'pending' && t.status !== 'blocked') return null
  return props.now - (t.queuedAt ?? t.createdAt)
})

const isActive = computed(() => ['running', 'pending', 'blocked'].includes(props.task.status))

// 跑到分配集合之外的卡上 = 分流被绕过（多半是 .env 覆盖了 CUDA_VISIBLE_DEVICES）。
// 只用了分配集合里的一部分不算漂移，那是「声明多了」，后端另有提示。
const gpuDrift = computed(() => {
  const t = props.task
  if (!t.actualGpus?.length || !t.gpuIndices?.length) return null
  const strays = t.actualGpus.filter(g => !t.gpuIndices.includes(g))
  return strays.length ? strays.join('、') : null
})

const assignedGpus = computed(() => props.task.gpuIndices?.join('、') ?? '')

const memDemand = computed(() => {
  const mems = props.task.gpuMems ?? [props.task.memRequiredMb]
  if (mems.length === 0) return '纯 CPU'
  return mems.length === 1
    ? `需 ${formatMb(mems[0])}`
    : `需 ${mems.length} 卡 · ${mems.map(formatMb).join(' + ')}`
})
</script>

<template>
  <n-card size="small" class="task-card" :class="{ 'is-running': task.status === 'running' }">
    <div class="row">
      <div v-if="draggable" class="drag-handle" title="拖动以调整顺序">⋮⋮</div>

      <n-tag :type="meta.type" size="small" :bordered="false">{{ meta.label }}</n-tag>

      <!-- 用真链接而不是 @click=router.push：RouterLink 内部会放行带 ctrl/cmd/shift
           的点击，交给浏览器原生处理，于是「新标签页打开」这个肌肉记忆能用 -->
      <router-link class="name" :to="`/task/${task.id}`">
        <n-text depth="3">#{{ task.id }}</n-text>
        {{ task.name }}
      </router-link>

      <n-space :size="14" align="center" class="facts">
        <n-text v-if="assignedGpus && task.status === 'running'" depth="2">
          GPU {{ assignedGpus }}
        </n-text>
        <n-text depth="3">{{ memDemand }}</n-text>
        <n-text v-if="elapsed !== null" depth="3">
          {{ task.status === 'running' ? '已运行' : '耗时' }} {{ formatDuration(elapsed) }}
        </n-text>
        <n-text v-if="waiting !== null" depth="3">已等待 {{ formatDuration(waiting) }}</n-text>
        <n-text v-if="task.attemptCount > 1" depth="3">第 {{ task.attemptCount }} 次尝试</n-text>
      </n-space>

      <n-space :size="4" class="actions">
        <n-button v-if="isActive" size="tiny" quaternary @click="emit('stop', task)">
          {{ task.status === 'running' ? '停止' : '取消' }}
        </n-button>
        <n-button v-if="!isActive" size="tiny" quaternary @click="emit('requeue', task)">
          重新排队
        </n-button>
        <n-button v-if="task.status !== 'running'" size="tiny" quaternary @click="emit('edit', task)">
          编辑
        </n-button>
        <n-button size="tiny" quaternary @click="emit('clone', task)">克隆</n-button>
        <router-link v-slot="{ href, navigate }" :to="`/task/${task.id}`" custom>
          <n-button size="tiny" quaternary tag="a" :href="href" @click="navigate">详情</n-button>
        </router-link>
        <n-button
          v-if="task.status !== 'running'"
          size="tiny"
          quaternary
          type="error"
          @click="emit('remove', task)"
        >
          删除
        </n-button>
      </n-space>
    </div>

    <div v-if="gpuDrift" class="reason">
      <n-text type="error" style="font-size: 12px;">
        ⚠ 分配到 GPU {{ assignedGpus }}，实际却占用了 GPU {{ gpuDrift }}——
        分流被绕过，请检查 .env 或代码里的卡号设置
      </n-text>
    </div>

    <div v-if="task.failReason" class="reason">
      <n-text :depth="task.status === 'pending' ? 3 : 2" style="font-size: 12px;">
        {{ task.failReason }}
      </n-text>
    </div>
    <div v-if="task.status === 'blocked' && task.dependsOn.length" class="reason">
      <n-text depth="3" style="font-size: 12px;">
        等待前置任务 {{ task.dependsOn.map(id => '#' + id).join('、') }} 完成
      </n-text>
    </div>
  </n-card>
</template>

<style scoped>
.task-card {
  margin-bottom: 8px;
}
.is-running {
  border-left: 3px solid var(--n-color-target, #63e2b7);
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.drag-handle {
  cursor: grab;
  opacity: 0.4;
  font-size: 14px;
  letter-spacing: -2px;
  user-select: none;
}
.drag-handle:active {
  cursor: grabbing;
}
.name {
  font-weight: 500;
  cursor: pointer;
  flex: 1;
  min-width: 140px;
}
.name:hover {
  text-decoration: underline;
}
.facts {
  font-size: 12px;
}
.actions {
  margin-left: auto;
}
.reason {
  margin-top: 6px;
  padding-left: 4px;
}
</style>

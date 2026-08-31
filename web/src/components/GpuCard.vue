<script setup>
import { computed } from 'vue'
import { formatMb } from '../api.js'

const props = defineProps({
  device: { type: Object, required: true },
  processes: { type: Array, default: () => [] },
  reservedMb: { type: Number, default: 0 },
  stale: { type: Boolean, default: false },
  processesAvailable: { type: Boolean, default: true }
})

const usedPercent = computed(() =>
  Math.round((props.device.memUsedMb / props.device.memTotalMb) * 100)
)

// 调度器眼里的可用量：读数上的空闲再扣掉账本里的预留。
// 预热期内任务还没吃上显存，但那块空间已经名花有主。
const effectiveFreeMb = computed(() =>
  Math.max(0, props.device.memFreeMb - props.reservedMb)
)

const barStatus = computed(() => {
  if (props.stale) return 'warning'
  if (usedPercent.value >= 90) return 'error'
  if (usedPercent.value >= 60) return 'warning'
  return 'success'
})

const myProcesses = computed(() => props.processes.filter(p => p.taskId !== null))
const otherProcesses = computed(() => props.processes.filter(p => p.taskId === null))
const otherMemMb = computed(() => otherProcesses.value.reduce((s, p) => s + p.usedMemoryMb, 0))
</script>

<template>
  <n-card size="small" :class="{ 'gpu-stale': stale }">
    <template #header>
      <n-space align="center" :size="8">
        <n-tag :bordered="false" size="small" type="info">GPU {{ device.index }}</n-tag>
        <n-text style="font-size: 13px;">{{ device.name }}</n-text>
      </n-space>
    </template>
    <template #header-extra>
      <n-text depth="3" style="font-size: 12px;">
        利用率 {{ device.utilization ?? '—' }}%
      </n-text>
    </template>

    <n-progress
      type="line"
      :percentage="usedPercent"
      :status="barStatus"
      :height="14"
      :border-radius="4"
      indicator-placement="inside"
    />

    <n-space justify="space-between" style="margin-top: 10px; font-size: 12px;">
      <n-text depth="3">
        已用 {{ formatMb(device.memUsedMb) }} / {{ formatMb(device.memTotalMb) }}
      </n-text>
      <n-text :type="effectiveFreeMb > 0 ? 'success' : 'default'">
        可派发 {{ formatMb(effectiveFreeMb) }}
      </n-text>
    </n-space>

    <n-text v-if="reservedMb > 0" depth="3" style="font-size: 11px; display: block; margin-top: 4px;">
      其中 {{ formatMb(reservedMb) }} 已被刚启动的任务预留（预热期内显存尚未计入读数）
    </n-text>

    <n-divider style="margin: 12px 0 8px;" />

    <div v-if="!processesAvailable">
      <n-text depth="3" style="font-size: 12px;">
        进程信息不可用（WSL2 等环境的已知限制）
      </n-text>
    </div>
    <div v-else-if="processes.length === 0">
      <n-text depth="3" style="font-size: 12px;">卡上暂无计算进程</n-text>
    </div>
    <n-space v-else vertical :size="4">
      <div v-for="p in myProcesses" :key="p.pid" class="proc-line">
        <n-tag size="tiny" type="success" :bordered="false">我的</n-tag>
        <router-link :to="`/task/${p.taskId}`" class="proc-link">
          #{{ p.taskId }} {{ p.taskName }}
        </router-link>
        <n-text depth="3">{{ formatMb(p.usedMemoryMb) }}</n-text>
      </div>
      <div v-if="otherProcesses.length > 0" class="proc-line">
        <n-tag size="tiny" :bordered="false">他人</n-tag>
        <n-text depth="2">{{ otherProcesses.length }} 个进程</n-text>
        <n-text depth="3">{{ formatMb(otherMemMb) }}</n-text>
      </div>
    </n-space>
  </n-card>
</template>

<style scoped>
.gpu-stale {
  opacity: 0.6;
}
.proc-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.proc-line > :last-child {
  margin-left: auto;
}
.proc-link {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px dashed currentColor;
}
</style>

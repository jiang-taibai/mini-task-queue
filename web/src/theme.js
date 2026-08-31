import { ref, computed } from 'vue'
import { darkTheme } from 'naive-ui'

const STORAGE_KEY = 'mtq-theme'

// 默认暗色：盯训练日志多半是在晚上，而且深色底更适合长时间看等宽日志
export const themeMode = ref(localStorage.getItem(STORAGE_KEY) || 'dark')

export const naiveTheme = computed(() => (themeMode.value === 'dark' ? darkTheme : null))

export const isDark = computed(() => themeMode.value === 'dark')

export function toggleTheme () {
  themeMode.value = themeMode.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem(STORAGE_KEY, themeMode.value)
}

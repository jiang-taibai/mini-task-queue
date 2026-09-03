import { ref, watch } from 'vue'

/**
 * 存在 localStorage 里的界面偏好。
 *
 * 这些状态每次刷新都被打回默认值会很烦——尤其是「展开已结束」这种，
 * 你正在逐个翻结果，刷新一下整栏就收起来了。
 *
 * 读失败一律回退到默认值：存坏了（手改过、跨版本格式变了）不该让界面炸掉。
 */
export function persistedRef (key, defaultValue) {
  const state = ref(load(key, defaultValue))
  watch(state, v => {
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch { /* 隐私模式或配额满，偏好丢了就丢了，不影响使用 */ }
  })
  return state
}

function load (key, defaultValue) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return defaultValue
    const parsed = JSON.parse(raw)
    // 类型对不上就当没存过，避免旧版本写的值把组件搞崩
    return typeof parsed === typeof defaultValue ? parsed : defaultValue
  } catch {
    return defaultValue
  }
}

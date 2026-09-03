<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import monaco from '../monaco.js'
import { isDark } from '../theme.js'

/**
 * 命令输入框。
 *
 * 用编辑器而不是 textarea，是为了消除一处真实的歧义：textarea 里「文本溢出自动
 * 折行」和「你敲了回车」看起来完全一样。多行命令是被支持的（服务端把它原样嵌进
 * 多行 bash 脚本逐行执行），所以断开的参数续行不会报错，只会让 `--batch 32`
 * 变成一条找不到的命令——错误信息离原因很远。
 *
 * 三个选项直接对着这个问题：wordWrap 关掉（看到的换行一定是硬换行）、
 * lineNumbers 打开（一眼看出几行）、renderWhitespace 全开（空格和制表符可见）。
 */
const props = defineProps({
  value: { type: String, default: '' },
  minRows: { type: Number, default: 3 },
  maxRows: { type: Number, default: 12 },
  // 只读模式给详情页看命令用：同一套高亮与空格显示，只是不能改
  readonly: { type: Boolean, default: false }
})
const emit = defineEmits(['update:value'])

const LINE_HEIGHT = 19

const host = ref(null)
const height = ref(props.minRows * LINE_HEIGHT + 12)
let editor = null

const lineCount = computed(() => (props.value === '' ? 0 : props.value.split('\n').length))

/**
 * 找出看着像「参数续行被拆断了」的行。
 *
 * 判据是：上一行没有以 \ 结尾（那是正当的续行），而这一行以 - 开头。
 * bash 会把它当成独立命令去执行，报的是 command not found，跟真正的原因
 * ——你在编辑器里敲了个回车——完全对不上。
 *
 * 只提示不拦截：多行命令本身是合法用法。
 */
const danglingLines = computed(() => {
  const lines = props.value.split('\n')
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].trimEnd()
    if (prev.endsWith('\\') || prev === '') continue
    if (/^\s*-/.test(lines[i])) out.push(i + 1)
  }
  return out
})

function syncHeight () {
  if (!editor) return
  const lines = Math.min(Math.max(editor.getModel()?.getLineCount() ?? 1, props.minRows), props.maxRows)
  height.value = lines * LINE_HEIGHT + 12
  editor.layout()
}

onMounted(() => {
  editor = monaco.editor.create(host.value, {
    value: props.value,
    language: 'shell',
    theme: isDark.value ? 'vs-dark' : 'vs',
    readOnly: props.readonly,
    // 只读时去掉光标和当前行高亮，否则看着像可以编辑
    domReadOnly: props.readonly,
    renderLineHighlight: props.readonly ? 'none' : 'line',
    lineNumbers: 'on',
    wordWrap: 'off',            // 关掉软折行：看到的换行一定是你敲出来的
    renderWhitespace: 'all',    // 空格/制表符可见
    renderControlCharacters: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,      // 弹窗里尺寸会变，交给它自己跟
    overviewRulerLanes: 0,
    folding: false,
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 4,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
    padding: { top: 6, bottom: 6 },
    scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    tabSize: 2
  })

  editor.onDidChangeModelContent(() => {
    emit('update:value', editor.getValue())
    syncHeight()
  })
  syncHeight()
})

onBeforeUnmount(() => {
  editor?.getModel()?.dispose()
  editor?.dispose()
  editor = null
})

// 外部改值（编辑/克隆时预填）要同步进来，但不能打断正在输入的人
watch(() => props.value, v => {
  if (editor && v !== editor.getValue()) {
    editor.setValue(v ?? '')
    syncHeight()
  }
})

watch(isDark, v => monaco.editor.setTheme(v ? 'vs-dark' : 'vs'))
</script>

<template>
  <div class="wrap">
    <div ref="host" class="editor" :style="{ height: height + 'px' }" />

    <div v-if="!readonly" class="status">
      <n-text depth="3" style="font-size: 12px;">
        共 {{ lineCount }} 行<template v-if="lineCount > 1">，将按多行 shell 脚本逐行执行</template>
      </n-text>
    </div>

    <n-text
      v-if="!readonly && danglingLines.length"
      type="error"
      style="font-size: 12px; display: block; margin-top: 2px;"
    >
      ⚠ 第 {{ danglingLines.join('、') }} 行以 <n-text code>-</n-text> 开头，
      上一行却没有用 <n-text code>\</n-text> 续行——它会被当成一条独立命令执行并报
      command not found。要接上一行，请删掉这个换行，或在上一行末尾加
      <n-text code>\</n-text>。
    </n-text>
  </div>
</template>

<style scoped>
/* n-form-item 的内容区是 flex 容器，子元素不会自动撑满——不写这条，
   编辑器只会占内容的自然宽度，缩成窄窄一条 */
.wrap {
  width: 100%;
  min-width: 0;
}
.editor {
  width: 100%;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.3));
  border-radius: 3px;
  overflow: hidden;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
</style>

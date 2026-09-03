/**
 * Monaco 的裁剪装配。
 *
 * 关键是不要 `import * as monaco from 'monaco-editor'`——那个 barrel 会把全部语言
 * 和特性拉进包里。这里只取核心 API，语言只挂 shell 一个。
 *
 * 也因此只需要 editor.worker：shell 高亮走 Monarch（在主线程跑正则），
 * 不涉及 ts/json/css/html 那几个语言服务 worker，vite-plugin-monaco-editor 用不上。
 */
// 路径按 monaco-editor 0.56 的 exports map（"./*" -> "./esm/vs/*.js"）来写，
// 网上多数示例里的 'monaco-editor/esm/vs/...' 在这个版本会被解析成 esm/vs/esm/vs/...
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/shell/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export default monaco

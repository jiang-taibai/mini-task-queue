import hljs from 'highlight.js/lib/core'

/**
 * 训练日志的高亮规则。
 *
 * 只引 highlight.js 的 core，一个内置语言定义都不加载——我们要的不是某种编程
 * 语言的语法，而是「一眼扫到 ERROR 在哪、哪一行是几点、报错涉及哪个文件」。
 * naive-ui 的 n-log 原生支持传 language + hljs，官方示例给的就是这种自定义 log 语言。
 *
 * className 沿用 hljs 的标准类名，这样直接吃 naive-ui 内置的代码配色，
 * 明暗主题都跟着走，不用额外引一套 hljs 主题 CSS。
 *
 * 日志在服务端已经剥离了 ANSI 控制符，原始颜色信息不存在，只能靠正则重建。
 */
hljs.registerLanguage('mtq-log', () => ({
  case_insensitive: false,
  contains: [
    // 时间戳：2026-09-04 12:30:00 / 2026-09-04T12:30:00 / [12:30:00]
    {
      className: 'built_in',
      begin: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/
    },
    {
      className: 'built_in',
      begin: /\[\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]/
    },

    // 出错。大小写敏感是有意的：正文里的 "error rate"、"failed to converge"
    // 这类词组不该被染红，真正的日志级别一律是大写
    {
      className: 'deletion',
      begin: /\b(?:ERROR|CRITICAL|FATAL|Traceback \(most recent call last\)|[A-Za-z_]*Error|[A-Za-z_]*Exception)\b/
    },
    {
      className: 'attr',
      begin: /\b(?:WARN|WARNING)\b/
    },
    {
      className: 'comment',
      begin: /\b(?:INFO|DEBUG|TRACE|NOTSET)\b/
    },

    // 文件路径。带扩展名的优先，纯目录要求至少两级，避免把命令里的 a/b 也染上
    {
      className: 'string',
      begin: /(?:\/[\w.@-]+)+\.(?:py|json|ya?ml|txt|log|csv|pt|pth|ckpt|safetensors|sh|toml|cfg)\b/
    },
    {
      className: 'string',
      begin: /(?:\/[\w.@-]+){2,}\/?(?=[\s:,)]|$)/
    },

    // 百分比与带单位的数字：进度条和显存读数扫起来快很多
    {
      className: 'number',
      begin: /\b\d+(?:\.\d+)?\s*(?:%|it\/s|s\/it|MiB|GiB|MB|GB|KB|ms)\b/
    },
    {
      className: 'number',
      begin: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/
    }
  ]
}))

export default hljs

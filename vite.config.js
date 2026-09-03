import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  build: {
    // 构建进后端的静态目录：生产环境单端口单进程，不用配反代也不用处理跨域
    outDir: '../server/public',
    emptyOutDir: true,
    // Monaco 那个 chunk 就是 2.6 MB，压过之后 673 KB。它已经被拆成独立 chunk
    // 并且只在新建/编辑任务的弹窗里按需加载，首屏不受影响——默认的 500 KB
    // 警告线在这里只会每次构建刷一遍屏，让人误以为哪里出了问题
    chunkSizeWarningLimit: 3000
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT || 3000}`,
        changeOrigin: false,
        // SSE 需要关闭代理层缓冲，否则事件会被攒着一起发
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-no-compression'] = '1'
            }
          })
        }
      }
    }
  }
})

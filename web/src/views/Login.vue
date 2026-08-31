<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useMessage } from 'naive-ui'
import { api } from '../api.js'
import { state, checkAuth } from '../store.js'

const router = useRouter()
const route = useRoute()
const message = useMessage()

const password = ref('')
const loading = ref(false)

async function submit () {
  if (!password.value) return
  loading.value = true
  try {
    await api.login(password.value)
    await checkAuth()
    if (state.authenticated) {
      router.replace(route.query.redirect || '/')
    }
  } catch (err) {
    message.error(err.message)
    password.value = ''
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <n-card class="login-card" title="GPU 任务队列">
      <n-space vertical size="large">
        <n-input
          v-model:value="password"
          type="password"
          show-password-on="mousedown"
          placeholder="登录密码"
          size="large"
          :disabled="loading"
          @keyup.enter="submit"
        />
        <n-button type="primary" size="large" block :loading="loading" @click="submit">
          登录
        </n-button>
        <n-text depth="3" style="font-size: 12px; line-height: 1.7;">
          本服务可以你的系统账号身份执行任意命令。若从外网访问，请确认流量已经过
          HTTPS 加密——内网直连为明文传输。
        </n-text>
      </n-space>
    </n-card>
  </div>
</template>

<style scoped>
.login-wrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.login-card {
  max-width: 400px;
  width: 100%;
}
</style>

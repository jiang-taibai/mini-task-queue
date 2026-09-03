<script setup>
import { zhCN, dateZhCN } from 'naive-ui'
import { naiveTheme } from './theme.js'
import hljs from './logHighlight.js'
</script>

<template>
  <!-- hljs 只注册了 mtq-log 这一个自定义语言，供 n-log 给训练日志上色 -->
  <n-config-provider :theme="naiveTheme" :locale="zhCN" :date-locale="dateZhCN" :hljs="hljs">
    <n-global-style />
    <n-loading-bar-provider>
      <n-notification-provider :max="3">
        <n-message-provider :max="4">
          <n-dialog-provider>
            <router-view />
          </n-dialog-provider>
        </n-message-provider>
      </n-notification-provider>
    </n-loading-bar-provider>
  </n-config-provider>
</template>

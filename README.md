# mini-task-queue

面向单用户的 **GPU 任务队列**：提交实验任务并手动排序，系统持续监控显存，一旦满足需求就自动分配空闲卡、注入 `CUDA_VISIBLE_DEVICES` 并后台启动，全程记录日志。

为「多人共享、全天候满载」的服务器设计——在这种环境下，空闲显存是转瞬即逝的事件，需要 1 秒级监控 + 乐观抢占。

## 核心设计

| 维度 | 决策 |
|---|---|
| 抢占策略 | **乐观抢占**：单次采样满足即启动，不去抖。失败自动重排队（≤3 次） |
| 资源模型 | **声明式需求**（`1 卡 / ≥X GB`），调度器选卡后自动注入 `CUDA_VISIBLE_DEVICES` |
| 队列语义 | **严格门控**：队头排不上则全员等待。手动拖拽排序 = 硬承诺 |
| 自伤防护 | **软预留账本** + 60 秒预热期，杜绝同一拍向同一张卡派两个任务 |
| 进程隔离 | `detached` 独立进程组，SSH 断开 / 服务重启 / 崩溃都不影响运行中的任务 |
| 监控 | 常驻 `nvidia-smi -l 1` 流式进程；**失联 5 秒即暂停全部调度** |

## 技术栈

- 后端：Node.js 24 + Express + `node:sqlite`（内置，零额外依赖）
- 前端：Vue 3 + Naive UI + Vite
- 实时：SSE 双流（状态/GPU 一条，日志增量一条）

## 快速开始

```bash
npm install
npm run setup        # 交互式设置登录密码
npm run build        # 构建前端
npm start            # 启动（建议放进 tmux 或 nohup）
```

开发模式：

```bash
npm run dev          # 后端 + Vite dev server
```

单卡机器上开发双卡调度逻辑，用 Mock GPU 数据源：

```bash
GPU_SOURCE=mock npm run dev
```

## 安全说明

服务默认监听 `0.0.0.0`，**它能以你的身份执行任意 shell 命令**。已实现：scrypt 密码哈希、httpOnly Cookie 会话、CSRF 双重防护（SameSite + Origin 校验）、登录失败限流。

内网为 HTTP 明文传输；外网建议经 frp → nginx 终结 HTTPS，并在 nginx 层追加一道 Basic Auth 拦截自动化扫描。

## 许可

私有项目。

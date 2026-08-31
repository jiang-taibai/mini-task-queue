# mini-task-queue

面向单用户的 **GPU 任务队列**：提交实验任务并手动排序，系统以 1 秒粒度监控显存，一旦满足需求就自动分配空闲卡、注入 `CUDA_VISIBLE_DEVICES` 并后台启动，全程记录日志。

为「多人共享、全天候满载」的服务器设计——在这种环境下空闲显存是转瞬即逝的事件，所以策略是**乐观抢占**：能抢就抢，抢不到就自动重排队，而不是谨慎等待（那样会系统性地输给手动敲命令的同事）。

---

## 快速开始

```bash
npm install
npm run setup        # 交互式设置登录密码（scrypt 哈希，不存明文）
npm run build        # 构建前端
npm start            # 启动
```

服务不会自启，也不会崩溃重启。**用 tmux 或 nohup 启动**，否则 SSH 断开会让服务被 SIGHUP 终止：

```bash
tmux new -s mtq 'npm start'
# 或
nohup npm start > server.log 2>&1 &
```

> 服务被终止**不会影响正在运行的任务**——它们是 detached 的独立进程组。但队列会停止调度，重启后会自动认领回那些仍在跑的任务。

---

## 核心设计

| 维度 | 决策 | 为什么 |
|---|---|---|
| 抢占策略 | 单次采样满足即启动，不去抖 | 满载环境下花 5 秒确认稳定，卡早被别人抢走了 |
| 失败处理 | 快速 OOM 自动重排队（≤3 次） | 抢不到卡是常态，不该记为失败 |
| 资源模型 | 声明式需求（`1 卡 / ≥X GB`） | 而非"卡1 有显存就设 DEVICES=0"这类逐卡规则——加卡不用改配置 |
| 队列语义 | **严格门控**：队头排不上则全员等待 | 手动排的顺序是硬承诺，不会被小任务插队架空 |
| 自伤防护 | **软预留账本** + 60 秒预热期 | 启动到显存被吃满有段盲区，读数仍显示空闲，不记账就会同卡双派 |
| 监控闸门 | 数据超 5 秒未更新即暂停全部调度 | 满载下 5 秒前的读数已是废纸，照着派任务等于闭眼开车 |
| 进程隔离 | `detached` + 直写文件 fd | SSH 断开不连坐；不走管道则不会因缓冲区写满卡死训练进程 |
| 终止方式 | `kill(-pgid)` 杀整个进程组 | 只杀父进程会留下持有显存的孤儿 DataLoader worker |

### 任务状态机

```
blocked ──依赖满足──→ pending ──匹配到卡──→ running ──→ succeeded / failed
   │                     ↑___________________│ (快速 OOM，重排队回原位置，≤3 次)
   └──依赖失败级联──→ cancelled ←──手动停止──┘
```

---

## 使用须知

**命令里不要硬编码卡号。** 分流靠 `CUDA_VISIBLE_DEVICES` 实现——系统设 `CUDA_VISIBLE_DEVICES=1` 后，你代码里的 `cuda:0` 才会映射到物理卡 1。若硬编码 `cuda:1`，任务会跑到错误的卡上或直接找不到设备，且账本仍以为它在原来那张卡。提交时会有警告，但不做强制拦截。

**用 python 绝对路径，别依赖 `conda activate`。** conda 的初始化代码在 `.bashrc` 里，而非交互式 shell 会提前 return，`conda activate` 会报 command not found。直接写：

```
/home/you/miniconda3/envs/torch/bin/python train.py --lr 3e-5
```

**显存需求填不准也没关系。** 任务跑过一次后，系统会记录实测峰值；下次点「克隆」时会按 `峰值 × 1.15` 自动预填。

**队列可能因依赖而空转。** 严格门控下，若队头任务在等前置任务完成，后方任务不会越过它，此时另一张卡可能空闲着。界面顶部会常驻提示条告诉你被谁挡住、哪张卡在闲置——需要时手动拖动调整顺序。

---

## 配置

`config.json`（由 `npm run setup` 创建，权限 600，已在 `.gitignore` 中）：

```jsonc
{
  "port": 3000,
  "host": "0.0.0.0",
  "trustProxy": 1,              // 经 nginx/frp 访问时必须为 1，否则登录限流失效
  "allowedOrigins": [           // CSRF 白名单，内网与外网各一条；留空则跳过校验
    "http://192.168.1.10:3000",
    "https://gpu.example.com"
  ],
  "auth": {
    "sessionTtlHours": 168,
    "maxFailures": 5,           // 连续失败几次触发锁定
    "lockMinutes": 15
  },
  "gpu": {
    "source": "nvidia-smi",     // 或 "mock"
    "pollIntervalMs": 1000,
    "staleTimeoutMs": 5000,     // 超时即暂停调度
    "appsIntervalMs": 2000
  },
  "scheduler": {
    "warmupSeconds": 60,        // 预留账本挂载时长
    "maxPerGpu": 1,             // 每卡并发任务数
    "maxRetries": 3,            // 抢卡失败重试上限
    "oomWindowSeconds": 90,     // 运行时长低于此值 + OOM 关键字 → 判定为抢卡失败
    "killGraceSeconds": 10      // SIGTERM 到 SIGKILL 的宽限期
  }
}
```

---

## 外网访问（frp + nginx）

服务监听 `0.0.0.0`，**它能以你的账号执行任意命令**。内网为 HTTP 明文传输；外网建议经 frp 穿透到公网服务器，由 nginx 终结 HTTPS。

三个必须处理的点：

```nginx
location / {
    # 1. 传递真实 IP —— 不配的话登录限流会退化成全局计数器，
    #    攻击者失败 5 次就能把你自己也锁在门外
    proxy_set_header X-Real-IP        $remote_addr;
    proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # 2. Cookie 的 Secure 标志依赖它
    proxy_set_header Host             $host;

    # 3. SSE 必须关闭缓冲，否则实时日志和状态会被攒着一起发
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_http_version 1.1;

    # 建议：再加一道 Basic Auth 拦住全网自动化扫描
    auth_basic "restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;

    proxy_pass http://127.0.0.1:3000;
}
```

同时把外网域名写进 `config.json` 的 `allowedOrigins`。

---

## 开发

```bash
npm run dev                    # 后端 + Vite dev server（5173，自动代理 /api）
GPU_SOURCE=mock npm run dev    # 用假数据源
```

**Mock 数据源是为了在单卡机器上测双卡调度。** 分流、软预留账本、双卡并发这些路径在只有一张卡的开发机上一行都跑不到，而调度器是整个系统唯一有实质复杂度的部分。Mock 会模拟「任务启动后延迟数秒才真正吃显存」这个盲区——预热期和账本正是为它存在的。

登录后可通过接口构造场景：

```bash
curl -b cookie -X POST localhost:3000/api/mock/external \
     -H 'Content-Type: application/json' -d '{"gpuIndex":0,"memMb":20000}'   # 模拟他人占卡
curl -b cookie -X POST localhost:3000/api/mock/fluctuate \
     -H 'Content-Type: application/json' -d '{"enabled":true}'               # 随机占卡/放卡
```

### 目录结构

```
server/
  index.js        入口：Express、静态托管、优雅关闭
  config.js       配置加载与默认值
  db.js           node:sqlite（内置）schema
  auth.js         scrypt、会话、CSRF、登录限流
  scheduler.js    调度核心：门控、账本、依赖、OOM 判定、认领
  runner.js       进程启停、/proc 校验、退出码落盘
  logs.js         ANSI 过滤、回车折叠、增量跟随
  gpu/            数据源：nvidiaSmi.js（真实）/ mock.js
  routes/         tasks、events(SSE)、system
web/src/
  views/          Home、TaskDetail、Login
  components/     GpuCard、TaskCard、TaskForm、LogViewer
  store.js        全局状态 + SSE 总线
```

## 已知限制

- **单卡任务**，不支持一个任务占多张卡
- **无优先级/老化机制**，饥饿靠手动调整顺序解决
- **WSL2 下取不到 GPU 进程列表**（半虚拟化限制），会自动降级为仅显示显存
- **无外部通知**，任务状态只在页面标签标题中体现
- 日志不做轮转，界面会显示文件大小并只加载末尾片段

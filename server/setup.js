import readline from 'node:readline'
import { hashPassword } from './auth.js'
import { saveConfig, CONFIG_PATH, loadConfig } from './config.js'

const MIN_LENGTH = 12

function ask (rl, query, muted = false) {
  return new Promise(resolve => {
    rl.stdoutMuted = false
    rl.question(query, answer => {
      rl.stdoutMuted = false
      if (muted) process.stdout.write('\n')
      resolve(answer)
    })
    rl.stdoutMuted = muted
  })
}

async function main () {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  rl._writeToOutput = function (str) {
    if (this.stdoutMuted) {
      // 只回显掩码，不泄露长度以外的信息
      if (str.trim().length > 0 && !str.includes('\n')) this.output.write('*')
    } else {
      this.output.write(str)
    }
  }

  console.log('\n=== mini-task-queue 初始化 ===\n')
  console.log('服务将监听 0.0.0.0，任何能访问到端口的人只要通过登录，')
  console.log('就能以你的 Linux 账号执行任意命令。请设置一个足够强的密码。\n')

  const password = await ask(rl, `请输入登录密码（至少 ${MIN_LENGTH} 位）：`, true)
  if (password.length < MIN_LENGTH) {
    console.error(`\n密码太短：需要至少 ${MIN_LENGTH} 位，实际 ${password.length} 位。`)
    rl.close()
    process.exit(1)
  }

  const confirm = await ask(rl, '请再输入一次确认：', true)
  if (password !== confirm) {
    console.error('\n两次输入不一致。')
    rl.close()
    process.exit(1)
  }

  const { salt, hash } = await hashPassword(password)
  saveConfig({ auth: { salt, hash } })

  const cfg = loadConfig({ reload: true })
  rl.close()

  console.log(`\n密码已保存（scrypt 哈希，不存明文）：${CONFIG_PATH}`)
  console.log(`该文件权限已设为 600，且已在 .gitignore 中。\n`)
  console.log('接下来可按需编辑 config.json：')
  console.log(`  port            监听端口（当前 ${cfg.port}）`)
  console.log('  allowedOrigins  CSRF 白名单，内网地址与外网域名各写一条')
  console.log('  trustProxy      经 nginx/frp 访问时保持为 1，否则登录限流会失效')
  console.log('  scheduler.*     预热期、每卡并发数、重试上限等\n')
  console.log('然后：npm run build && npm start\n')
}

main().catch(err => {
  console.error('初始化失败：', err)
  process.exit(1)
})

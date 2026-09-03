import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/**
 * server/index.js 被 test runner 加载时必须拒绝启动。
 *
 * `node --test server/` 会把这个目录下的每个文件都当测试跑，包括服务入口。
 * 它没有 test() 用例，于是「跑」的方式就是从头执行一遍——打开数据库、
 * 启动调度器、占住端口，然后在 runner 退出后作为孤儿留在后台。
 * 这在真机上发生过一次，那个幽灵调度器活了近两个小时。
 */

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')

function runIndex (env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtq-guard-'))
  try {
    return spawnSync(process.execPath, [INDEX], {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        GPU_SOURCE: 'mock',
        // 端口给 0：万一闸门失灵，也不会去抢真实端口
        PORT: '0',
        ...env
      },
      encoding: 'utf8',
      timeout: 15000,
      killSignal: 'SIGKILL'
    })
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

test('被 test runner 加载时拒绝启动', () => {
  // node --test 给子进程注入的就是这个变量，值形如 child-v8
  const res = runIndex({ NODE_TEST_CONTEXT: 'child-v8' })

  assert.equal(res.status, 1, '必须以非 0 退出，否则 CI 里这个事故是静默的')
  assert.match(res.stderr, /启动被拒绝/)
  assert.match(res.stderr, /npm test/, '要顺带告诉人正确的跑法')
  assert.doesNotMatch(
    res.stdout, /已启动/,
    '闸门必须早于 listen——服务一旦起来，端口和数据库就已经被占了'
  )
})

test('正常启动不受影响', () => {
  // 没有 NODE_TEST_CONTEXT 就该正常跑起来。它会一直监听，等超时被 SIGKILL——
  // 只要没打印「启动被拒绝」，就说明闸门没有误伤
  const res = spawnSync(process.execPath, [INDEX], {
    env: {
      ...process.env,
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mtq-guard-ok-')),
      GPU_SOURCE: 'mock',
      PORT: '0',
      NODE_TEST_CONTEXT: ''
    },
    encoding: 'utf8',
    timeout: 4000,
    killSignal: 'SIGKILL'
  })

  assert.doesNotMatch(res.stderr, /启动被拒绝/, '空字符串不该被当成「在测试里」')
  assert.match(res.stdout, /已启动/)
})

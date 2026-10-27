// Run only inside a disposable Linux container. Installs the real package
// layout, substituting netifd/procd RPCs that are unavailable in Debian.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.OFM_CONTAINER_SMOKE !== '1') {
  throw new Error('必须在一次性 Linux 容器中设置 OFM_CONTAINER_SMOKE=1 后运行')
}
const repo = fileURLToPath(new URL('../', import.meta.url))
// OpenWrt installs Node at /usr/bin/node; the official test image uses /usr/local.
try { await fs.access('/usr/bin/node') } catch { await fs.symlink(process.execPath, '/usr/bin/node') }
for (const file of ['/usr/lib/ofm', '/usr/lib/ofm-access', '/etc/ofm-access.json']) {
  await assert.rejects(fs.access(file), { code: 'ENOENT' }, `拒绝覆盖现有安装：${file}`)
}
await fs.cp(path.join(repo, 'payload'), '/usr/lib/ofm', { recursive: true })
await fs.cp(path.join(repo, 'files'), '/', { recursive: true })
for (const file of ['/etc/init.d/ofm', '/usr/libexec/rpcd/ourfreemodel']) await fs.chmod(file, 0o755)
await fs.chmod('/etc/ofm-access.json', 0o600)

// netifd/procd facade: bind the selected logical interface to loopback and
// deliver the actual reload signal from the shipped init script.
await fs.writeFile('/bin/ubus', `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[3] === 'service') {
  const state = JSON.parse(fs.readFileSync('/var/run/ofm/status.json'));
  console.log(JSON.stringify({ofm: {instances: {main: {running: true, pid: state.pid}}}}));
} else console.log(JSON.stringify({up: true, 'ipv4-address': [{address: '127.0.0.1'}]}));
`, { mode: 0o755 })
await fs.writeFile('/tmp/ofm-procd-signal.mjs', `import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync('/var/run/ofm/status.json'));
process.kill(state.pid, process.argv[4] === 'HUP' ? 'SIGHUP' : 'SIGTERM');
`)
await fs.writeFile('/etc/rc.common', `#!/bin/sh
initscript="$1"
action="$2"
shift 2
procd_send_signal() { node /tmp/ofm-procd-signal.mjs "$@"; }
. "$initscript"
case "$action" in
  enabled|running) exit 0 ;;
  *) "$action" "$@" ;;
esac
`)

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function until(check, description) {
  const limit = Date.now() + 15_000
  let last
  while (Date.now() < limit) {
    try { const value = await check(); if (value) return value } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`等待超时：${description}${last ? ` (${last.message})` : ''}`)
}
async function rpc(method, body) {
  const child = spawn('/usr/libexec/rpcd/ourfreemodel', ['call', method], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { error += chunk })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`RPC 失败：${error}`)))
  })
  child.stdin.end(JSON.stringify(body))
  await done
  return JSON.parse(output)
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-installed-'))
const apiPort = await freePort()
let webPort = await freePort()
while (webPort === apiPort) webPort = await freePort()
const apiUrl = `http://127.0.0.1:${apiPort}`, webUrl = `http://127.0.0.1:${webPort}`
const service = spawn(process.execPath, ['/usr/lib/ofm-access/cli.mjs'], {
  env: { ...process.env, OFM_HOME: dir, OFM_API_PORT: String(apiPort), OFM_WEB_PORT: String(webPort),
    OFM_API_INTERFACE: 'loopback', OFM_WEB_INTERFACE: 'loopback' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
service.stdout.on('data', chunk => { logs += chunk })
service.stderr.on('data', chunk => { logs += chunk })
const exited = new Promise(resolve => service.once('exit', (code, signal) => resolve({ code, signal })))
const state = async () => JSON.parse(await fs.readFile('/var/run/ofm/status.json', 'utf8'))
const login = password => fetch(webUrl + '/ofm-access/login', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: webUrl },
  body: new URLSearchParams({ password }), redirect: 'manual', signal: AbortSignal.timeout(3000),
})
try {
  const initial = await until(async () => {
    if (service.exitCode !== null) throw new Error(logs)
    const current = await state()
    return current.api.running && current
  }, '真实 CLI 启动 API')
  assert.equal(initial.web.running, false, '未设置密码时不开放 WebUI')
  const settings = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'))
  const apiRequest = () => fetch(apiUrl + '/v1/models', { headers: { authorization: `Bearer ${settings.forwardKey}` }, signal: AbortSignal.timeout(3000) })
  assert.equal((await apiRequest()).status, 200)
  const first = 'installed-web-password-123'
  const result = await rpc('set_password', { password: first, confirmation: first })
  assert.equal(result.ok, true)
  assert.equal(result.reloaded, true)
  await until(async () => (await state()).web.running && (await login(first)).status === 303, 'SIGHUP 打开 WebUI')
  assert.equal((await state()).pid, initial.pid, '密码设置不得重启进程')
  const session = await login(first)
  const cookie = session.headers.get('set-cookie').split(';')[0]
  const headers = { cookie, origin: webUrl }
  const summary = await fetch(webUrl + '/api/management/summary', { headers })
  assert.equal(summary.status, 200)
  assert.equal((await summary.json()).baseUrl, apiUrl)
  assert.equal((await fetch(webUrl + '/api/management/providers', { headers })).status, 200)
  assert.equal((await fetch(apiUrl + '/api/management/key', { headers: { authorization: `Bearer ${settings.forwardKey}` } })).status, 404)
  const next = 'installed-new-password-456'
  assert.equal((await rpc('set_password', { password: next, confirmation: next })).ok, true)
  await until(async () => (await login(next)).status === 303, '第二次 SIGHUP 更换密码')
  assert.equal((await fetch(webUrl + '/api/management/summary', { headers })).status, 401)
  assert.equal((await login(first)).status, 401)
  assert.equal((await apiRequest()).status, 200)
  assert.equal((await state()).pid, initial.pid)
  const status = await rpc('status', {})
  assert.equal(status.passwordSet, true)
  assert.equal(status.api.port, apiPort)
  assert.equal(status.web.port, webPort)
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8')).forwardKey, settings.forwardKey)
  console.log('安装后运行自测通过：真实 CLI、API Key、WebUI 登录、LuCI RPC、SIGHUP 密码重载及双端口隔离。')
} catch (error) {
  console.error(logs)
  throw error
} finally {
  service.kill('SIGTERM')
  const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => { service.kill('SIGKILL'); resolve({ signal: 'SIGKILL' }) }, 10_000).unref())])
  await fs.rm(dir, { recursive: true, force: true })
  assert.equal(result.code, 0, '真实 CLI 必须正常退出并清理服务锁')
}

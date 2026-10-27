import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hashPassword, loadCredential, saveCredential, verifyPassword } from '../files/usr/lib/ofm-access/password.mjs'
import { startAccessGateway } from '../files/usr/lib/ofm-access/gateway.mjs'

const password = 'test-password-用于验证'
const credential = await hashPassword(password)

async function fixture(t, options = {}) {
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ path: req.url, headers: req.headers, body })
    if (req.url === '/api/management/session') {
      assert.equal(JSON.parse(body).key, 'private-management-key')
      res.writeHead(200, { 'set-cookie': 'upstream=privileged; HttpOnly; Path=/api/management' })
      return res.end('{"ok":true}')
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<html><head></head><body>management</body></html>')
    }
    if (req.url.startsWith('/api/management/')) assert.equal(req.headers.cookie, 'upstream=privileged')
    if (req.url === '/v1/models' && req.headers['x-api-key'] !== 'api-key') {
      res.writeHead(401); return res.end('{"error":"API key required"}')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const gateway = await startAccessGateway({
    targetUrl: `http://127.0.0.1:${upstream.address().port}`, managementKey: 'private-management-key',
    credential, port: 0, host: '127.0.0.1', ...options,
  })
  t.after(async () => { await gateway.close(); await new Promise(resolve => upstream.close(resolve)) })
  const url = `http://127.0.0.1:${gateway.port}`
  const call = (route, init = {}) => fetch(url + route, { redirect: 'manual', ...init })
  const login = value => call('/ofm-access/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: url },
    body: new URLSearchParams({ password: value }),
  })
  return { call, login, requests, url }
}

test('密码以随机盐哈希保存，拒绝空配置且权限为 0600', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-password-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'access.json')
  await fs.writeFile(file, '{}')
  await assert.rejects(loadCredential(file), /尚未配置访问密码/)
  await assert.rejects(hashPassword('short'))
  await saveCredential(file, password)
  const saved = await loadCredential(file)
  assert.equal(await verifyPassword(password, saved), true)
  assert.equal(await verifyPassword('incorrect', saved), false)
  assert.notEqual(saved.hash, credential.hash)
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.ok(!(await fs.readFile(file, 'utf8')).includes(password))
})

test('页面、静态资源、管理接口、健康检查和 API 都无法未登录访问', async t => {
  const { call, requests } = await fixture(t)
  const root = await call('/')
  assert.equal(root.status, 303)
  assert.equal(root.headers.get('location'), '/ofm-access/login')
  const login = await call('/ofm-access/login')
  assert.match(await login.text(), /type="password"/)
  for (const route of ['/assets/app.js', '/api/management/summary', '/health', '/v1/models', '/api/management/session']) {
    assert.equal((await call(route, { headers: { authorization: 'Bearer api-key', cookie: 'upstream=privileged' } })).status, 401, route)
  }
  assert.equal(requests.length, 0)
})

test('正确密码建立 HttpOnly 会话并自动登录管理页，退出后旧会话失效', async t => {
  const { call, login, requests, url } = await fixture(t)
  const response = await login(password)
  assert.equal(response.status, 303)
  const cookie = response.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=28800/)
  assert.ok(!cookie.includes('upstream'))
  const headers = { cookie: cookie.split(';')[0], origin: url, referer: url + '/' }
  const page = await call('/', { headers })
  assert.match(await page.text(), /ofm-access\/client.js/)
  const summary = await call('/api/management/summary', { headers })
  assert.equal(summary.status, 200)
  assert.equal((await summary.json()).baseUrl, url)
  const forwarded = requests.at(-1)
  assert.equal(forwarded.headers.origin, 'http://' + forwarded.headers.host)
  assert.equal(forwarded.headers.cookie, 'upstream=privileged')
  assert.equal((await call('/api/management/session', { method: 'POST', headers })).status, 403)
  assert.equal((await call('/api/management/logout', { method: 'POST', headers })).status, 200)
  assert.equal((await call('/api/management/summary', { headers })).status, 401)
})

test('跨站请求、伪造代理来源、超大表单和连续猜测被拒绝', async t => {
  let at = Date.now()
  const { call, login } = await fixture(t, { now: () => at })
  assert.equal((await call('/ofm-access/login', { headers: { origin: 'http://evil.test', 'x-forwarded-host': 'evil.test' } })).status, 403)
  assert.equal((await call('/ofm-access/login', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await call('/ofm-access/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + 'a'.repeat(4096),
  })).status, 413)
  for (let i = 0; i < 5; i++) assert.equal((await login('incorrect')).status, 401)
  assert.equal((await login(password)).status, 429)
  at += 15 * 60_000 + 1
  assert.equal((await login(password)).status, 303)
})

test('会话到期必须重新验证密码', async t => {
  let at = Date.now()
  const { call, login } = await fixture(t, { now: () => at, sessionMs: 1000 })
  const response = await login(password)
  const headers = { cookie: response.headers.get('set-cookie').split(';')[0] }
  assert.equal((await call('/api/management/summary', { headers })).status, 200)
  at += 1001
  assert.equal((await call('/api/management/summary', { headers })).status, 401)
})

test('HTTPS 代理使用明确配置的来源和 Secure Cookie', async t => {
  const { call } = await fixture(t, { publicOrigin: 'https://ofm.example.test' })
  const response = await call('/ofm-access/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://ofm.example.test' },
    body: new URLSearchParams({ password }),
  })
  assert.equal(response.status, 303)
  assert.match(response.headers.get('set-cookie'), /; Secure/)
  assert.equal((await call('/ofm-access/login', { headers: { origin: 'https://evil.test' } })).status, 403)
})

test('API 客户端需要访问密码和原有 API Key，两者缺一不可', async t => {
  const { call } = await fixture(t)
  const authorization = 'Basic ' + Buffer.from('ofm:' + password).toString('base64')
  assert.equal((await call('/v1/models', { headers: { 'x-api-key': 'api-key' } })).status, 401)
  assert.equal((await call('/v1/models', { headers: { authorization } })).status, 401)
  assert.equal((await call('/v1/models', { headers: { authorization, 'x-api-key': 'api-key' } })).status, 200)
})

test('真实上游管理页能通过密码网关获取管理会话和设置', async t => {
  const { startStandalone } = await import('../payload/packages/standalone/service.mjs')
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-service-test-')))
  let service, gateway
  t.after(async () => {
    await gateway?.close()
    await service?.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  // Node 26's test runner supplies process-only flags that upstream's worker
  // explicitly inherits; a production CLI starts without these test flags.
  const runnerArgs = process.execArgv
  try {
    process.execArgv = []
    service = await startStandalone({ dataDir: dir, port: 0, refresh: false, lanEnabled: false, logger: { warn() {} } })
  } finally { process.execArgv = runnerArgs }
  const settings = JSON.parse(await fs.readFile(service.keyFile, 'utf8'))
  gateway = await startAccessGateway({ targetUrl: service.url, managementKey: settings.managementKey, credential, host: '127.0.0.1', port: 0 })
  const url = `http://127.0.0.1:${gateway.port}`
  const login = await fetch(url + '/ofm-access/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: url },
    body: new URLSearchParams({ password }), redirect: 'manual',
  })
  assert.equal(login.status, 303)
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin: url }
  const summary = await fetch(url + '/api/management/summary', { headers })
  assert.equal(summary.status, 200)
  assert.equal((await summary.json()).baseUrl, url)
  // This route requires a privileged management session, beyond the API key.
  const providers = await fetch(url + '/api/management/providers', { headers })
  assert.equal(providers.status, 200)
  assert.ok(Array.isArray((await providers.json()).registry))
  const page = await fetch(url + '/', { headers })
  assert.match(await page.text(), /ofm-access\/client.js/)
})

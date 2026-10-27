import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { resolveBinding, parsePort, httpAddress } from '../files/usr/lib/ofm-access/bind.mjs'
import { createControl } from '../files/usr/lib/ofm-access/control.mjs'
import { loadCredential, verifyPassword } from '../files/usr/lib/ofm-access/password.mjs'

const root = new URL('../', import.meta.url)

test('接口绑定自动选取本地地址，显式 IP 必须属于该接口，失效时不回退全接口', async () => {
  const query = async name => ({ up: name !== 'wan', 'ipv4-address': [{ address: '192.168.8.1' }], 'ipv6-address': [{ address: 'fd00::1' }] })
  assert.equal(await resolveBinding('lan', '', { query }), '192.168.8.1')
  assert.equal(await resolveBinding('lan', 'fd00::1', { query }), 'fd00::1')
  await assert.rejects(resolveBinding('lan', '192.168.9.1', { query }), /不属于接口/)
  await assert.rejects(resolveBinding('wan', '', { query }), /未启用/)
  await assert.rejects(resolveBinding('lan', '', { query: async () => { throw new Error('offline') } }), /无法读取/)
  await assert.rejects(resolveBinding('lan;reboot', '', { query }), /有效的路由器网络接口/)
  assert.equal(await resolveBinding('lan', '', { query: async () => ({ up: true, 'ipv6-prefix-assignment': [{ 'local-address': { address: 'fd01::1' } }] }) }), 'fd01::1')
  assert.equal(await resolveBinding('*'), '0.0.0.0')
  await assert.rejects(resolveBinding('*', '198.51.100.1', { interfaces: () => ({ lan: [{ address: '192.168.8.1' }] }) }), /不是路由器当前本地/)
  assert.equal(parsePort('18900', 'API'), 18900)
  for (const value of ['0', '65536', '12.3', 'abc', '-1']) assert.throws(() => parsePort(value, 'API'))
  assert.equal(httpAddress('fd00::1', 18901), 'http://[fd00::1]:18901')
})

test('LuCI 密码重置只发 WebUI 重载命令；密码和确认值不进入命令参数', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-control-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const file = path.join(dir, 'credential.json')
  const control = createControl({ credentialFile: file, run: async (command, args) => { calls.push({ command, args }); return { stdout: '' } } })
  await assert.rejects(control.set_password({ password: 'a-secure-web-password', confirmation: 'different' }), /不一致/)
  const result = await control.set_password({ password: 'a-secure-web-password', confirmation: 'a-secure-web-password' })
  assert.equal(result.ok, true)
  assert.equal(await verifyPassword('a-secure-web-password', await loadCredential(file)), true)
  assert.deepEqual(calls, [{ command: '/etc/init.d/ofm', args: ['reload_password'] }])
  await assert.rejects(control.service({ action: 'restart; reboot' }), /不支持/)
  assert.equal(calls.length, 1)
})

test('LuCI 状态识别当前进程并拒绝显示陈旧的监听地址', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-status-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'state.json'), versionFile = path.join(dir, 'version.json')
  await fs.writeFile(stateFile, JSON.stringify({ pid: 100, api: { running: true, port: 18900 }, web: { running: true, port: 18901 }, dataDir: '/mnt/ofm' }))
  await fs.writeFile(versionFile, '{"version":"2.7.2"}')
  let pid = 100
  const control = createControl({ stateFile, versionFile, credentialFile: path.join(dir, 'missing'), run: async file => ({ stdout: file === '/bin/ubus' ? JSON.stringify({ ofm: { instances: { main: { running: true, pid } } } }) : '' }) })
  const state = await control.status()
  assert.equal(state.api.port, 18900)
  assert.equal(state.web.port, 18901)
  assert.equal(state.passwordSet, false)
  pid = 101
  assert.equal((await control.status()).api.running, false)
})

test('LuCI 菜单和 ACL 将密码与服务控制限制为写权限，未开放任意命令执行', async () => {
  const menu = JSON.parse(await fs.readFile(new URL('files/usr/share/luci/menu.d/luci-app-ourfreemodel.json', root)))
  assert.equal(menu['admin/services/ourfreemodel'].title, 'OurFreeModel')
  const acl = JSON.parse(await fs.readFile(new URL('files/usr/share/rpcd/acl.d/luci-app-ourfreemodel.json', root)))['luci-app-ourfreemodel']
  assert.deepEqual(acl.read.ubus.ourfreemodel, ['status'])
  assert.deepEqual(acl.write.ubus.ourfreemodel, ['set_password', 'service'])
  assert.deepEqual(acl.write.uci, ['openwrt-ofm'])
  assert.equal(acl.write.file, undefined)
})

test('RPC 读取完整 JSON 后即处理，不等待 rpcd 关闭 stdin，并拒绝命令注入', async t => {
  const child = spawn(process.execPath, [new URL('files/usr/lib/ofm-access/rpc.mjs', root).pathname, 'call', 'service'], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('RPC 等待 stdin 关闭而没有及时处理')) }, 3000)
    child.on('error', reject)
    child.on('exit', code => { clearTimeout(timer); resolve(code) })
  })
  child.stdin.on('error', () => {})
  child.stdin.write('{"action":"restart; reboot"}')
  assert.equal(await done, 0)
  assert.equal(JSON.parse(output).ok, false)
})

test('LuCI 视图呈现两个端口、接口选择和密码重置，校验端口冲突及 IP 归属', async () => {
  const maps = []
  class Map {
    constructor() { this.options = []; maps.push(this) }
    section() {
      return { tab() {}, taboption: (tab, type, name) => {
        const option = { option: name, choices: [], value(value, label) { this.choices.push([value, label]) }, formvalue() { return this.current }, cfgvalue() { return undefined } }
        this.options.push(option); return option
      } }
    }
    lookupOption(name) { return this.options.filter(option => option.option === name) }
    render() { return Promise.resolve({ tag: 'form' }) }
  }
  const E = (tag, attributes, children) => ({ tag, attributes, children })
  const L = { hasViewPermission: () => true, dom: { content: (node, child) => { node.children = child } } }
  const rpc = { declare: () => async () => ({}) }
  const ui = { createHandlerFn: () => () => {} }, poll = { add() {} }
  const code = await fs.readFile(new URL('files/www/luci-static/resources/view/ourfreemodel.js', root), 'utf8')
  const view = new Function('view', 'form', 'uci', 'rpc', 'network', 'ui', 'poll', 'L', 'E', '_', code)(
    { extend: object => object }, { Map, NamedSection: 'section', Value: 'input', Flag: 'flag', ListValue: 'list' }, {}, rpc, {}, ui, poll, L, E, value => value)
  const networks = [{ getName: () => 'lan', getIPAddrs: () => ['192.168.8.1/24'], getIP6Addrs: () => [] }]
  await view.render([null, networks, { running: true, api: {}, web: {} }])
  const options = maps[0].options
  for (const name of ['api_port', 'web_port', 'api_interface', 'web_interface', 'api_address', 'web_address', 'data_dir']) assert.ok(options.some(option => option.option === name), name)
  assert.ok(!options.some(option => /password/.test(option.option)), '密码不得存入明文 UCI')
  const api = options.find(option => option.option === 'api_port'), web = options.find(option => option.option === 'web_port')
  api.current = '18900'; web.current = '18900'
  assert.notEqual(api.validate('main', '18900'), true)
  web.current = '18901'
  assert.equal(api.validate('main', '18900'), true)
  const address = options.find(option => option.option === 'web_address')
  assert.equal(address.validate('main', '192.168.8.1'), true)
  assert.notEqual(address.validate('main', '192.168.9.1'), true)
})

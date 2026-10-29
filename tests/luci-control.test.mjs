import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveBinding, parsePort, httpAddress } from '../files/usr/lib/ourfreemodel-access/bind.mjs'
import { createControl } from '../files/usr/lib/ourfreemodel-access/control.mjs'
import { ensureCredential, loadCredential, verifyPassword } from '../files/usr/lib/ourfreemodel-access/password.mjs'

const root = new URL('../', import.meta.url)
const execute = promisify(execFile)

test('真实 init 脚本向 procd 传递双端口和接口，禁用时不启动，注册配置及接口触发器', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-init-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const harness = path.join(dir, 'harness.sh')
  await fs.writeFile(harness, `config_load() { :; }
config_get_bool() { export "$1=$OURFREEMODEL_TEST_ENABLED"; }
config_get() {
  local value="$4"
  case "$3" in
    data_dir) value="$OURFREEMODEL_TEST_DATA" ;;
    api_port) value=19000 ;;
    web_port) value=19001 ;;
    api_interface) value=lan ;;
    web_interface) value=loopback ;;
  esac
  export "$1=$value"
}
procd_open_instance() { printf 'OPEN:%s\\n' "$1"; }
procd_close_instance() { :; }
procd_set_param() { printf '%s\\n' "$@"; }
procd_add_reload_trigger() { printf 'RELOAD:%s\\n' "$1"; }
procd_add_interface_trigger() { printf 'IFACE:%s\\n' "$2"; }
. "$1"
start_service
service_triggers
`)
  const script = new URL('files/etc/init.d/ourfreemodel', root).pathname
  const env = { ...process.env, OURFREEMODEL_TEST_DATA: path.join(dir, 'data with spaces'), OURFREEMODEL_TEST_ENABLED: '1' }
  const enabled = (await execute('sh', [harness, script], { env })).stdout
  for (const value of ['OPEN:main', 'OURFREEMODEL_API_PORT=19000', 'OURFREEMODEL_WEB_PORT=19001', 'OURFREEMODEL_API_INTERFACE=lan', 'OURFREEMODEL_WEB_INTERFACE=loopback', `OURFREEMODEL_HOME=${env.OURFREEMODEL_TEST_DATA}`, 'RELOAD:ourfreemodel', 'IFACE:lan', 'IFACE:loopback']) assert.ok(enabled.includes(value), value)
  const disabled = (await execute('sh', [harness, script], { env: { ...env, OURFREEMODEL_TEST_ENABLED: '0' } })).stdout
  assert.ok(!disabled.includes('OPEN:main'))
})

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-control-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const file = path.join(dir, 'credential.json'), secretFile = path.join(dir, 'secret')
  const control = createControl({ credentialFile: file, secretFile, run: async (command, args) => { calls.push({ command, args }); return { stdout: '' } } })
  await assert.rejects(control.set_password({ password: 'a-secure-web-password', confirmation: 'different' }), /不一致/)
  const result = await control.set_password({ password: 'a-secure-web-password', confirmation: 'a-secure-web-password' })
  assert.equal(result.ok, true)
  assert.equal(await verifyPassword('a-secure-web-password', await loadCredential(file)), true)
  // 手动设置的密码不保留明文副本，LuCI 不再显示（可能已失效的）旧随机密码。
  assert.equal((await control.password()).password, '')
  assert.deepEqual(calls, [{ command: '/etc/init.d/ourfreemodel', args: ['reload_password'] }])
  await assert.rejects(control.service({ action: 'restart; reboot' }), /不支持/)
  assert.equal(calls.length, 1)
})

test('首次初始化生成 16 位随机密码，LuCI 可读取，重置后旧密码立即失效', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-random-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const credentialFile = path.join(dir, 'credential.json'), secretFile = path.join(dir, 'secret')
  const first = await ensureCredential({ credentialFile, secretFile })
  assert.equal(first.created, true)
  assert.match(first.password, /^[abcdefghjkmnpqrstuvwxyz23456789]{16}$/)
  assert.equal(await verifyPassword(first.password, await loadCredential(credentialFile)), true)
  // 再次初始化不覆盖已有密码
  assert.equal((await ensureCredential({ credentialFile, secretFile })).created, false)
  const control = createControl({ credentialFile, secretFile, run: async () => ({ stdout: '' }) })
  assert.equal((await control.password()).password, first.password)
  const reset = await control.reset_password()
  assert.notEqual(reset.password, first.password)
  assert.equal((await control.password()).password, reset.password)
  assert.equal(await verifyPassword(reset.password, await loadCredential(credentialFile)), true)
  assert.equal(await verifyPassword(first.password, await loadCredential(credentialFile)), false)
  // 手动设置后明文副本被清除
  await control.set_password({ password: 'a-secure-web-password', confirmation: 'a-secure-web-password' })
  assert.equal((await control.password()).password, '')
  assert.equal((await control.status()).passwordVisible, false)
})

test('LuCI 状态识别当前进程并拒绝显示陈旧的监听地址', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-status-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'state.json'), versionFile = path.join(dir, 'version.json')
  await fs.writeFile(stateFile, JSON.stringify({ pid: 100, api: { running: true, port: 18900 }, web: { running: true, port: 18901 }, dataDir: '/mnt/ourfreemodel' }))
  await fs.writeFile(versionFile, '{"version":"2.7.2"}')
  let pid = 100
  const control = createControl({ stateFile, versionFile, credentialFile: path.join(dir, 'missing'), run: async file => ({ stdout: file === '/bin/ubus' ? JSON.stringify({ ourfreemodel: { instances: { main: { running: true, pid } } } }) : '' }) })
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
  assert.deepEqual(acl.write.ubus.ourfreemodel, ['password', 'reset_password', 'set_password', 'service'])
  assert.deepEqual(acl.write.uci, ['ourfreemodel'])
  assert.equal(acl.write.file, undefined)
})

test('RPC 读取完整 JSON 后即处理，不等待 rpcd 关闭 stdin，并拒绝命令注入', async t => {
  const child = spawn(process.execPath, [new URL('files/usr/lib/ourfreemodel-access/rpc.mjs', root).pathname, 'call', 'service'], { stdio: ['pipe', 'pipe', 'pipe'] })
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
  const rpcCalls = []
  const rpc = { declare: () => async (...args) => { rpcCalls.push(args); return {} } }
  // 与路由器上 LuCI 真实实现一致：createHandlerFn 把绑定参数放在前面，浏览器事件对象追加在最后。
  const ui = {
    createHandlerFn(target, method, ...args) {
      const fn = target[method]
      return function(ev) { return Promise.resolve(fn.apply(target, args.concat([ev]))) }
    },
    addNotification() {}, showModal() {}, hideModal() {}
  }
  const poll = { add() {} }
  const code = await fs.readFile(new URL('files/www/luci-static/resources/view/ourfreemodel.js', root), 'utf8')
  assert.match(code, /serviceAction: function\(action, ev\)/, '按钮处理函数必须先接收 action，事件对象在最后')
  const view = new Function('view', 'form', 'uci', 'rpc', 'network', 'ui', 'poll', 'L', 'E', '_', code)(
    { extend: object => object }, { Map, NamedSection: 'section', Value: 'input', Flag: 'flag', ListValue: 'list' }, {}, rpc, {}, ui, poll, L, E, value => value)
  const networks = [{ getName: () => 'lan', getIPAddrs: () => ['192.168.8.1/24'], getIP6Addrs: () => [] }]
  const container = await view.render([null, networks, { running: true, api: {}, web: {} }])
  assert.equal(container.children[1].children, '操作', '操作栏标题应为“操作”')
  const actions = container.children[2].children
  const texts = actions.map(button => button.children)
  // 运行中只显示“停止”，不显示“启动”，两者互斥。
  assert.ok(texts.includes('停止') && !texts.includes('启动'))
  assert.ok(texts.includes('开机自启') && !texts.includes('取消开机自启'))
  const stop = actions.find(button => button.children === '停止')
  assert.equal(stop.attributes.disabled, undefined, '操作按钮不应预先禁用，权限交由 rpcd ACL 校验')
  await stop.attributes.click({ currentTarget: { disabled: false } })
  assert.deepEqual(rpcCalls, [['stop']], '点击停止应把 action 字符串传给 RPC')
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

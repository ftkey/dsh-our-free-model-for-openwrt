import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))

test('执行真实安装配方，确认 LuCI、RPC、默认配置和运行时完整入包且权限正确', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-install-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.mkdir(path.join(dir, 'include'))
  await fs.writeFile(path.join(dir, 'rules.mk'), '')
  await fs.writeFile(path.join(dir, 'include/package.mk'), `PKG_BUILD_DIR:=$(TOPDIR)/build/$(PKG_NAME)
CP:=cp -fpR
INSTALL_DIR:=mkdir -p
INSTALL_BIN:=install -m0755
INSTALL_CONF:=install -m0600
INSTALL_DATA:=install -m0644
define Build/Prepare/Default
mkdir -p $(PKG_BUILD_DIR)
endef
`)
  await fs.writeFile(path.join(dir, 'test.mk'), `stage=$(PKG_BUILD_DIR)/ipkg-test/$(PKG_NAME)
.PHONY: test
test:
	$(Build/Prepare)
	$(call Package/$(PKG_NAME)/install,$(stage))
`)
  await run('make', ['--no-print-directory', '-f', path.join(repo, 'Makefile'), '-f', path.join(dir, 'test.mk'), `TOPDIR=${dir}`, `INCLUDE_DIR=${dir}/include`, 'test'], { cwd: repo, maxBuffer: 65536 })
  const dest = path.join(dir, 'build/dsh-our-free-model-for-openwrt/ipkg-test/dsh-our-free-model-for-openwrt')
  for (const [file, mode] of [
    ['etc/init.d/ofm', 0o755], ['etc/uci-defaults/90-ourfreemodel', 0o755], ['etc/ofm-access.json', 0o600],
    ['usr/libexec/rpcd/ourfreemodel', 0o755], ['www/luci-static/resources/view/ourfreemodel.js', 0o644],
    ['usr/share/luci/menu.d/luci-app-ourfreemodel.json', 0o644], ['usr/share/rpcd/acl.d/luci-app-ourfreemodel.json', 0o644],
  ]) {
    assert.equal((await fs.stat(path.join(dest, file))).mode & 0o777, mode, file)
    assert.deepEqual(await fs.readFile(path.join(dest, file)), await fs.readFile(path.join(repo, 'files', file)))
  }
  for (const module of ['api', 'bind', 'cli', 'control', 'gateway', 'password', 'rpc']) await fs.access(path.join(dest, `usr/lib/ofm-access/${module}.mjs`))
  await fs.access(path.join(dest, 'usr/lib/ofm/packages/standalone/service.mjs'))
})

test('升级迁移保留旧 API 端口与回环绑定，避开双端口冲突，重复运行不覆盖用户设置', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-migrate-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const store = path.join(dir, 'uci.json')
  await fs.writeFile(store, JSON.stringify({ 'openwrt-ofm.main': 'ofm', 'openwrt-ofm.main.port': '18901', 'openwrt-ofm.main.host': '127.0.0.1' }))
  await fs.writeFile(path.join(dir, 'uci'), `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.OFM_TEST_UCI;
const data = JSON.parse(fs.readFileSync(file));
const args = process.argv.slice(2).filter(arg => arg !== '-q');
if (args[0] === 'get') {
  if (!(args[1] in data)) process.exit(1);
  process.stdout.write(data[args[1]]);
} else if (args[0] === 'set') {
  const at = args[1].indexOf('='); data[args[1].slice(0, at)] = args[1].slice(at + 1);
  fs.writeFileSync(file, JSON.stringify(data));
}
`, { mode: 0o755 })
  const migrate = () => run('sh', [path.join(repo, 'files/etc/uci-defaults/90-ourfreemodel')], { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, OFM_TEST_UCI: store } })
  await migrate()
  let config = JSON.parse(await fs.readFile(store))
  assert.equal(config['openwrt-ofm.main.api_port'], '18901')
  assert.equal(config['openwrt-ofm.main.web_port'], '18902')
  assert.equal(config['openwrt-ofm.main.api_interface'], 'loopback')
  assert.equal(config['openwrt-ofm.main.web_address'], '127.0.0.1')
  config['openwrt-ofm.main.web_port'] = '19001'
  config['openwrt-ofm.main.web_interface'] = 'lan'
  config['openwrt-ofm.main.web_address'] = '192.168.8.1'
  await fs.writeFile(store, JSON.stringify(config))
  await migrate()
  assert.deepEqual(JSON.parse(await fs.readFile(store)), config)
})

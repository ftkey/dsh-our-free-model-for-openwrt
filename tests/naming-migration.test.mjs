import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacy } from '../files/usr/lib/ourfreemodel-access/migrate.mjs'
import { saveCredential, loadCredential, verifyPassword } from '../files/usr/lib/ourfreemodel-access/password.mjs'

test('旧缩写配置、密码、默认数据和开机链接迁移为完整名称，原模型密钥保持不变', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-rename-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = relative => path.join(root, relative)
  for (const dir of ['etc/config', 'etc/rc.d', 'usr/lib/ofm-data']) await fs.mkdir(file(dir), { recursive: true })
  await fs.writeFile(file('etc/config/openwrt-ofm'), "config ofm 'main'\n\toption api_port '19000'\n\toption web_port '19001'\n\toption data_dir '/usr/lib/ofm-data'\n")
  await fs.writeFile(file('etc/config/ourfreemodel'), "config ourfreemodel 'main'\n")
  await fs.writeFile(file('etc/ourfreemodel-migrated'), '0\n')
  const settings = '{"forwardKey":"existing-model-key","standalonePort":18900}\n'
  await fs.writeFile(file('usr/lib/ofm-data/settings.json'), settings)
  await saveCredential(file('etc/ofm-access.json'), 'existing-web-password-123')
  await fs.writeFile(file('etc/ourfreemodel-access.json'), '{}')
  await fs.symlink('../init.d/ofm', file('etc/rc.d/S99ofm'))
  let stopped = 0
  const stopLegacy = async () => { stopped++ }
  assert.equal((await migrateLegacy({ root, stopLegacy })).migrated, true)
  const config = await fs.readFile(file('etc/config/ourfreemodel'), 'utf8')
  assert.match(config, /config ourfreemodel 'main'/)
  assert.match(config, /api_port '19000'/)
  assert.match(config, /data_dir '\/etc\/ourfreemodel'/)
  assert.equal(await fs.readFile(file('etc/ourfreemodel/settings.json'), 'utf8'), settings)
  assert.equal(await verifyPassword('existing-web-password-123', await loadCredential(file('etc/ourfreemodel-access.json'))), true)
  assert.equal((await fs.stat(file('etc/ourfreemodel-access.json'))).mode & 0o777, 0o600)
  assert.equal(await fs.readlink(file('etc/rc.d/S99ourfreemodel')), '../init.d/ourfreemodel')
  await assert.rejects(fs.lstat(file('etc/rc.d/S99ofm')), { code: 'ENOENT' })
  await fs.writeFile(file('etc/config/ourfreemodel'), 'user-custom-config')
  assert.equal((await migrateLegacy({ root, stopLegacy })).migrated, false)
  assert.equal(stopped, 1)
  assert.equal(await fs.readFile(file('etc/config/ourfreemodel'), 'utf8'), 'user-custom-config')
})

test('新旧默认数据目录同时存在时不覆盖数据，继续使用原数据路径', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-data-conflict-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = relative => path.join(root, relative)
  for (const dir of ['etc/config', 'usr/lib/ofm-data', 'usr/lib/ourfreemodel-data']) await fs.mkdir(file(dir), { recursive: true })
  await fs.writeFile(file('etc/config/openwrt-ofm'), "config ofm 'main'\n\toption data_dir '/usr/lib/ofm-data'\n")
  await fs.writeFile(file('usr/lib/ofm-data/settings.json'), '{"forwardKey":"old-key"}')
  await fs.writeFile(file('usr/lib/ourfreemodel-data/settings.json'), '{"forwardKey":"other-key"}')
  await migrateLegacy({ root, stopLegacy: async () => {} })
  assert.match(await fs.readFile(file('etc/config/ourfreemodel'), 'utf8'), /data_dir '\/usr\/lib\/ofm-data'/)
  assert.equal(await fs.readFile(file('usr/lib/ofm-data/settings.json'), 'utf8'), '{"forwardKey":"old-key"}')
  assert.equal(await fs.readFile(file('usr/lib/ourfreemodel-data/settings.json'), 'utf8'), '{"forwardKey":"other-key"}')
})

test('迁移支持包管理器保存的旧配置，保留自定义数据目录和已经重设的新密码', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-upgrade-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = relative => path.join(root, relative)
  await fs.mkdir(file('etc/config'), { recursive: true })
  await fs.mkdir(file('mnt/custom-data'), { recursive: true })
  await fs.writeFile(file('etc/config/openwrt-ofm.apk-save'), "config ofm 'main'\n\toption data_dir '/mnt/custom-data'\n")
  await fs.writeFile(file('mnt/custom-data/record.json'), '{"kept":true}')
  await saveCredential(file('etc/ofm-access.json.apk-save'), 'previous-web-password-123')
  await saveCredential(file('etc/ourfreemodel-access.json'), 'already-reset-password-456')
  await migrateLegacy({ root, stopLegacy: async () => {} })
  assert.match(await fs.readFile(file('etc/config/ourfreemodel'), 'utf8'), /\/mnt\/custom-data/)
  assert.equal(await verifyPassword('already-reset-password-456', await loadCredential(file('etc/ourfreemodel-access.json'))), true)
  assert.equal(await fs.readFile(file('mnt/custom-data/record.json'), 'utf8'), '{"kept":true}')
})

test('已迁移的老安装把默认数据目录从 /usr/lib 迁到 /etc，配置同步改写', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-datadir-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = relative => path.join(root, relative)
  for (const dir of ['etc/config', 'usr/lib/ourfreemodel-data']) await fs.mkdir(file(dir), { recursive: true })
  await fs.writeFile(file('etc/config/ourfreemodel'), "config ourfreemodel 'main'\n\toption data_dir '/usr/lib/ourfreemodel-data'\n")
  await fs.writeFile(file('etc/ourfreemodel-migrated'), '1\n')
  const settings = '{"forwardKey":"kept-key"}'
  await fs.writeFile(file('usr/lib/ourfreemodel-data/settings.json'), settings)
  await fs.writeFile(file('usr/lib/ourfreemodel-data/usage.json'), '{"tokens":42}')
  assert.equal((await migrateLegacy({ root, stopLegacy: async () => {} })).migrated, true)
  assert.match(await fs.readFile(file('etc/config/ourfreemodel'), 'utf8'), /data_dir '\/etc\/ourfreemodel'/)
  assert.equal(await fs.readFile(file('etc/ourfreemodel/settings.json'), 'utf8'), settings)
  assert.equal(await fs.readFile(file('etc/ourfreemodel/usage.json'), 'utf8'), '{"tokens":42}')
  await assert.rejects(fs.lstat(file('usr/lib/ourfreemodel-data')), { code: 'ENOENT' })
  // 幂等：再跑一次不报错、不改动
  assert.equal((await migrateLegacy({ root, stopLegacy: async () => {} })).migrated, false)
  assert.equal(await fs.readFile(file('etc/ourfreemodel/settings.json'), 'utf8'), settings)
})

test('新默认目录已被服务预建时按老数据优先合并，旧目录删除', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-datadir-merge-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = relative => path.join(root, relative)
  for (const dir of ['etc/config', 'etc/ourfreemodel/subscriptions', 'usr/lib/ourfreemodel-data/subscriptions']) await fs.mkdir(file(dir), { recursive: true })
  await fs.writeFile(file('etc/config/ourfreemodel'), "config ourfreemodel 'main'\n\toption data_dir '/usr/lib/ourfreemodel-data'\n")
  await fs.writeFile(file('etc/ourfreemodel-migrated'), '1\n')
  // 新目录里是服务刚生成的默认文件
  await fs.writeFile(file('etc/ourfreemodel/settings.json'), '{"forwardKey":"default"}')
  await fs.writeFile(file('etc/ourfreemodel/catalog.json'), '{"version":1}')
  // 旧目录里是用户真实数据
  await fs.writeFile(file('usr/lib/ourfreemodel-data/settings.json'), '{"forwardKey":"real-key"}')
  await fs.writeFile(file('usr/lib/ourfreemodel-data/eac-user.json'), '{"user":"me"}')
  await fs.writeFile(file('usr/lib/ourfreemodel-data/stats.json'), '{"tokens":7}')
  await fs.writeFile(file('usr/lib/ourfreemodel-data/subscriptions/a.json'), '{"id":"a"}')
  assert.equal((await migrateLegacy({ root, stopLegacy: async () => {} })).migrated, true)
  assert.match(await fs.readFile(file('etc/config/ourfreemodel'), 'utf8'), /data_dir '\/etc\/ourfreemodel'/)
  assert.equal(await fs.readFile(file('etc/ourfreemodel/settings.json'), 'utf8'), '{"forwardKey":"real-key"}')
  assert.equal(await fs.readFile(file('etc/ourfreemodel/eac-user.json'), 'utf8'), '{"user":"me"}')
  assert.equal(await fs.readFile(file('etc/ourfreemodel/stats.json'), 'utf8'), '{"tokens":7}')
  assert.equal(await fs.readFile(file('etc/ourfreemodel/subscriptions/a.json'), 'utf8'), '{"id":"a"}')
  assert.equal(await fs.readFile(file('etc/ourfreemodel/catalog.json'), 'utf8'), '{"version":1}')
  await assert.rejects(fs.lstat(file('usr/lib/ourfreemodel-data')), { code: 'ENOENT' })
})

test('旧目录不存在时不动新目录', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-datadir-only-new-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = relative => path.join(root, relative)
  await fs.mkdir(file('etc/config'), { recursive: true })
  await fs.mkdir(file('etc/ourfreemodel'), { recursive: true })
  await fs.writeFile(file('etc/config/ourfreemodel'), "config ourfreemodel 'main'\n\toption data_dir '/etc/ourfreemodel'\n")
  await fs.writeFile(file('etc/ourfreemodel-migrated'), '1\n')
  await fs.writeFile(file('etc/ourfreemodel/settings.json'), '{"forwardKey":"kept"}')
  assert.equal((await migrateLegacy({ root, stopLegacy: async () => {} })).migrated, false)
  assert.equal(await fs.readFile(file('etc/ourfreemodel/settings.json'), 'utf8'), '{"forwardKey":"kept"}')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { saveCredential, loadCredential, verifyPassword } from '../files/usr/lib/ourfreemodel-access/password.mjs'

test('统一命名使用 ourfreemodel 配置和默认数据目录', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-modern-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const file = relative => path.join(root, relative)
  await fs.mkdir(file('etc/config'), { recursive: true })

  const config = "config ourfreemodel 'main'\n\toption api_port '19000'\n\toption web_port '19001'\n\toption data_dir '/etc/ourfreemodel'\n"
  await fs.writeFile(file('etc/config/ourfreemodel'), config)
  await saveCredential(file('etc/ourfreemodel-access.json'), 'web-password-123')

  const saved = await fs.readFile(file('etc/config/ourfreemodel'), 'utf8')
  assert.match(saved, /config ourfreemodel 'main'/)
  assert.match(saved, /api_port '19000'/)
  assert.match(saved, /data_dir '\/etc\/ourfreemodel'/)
  assert.equal(await verifyPassword('web-password-123', await loadCredential(file('etc/ourfreemodel-access.json'))), true)
  assert.equal((await fs.stat(file('etc/ourfreemodel-access.json'))).mode & 0o777, 0o600)

  await assert.rejects(fs.access(file('etc/config/openwrt-ofm')), { code: 'ENOENT' })
  await assert.rejects(fs.access(file('etc/ofm-access.json')), { code: 'ENOENT' })
  await assert.rejects(fs.access(file('usr/lib/ofm-data/settings.json')), { code: 'ENOENT' })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const read = file => fs.readFile(path.join(repo, file), 'utf8')
const readJson = async file => JSON.parse(await read(file))

test('payload 根包与 standalone 版本必须和 PORT-VERSION 一致', async () => {
  const port = await readJson('payload/PORT-VERSION.json')
  const root = await readJson('payload/package.json')
  const standalone = await readJson('payload/packages/standalone/package.json')
  assert.equal(root.version, port.version)
  assert.equal(standalone.version, port.version)
})

test('Bun 资产清单覆盖两个构建架构且哈希完整', async () => {
  const manifest = await readJson('scripts/bun-assets.json')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  for (const arch of ['aarch64', 'x64']) {
    const asset = manifest.assets[arch]
    assert.ok(asset, arch)
    assert.match(asset.file, /^bun-linux-.+-musl\.zip$/)
    assert.match(asset.sha256, /^[0-9a-f]{64}$/)
    assert.equal(asset.binary, asset.file.replace(/\.zip$/, '/bun'))
  }
  const makefile = await read('openwrt/dsh-our-free-model-bun/Makefile')
  assert.match(makefile, /files\/bun-assets\.json/)
  assert.match(makefile, /usr\/lib\/ourfreemodel\/bin/)
})

test('init 脚本向运行时传递免费通道与 Bun 路径', async () => {
  const script = await read('files/etc/init.d/ourfreemodel')
  assert.match(script, /config_get free_transport main free_transport auto/)
  assert.match(script, /config_get bun_path main bun_path \/usr\/lib\/ourfreemodel\/bin\/bun/)
  assert.match(script, /OUR_FREE_MODEL_FREE_TRANSPORT="\$free_transport"/)
  assert.match(script, /OUR_FREE_MODEL_BUN="\$bun_path"/)
  const config = await read('files/etc/config/ourfreemodel')
  assert.match(config, /option free_transport 'auto'/)
  assert.match(config, /option bun_path '\/usr\/lib\/ourfreemodel\/bin\/bun'/)
})

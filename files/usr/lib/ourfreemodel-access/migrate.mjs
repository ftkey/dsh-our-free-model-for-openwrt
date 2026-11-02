import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadCredential } from './password.mjs'

const run = promisify(execFile)
const exists = file => fs.access(file).then(() => true, () => false)

const DEFAULT_DATA = '/etc/ourfreemodel'

export async function migrateLegacy({ root = '/', stopLegacy = async () => {
  try { await run('/bin/ubus', ['call', 'service', 'delete', '{"name":"ofm"}'], { timeout: 15000 }) } catch {}
} } = {}) {
  const file = relative => path.join(root, relative)
  const marker = file('etc/ourfreemodel-migrated')
  if (await fs.readFile(marker, 'utf8').then(value => value.trim() === '1', () => false)) return { migrated: false }

  const first = async base => {
    for (const suffix of ['', '.apk-save', '.opkg-save']) if (await exists(file(base + suffix))) return file(base + suffix)
  }

  const legacyConfig = await first('etc/config/openwrt-ofm')
  const legacyCredential = await first('etc/ofm-access.json')
  const legacy = legacyConfig || legacyCredential

  if (legacy) {
    await stopLegacy()
    let config = await fs.readFile(legacyConfig || file('etc/config/ourfreemodel'), 'utf8')
    config = config.replace(/(^\s*config\s+)ofm(?=\s)/gm, '$1ourfreemodel')
    if (/^\s*option\s+data_dir\s+/m.test(config)) {
      config = config.replace(/(^\s*option\s+data_dir\s+)(?:'[^']*'|"[^"]*"|\S+)/m, `$1'${DEFAULT_DATA}'`)
    } else {
      config = config.replace(/(^\s*config\s+ourfreemodel\s+'main')/m, `$1\n\toption data_dir '${DEFAULT_DATA}'`)
    }

    await fs.mkdir(file('etc/config'), { recursive: true })
    await fs.writeFile(file('etc/config/ourfreemodel'), config, { mode: 0o600 })

    const destination = file('etc/ourfreemodel-access.json')
    const configured = await loadCredential(destination).then(() => true, () => false)
    if (legacyCredential && !configured) {
      const credential = await loadCredential(legacyCredential).catch(() => undefined)
      if (credential) await fs.writeFile(destination, JSON.stringify(credential) + '\n', { mode: 0o600 })
    }
    await fs.chmod(destination, 0o600).catch(error => { if (error.code !== 'ENOENT') throw error })
  }

  const rcDir = file('etc/rc.d')
  for (const name of await fs.readdir(rcDir).catch(() => [])) {
    if (!/^[SK]\d+ofm$/.test(name)) continue
    const oldLink = path.join(rcDir, name)
    const target = await fs.readlink(oldLink).catch(() => '')
    if (path.basename(target) !== 'ofm') continue
    const newLink = path.join(rcDir, name.replace(/ofm$/, 'ourfreemodel'))
    if (!await fs.lstat(newLink).then(() => true, () => false)) await fs.symlink('../init.d/ourfreemodel', newLink)
    await fs.unlink(oldLink)
  }

  await fs.mkdir(file('etc'), { recursive: true })
  await fs.writeFile(marker, '1\n', { mode: 0o600 })
  return { migrated: Boolean(legacy) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await migrateLegacy() } catch (error) { process.stderr.write(`OurFreeModel 配置迁移失败：${error.message}\n`); process.exitCode = 1 }
}

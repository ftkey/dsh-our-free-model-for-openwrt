import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadCredential } from './password.mjs'

const run = promisify(execFile)
const exists = file => fs.access(file).then(() => true, () => false)

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
  const legacyData = file('usr/lib/ofm-data')
  const newData = file('usr/lib/ourfreemodel-data')
  const legacy = legacyConfig || legacyCredential || await exists(legacyData)
  if (legacy) {
    await stopLegacy()
    let config = await fs.readFile(legacyConfig || file('etc/config/ourfreemodel'), 'utf8')
    const match = /^\s*option\s+data_dir\s+(?:'([^']*)'|"([^"]*)"|(\S+))/m.exec(config)
    const dataDir = match ? match[1] ?? match[2] ?? match[3] : '/usr/lib/ofm-data'
    for (const directory of new Set([dataDir, '/usr/lib/ofm-data'])) {
      const lockFile = file(path.join(directory.replace(/^\//, ''), 'service.lock'))
      let lock
      try { lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) } catch {}
      if (Number.isInteger(lock?.pid) && lock.pid > 0) {
        const deadline = Date.now() + 30000
        while (true) {
          try { process.kill(lock.pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
          if (Date.now() >= deadline) throw new Error('旧 ofm 服务尚未退出，暂不迁移数据，请停止旧服务后重试')
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
    }
    // Move only our old default directory. User-chosen mount paths stay intact.
    if (await exists(legacyData) && !await exists(newData)) await fs.rename(legacyData, newData)
    if (!await exists(legacyData) && await exists(newData)) config = config.replaceAll('/usr/lib/ofm-data', '/usr/lib/ourfreemodel-data')
    config = config.replace(/(^\s*config\s+)ofm(?=\s)/gm, '$1ourfreemodel')
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

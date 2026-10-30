import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadCredential } from './password.mjs'

const run = promisify(execFile)
const exists = file => fs.access(file).then(() => true, () => false)

const OLD_DEFAULT_DATA = '/usr/lib/ourfreemodel-data'
const DEFAULT_DATA = '/etc/ourfreemodel'

async function waitUnlocked(file, directory) {
  const lockFile = file(path.join(directory.replace(/^\//, ''), 'service.lock'))
  let lock
  try { lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) } catch {}
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0) return
  const deadline = Date.now() + 30000
  while (true) {
    try { process.kill(lock.pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    if (Date.now() >= deadline) throw new Error('OurFreeModel 服务尚未退出，暂不迁移数据，请停止服务后重试')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

// 只有真正放过用户数据（settings.json 或非空的 subscriptions）才算“目录已被占用”。
async function holdsData(directory) {
  if (await exists(path.join(directory, 'settings.json'))) return true
  const entries = await fs.readdir(path.join(directory, 'subscriptions')).catch(() => [])
  return entries.length > 0
}

// 把早期的 /usr/lib/ourfreemodel-data 迁到 /etc 下，保证 sysupgrade 保留配置升级时不丢账号与用量。
// 旧目录是唯一的历史数据源，因此迁移时老数据优先；新目录里服务刚生成的默认文件会被覆盖。
// 幂等：旧目录搬完即删除，下次调用直接返回 false。
async function relocateDefaultData(file) {
  const oldDir = file(OLD_DEFAULT_DATA.replace(/^\//, ''))
  const newDir = file(DEFAULT_DATA.replace(/^\//, ''))
  if (!await exists(oldDir)) return false
  // 新旧目录都可能被服务实例占用，两边都要确认已经停写。
  await waitUnlocked(file, OLD_DEFAULT_DATA)
  await waitUnlocked(file, DEFAULT_DATA)
  await fs.mkdir(path.dirname(newDir), { recursive: true })
  try {
    // 目标为空或不存在时直接改名，最省事。
    await fs.rename(oldDir, newDir)
  } catch {
    // 目标已有服务生成的目录（目录非空时 rename 会失败）：按“老数据优先”合并，再删旧目录。
    if (await exists(newDir) && await holdsData(newDir)) {
      await fs.cp(oldDir, newDir, { recursive: true, force: true })
      await fs.rm(oldDir, { recursive: true, force: true })
    } else {
      await fs.rm(newDir, { recursive: true, force: true })
      await fs.rename(oldDir, newDir)
    }
  }
  const configFile = file('etc/config/ourfreemodel')
  const config = await fs.readFile(configFile, 'utf8').catch(() => undefined)
  if (config?.includes(OLD_DEFAULT_DATA)) await fs.writeFile(configFile, config.split(OLD_DEFAULT_DATA).join(DEFAULT_DATA), { mode: 0o600 })
  return true
}

export async function migrateLegacy({ root = '/', stopLegacy = async () => {
  try { await run('/bin/ubus', ['call', 'service', 'delete', '{"name":"ofm"}'], { timeout: 15000 }) } catch {}
} } = {}) {
  const file = relative => path.join(root, relative)
  const legacyData = file('usr/lib/ofm-data')
  const newData = file(OLD_DEFAULT_DATA.replace(/^\//, ''))
  // ofm-data 与 ourfreemodel-data 同时存在，说明是重命名前的旧安装且已有一份数据，
  // 此时保留两个原路径、不做 /etc 搬迁，避免把两份用户数据混在一起。
  const ambiguous = await exists(legacyData) && await exists(newData)
  const relocated = ambiguous ? false : await relocateDefaultData(file)
  const marker = file('etc/ourfreemodel-migrated')
  if (await fs.readFile(marker, 'utf8').then(value => value.trim() === '1', () => false)) return { migrated: relocated }
  const first = async base => {
    for (const suffix of ['', '.apk-save', '.opkg-save']) if (await exists(file(base + suffix))) return file(base + suffix)
  }
  const legacyConfig = await first('etc/config/openwrt-ofm')
  const legacyCredential = await first('etc/ofm-access.json')
  const legacy = legacyConfig || legacyCredential || await exists(legacyData)
  if (legacy) {
    await stopLegacy()
    let config = await fs.readFile(legacyConfig || file('etc/config/ourfreemodel'), 'utf8')
    const match = /^\s*option\s+data_dir\s+(?:'([^']*)'|"([^"]*)"|(\S+))/m.exec(config)
    const dataDir = match ? match[1] ?? match[2] ?? match[3] : '/usr/lib/ofm-data'
    for (const directory of new Set([dataDir, '/usr/lib/ofm-data'])) await waitUnlocked(file, directory)
    // Move only our old default directory. User-chosen mount paths stay intact.
    if (await exists(legacyData) && !await exists(newData)) await fs.rename(legacyData, newData)
    if (!await exists(legacyData) && await exists(newData)) config = config.split('/usr/lib/ofm-data').join(OLD_DEFAULT_DATA)
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
  // 旧目录刚改名为中间名，再走一次新旧默认目录搬迁（必须无条件执行，不能用 || 短路）。
  const finalRelocated = ambiguous ? false : await relocateDefaultData(file)
  return { migrated: Boolean(legacy) || finalRelocated || relocated }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await migrateLegacy() } catch (error) { process.stderr.write(`OurFreeModel 配置迁移失败：${error.message}\n`); process.exitCode = 1 }
}

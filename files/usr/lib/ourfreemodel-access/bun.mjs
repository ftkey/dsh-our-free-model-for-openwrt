import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInflateRaw } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_BINARY = '/usr/lib/ourfreemodel/bin/bun'
export const DEFAULT_MANIFEST = '/usr/lib/ourfreemodel/bun-assets.json'
export const DEFAULT_JOB = process.env.OURFREEMODEL_BUN_JOB || '/var/run/ourfreemodel/bun-install.json'
const DOWNLOAD_BASE = 'https://github.com/oven-sh/bun/releases/download'
const ACTIVE_STATES = ['starting', 'downloading', 'verifying', 'extracting']

// 官方 Bun 归档只有 aarch64 与 x64 的 musl 版本，与构建脚本共用同一份清单。
export function bunArch(machine = os.machine()) {
  const value = String(machine || process.arch).toLowerCase()
  if (value === 'aarch64' || value === 'arm64') return 'aarch64'
  if (value === 'x86_64' || value === 'amd64' || value === 'x64') return 'x64'
  throw new Error(`不支持的架构：${machine}；Bun 运行时目前仅提供 aarch64 与 x64`)
}

export async function bunAsset({ manifestFile = DEFAULT_MANIFEST, machine } = {}) {
  let manifest
  try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) } catch { throw new Error('Bun 资产清单缺失或无效') }
  const arch = bunArch(machine)
  const asset = manifest.assets?.[arch]
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version)) || !asset) throw new Error('Bun 资产清单不完整')
  if (!/^[A-Za-z0-9._-]+$/.test(String(asset.file)) || !/^[a-f0-9]{64}$/i.test(String(asset.sha256)) || !asset.binary) {
    throw new Error('Bun 资产清单不完整')
  }
  return {
    arch, version: manifest.version, file: asset.file, sha256: asset.sha256.toLowerCase(),
    member: asset.binary, url: `${DOWNLOAD_BASE}/bun-v${manifest.version}/${asset.file}`,
  }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await fs.rename(`${file}.tmp`, file)
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function activeJob(job) {
  if (!job || !ACTIVE_STATES.includes(job.state)) return false
  if (job.pid) return alive(job.pid)
  return Date.now() - Number(job.startedAt || 0) < 60_000
}

async function bunInstaller(pid) {
  if (!alive(pid)) return false
  try { return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('bun.mjs') } catch { return false }
}

export async function bunStatus({ binaryFile = DEFAULT_BINARY, manifestFile = DEFAULT_MANIFEST, jobFile = DEFAULT_JOB, machine } = {}) {
  const stat = await fs.stat(binaryFile).then(value => value.isFile() ? value : null, () => null)
  let asset = null, error = ''
  try { asset = await bunAsset({ manifestFile, machine }) } catch (failure) { error = failure.message }
  let arch = null
  try { arch = bunArch(machine) } catch {}
  const stamp = stat ? await readJson(`${binaryFile}.json`) : null
  const recorded = await readJson(jobFile)
  const job = recorded && (activeJob(recorded) || ['done', 'error'].includes(recorded.state)) ? recorded : null
  return {
    installed: Boolean(stat), path: binaryFile, size: stat?.size ?? 0,
    version: stamp?.version || null, arch, available: Boolean(asset), error,
    manifestVersion: asset?.version ?? null, job,
  }
}

async function download(url, file, { fetchImpl = fetch, onProgress } = {}) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`下载 Bun 失败（HTTP ${response.status}）`)
  const total = Number(response.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  let received = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', chunk => {
    received += chunk.length
    hash.update(chunk)
    onProgress?.({ received, total })
  })
  await pipeline(source, createWriteStream(file, { mode: 0o600 }))
  return hash.digest('hex')
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) throw new Error('Bun 归档已损坏')
  return buffer
}

function readZip64Extra(extra, values) {
  let offset = 0
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset), size = extra.readUInt16LE(offset + 2)
    if (id === 0x0001) {
      let cursor = offset + 4
      for (const key of ['uncompressed', 'compressed', 'offset']) {
        if (values[key] !== 0xFFFFFFFF) continue
        if (cursor + 8 > offset + 4 + size) throw new Error('Bun 归档 ZIP64 信息不完整')
        values[key] = Number(extra.readBigUInt64LE(cursor))
        cursor += 8
      }
      return
    }
    offset += 4 + size
  }
  throw new Error('Bun 归档缺少 ZIP64 信息')
}

// 只解出清单指定的单个成员，不依赖路由器上未必存在的 unzip。
async function extractMember(archive, member, destination) {
  const handle = await fs.open(archive, 'r')
  try {
    const size = (await handle.stat()).size
    const tailLength = Math.min(size, 22 + 0xFFFF)
    const tail = await readAt(handle, size - tailLength, tailLength)
    let eocd = -1
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50) { eocd = index; break }
    }
    if (eocd < 0) throw new Error('Bun 归档不是有效的 ZIP')
    let offset = tail.readUInt32LE(eocd + 16)
    if (offset === 0xFFFFFFFF) {
      const locator = size - tailLength + eocd - 20
      if (locator < 0) throw new Error('Bun 归档 ZIP64 定位信息缺失')
      const record = await readAt(handle, locator, 20)
      if (record.readUInt32LE(0) !== 0x07064b50) throw new Error('Bun 归档 ZIP64 定位信息无效')
      const zip64 = await readAt(handle, Number(record.readBigUInt64LE(8)), 56)
      if (zip64.readUInt32LE(0) !== 0x06064b50) throw new Error('Bun 归档 ZIP64 目录无效')
      offset = Number(zip64.readBigUInt64LE(48))
    }
    const central = await readAt(handle, offset, size - offset)
    let cursor = 0
    while (cursor + 46 <= central.length && central.readUInt32LE(cursor) === 0x02014b50) {
      const flags = central.readUInt16LE(cursor + 8)
      const method = central.readUInt16LE(cursor + 10)
      const values = {
        compressed: central.readUInt32LE(cursor + 20),
        uncompressed: central.readUInt32LE(cursor + 24),
        offset: central.readUInt32LE(cursor + 42),
      }
      const nameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const nameStart = cursor + 46
      const extraStart = nameStart + nameLength
      const name = central.subarray(nameStart, extraStart).toString('utf8')
      const extra = central.subarray(extraStart, extraStart + extraLength)
      if (values.compressed === 0xFFFFFFFF || values.uncompressed === 0xFFFFFFFF || values.offset === 0xFFFFFFFF) {
        readZip64Extra(extra, values)
      }
      if (name === member) {
        if (flags & 0x1) throw new Error('Bun 归档已加密')
        if (method !== 0 && method !== 8) throw new Error('Bun 归档使用了不支持的压缩算法')
        const local = await readAt(handle, values.offset, 30)
        if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Bun 归档本地头无效')
        const dataStart = values.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
        if (values.compressed <= 0) throw new Error('Bun 运行时文件为空')
        await fs.rm(destination, { force: true })
        const input = createReadStream(archive, { start: dataStart, end: dataStart + values.compressed - 1 })
        const output = createWriteStream(destination, { mode: 0o600 })
        if (method === 8) await pipeline(input, createInflateRaw(), output)
        else await pipeline(input, output)
        const written = (await fs.stat(destination)).size
        if (values.uncompressed && written !== values.uncompressed) throw new Error('Bun 运行时解压不完整')
        return
      }
      cursor = extraStart + extraLength + commentLength
    }
    throw new Error(`Bun 归档中找不到 ${member}`)
  } finally {
    await handle.close()
  }
}

export async function installBun({ binaryFile = DEFAULT_BINARY, manifestFile = DEFAULT_MANIFEST, jobFile = DEFAULT_JOB,
  machine, fetchImpl = fetch } = {}) {
  const dir = path.dirname(binaryFile)
  const archive = path.join(dir, `.bun-install-${process.pid}.zip`)
  const temporary = path.join(dir, `.bun-install-${process.pid}.tmp`)
  const startedAt = Date.now()
  let asset, lastProgress = 0
  let writes = Promise.resolve()
  const update = details => {
    writes = writes.then(() => writeJson(jobFile, { pid: process.pid, startedAt, ...details })).catch(() => {})
    return writes
  }
  try {
    asset = await bunAsset({ manifestFile, machine })
    await fs.mkdir(dir, { recursive: true, mode: 0o755 })
    await update({ state: 'downloading', version: asset.version, received: 0, total: 0 })
    const digest = await download(asset.url, archive, {
      fetchImpl,
      onProgress: ({ received, total }) => {
        const now = Date.now()
        if (now - lastProgress < 1000 && received !== total) return
        lastProgress = now
        void update({ state: 'downloading', version: asset.version, received, total })
      },
    })
    await update({ state: 'verifying', version: asset.version })
    if (digest !== asset.sha256) throw new Error('Bun 运行时校验失败（SHA256 不匹配）')
    await update({ state: 'extracting', version: asset.version })
    await extractMember(archive, asset.member, temporary)
    await fs.rm(archive, { force: true }).catch(() => {})
    await fs.chmod(temporary, 0o755)
    await fs.rename(temporary, binaryFile)
    await fs.writeFile(`${binaryFile}.json`, JSON.stringify({ version: asset.version, sha256: asset.sha256, installedAt: Date.now() }), { mode: 0o600 })
    await update({ state: 'done', version: asset.version, finishedAt: Date.now() })
    return { ok: true, version: asset.version }
  } catch (error) {
    await fs.rm(archive, { force: true }).catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    await update({ state: 'error', version: asset?.version, error: error.message, finishedAt: Date.now() })
    throw error
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {})
  }
}

export async function removeBun({ binaryFile = DEFAULT_BINARY, jobFile = DEFAULT_JOB } = {}) {
  const job = await readJson(jobFile)
  if (activeJob(job) && await bunInstaller(job.pid)) {
    try { process.kill(job.pid, 'SIGTERM') } catch {}
    for (let attempt = 0; attempt < 20 && alive(job.pid); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  }
  const dir = path.dirname(binaryFile)
  await fs.rm(binaryFile, { force: true })
  await fs.rm(`${binaryFile}.json`, { force: true })
  const leftovers = await fs.readdir(dir).catch(() => [])
  await Promise.all(leftovers.filter(name => /^\.bun-install-.*\.(zip|tmp)$/.test(name)).map(name => fs.rm(path.join(dir, name), { force: true })))
  await fs.rm(jobFile, { force: true })
  return { ok: true }
}

export async function startBunInstall({ jobFile = DEFAULT_JOB, moduleFile = fileURLToPath(import.meta.url), spawnImpl = spawn } = {}) {
  const current = await readJson(jobFile)
  if (activeJob(current)) return { started: false, active: true, job: current }
  await writeJson(jobFile, { state: 'starting', pid: null, startedAt: Date.now() })
  let child
  try {
    child = spawnImpl(process.execPath, [moduleFile, 'install'], {
      detached: true, stdio: 'ignore', env: { ...process.env, OURFREEMODEL_BUN_JOB: jobFile },
    })
  } catch (error) {
    await writeJson(jobFile, { state: 'error', error: error.message, startedAt: Date.now() })
    throw error
  }
  child.unref()
  child.on('error', error => { void writeJson(jobFile, { state: 'error', error: error.message, startedAt: Date.now() }) })
  return { started: true, pid: child.pid }
}

async function main() {
  const command = process.argv[2]
  if (command === 'install') await installBun()
  else if (command === 'remove') await removeBun()
  else if (command === 'status') process.stdout.write(`${JSON.stringify(await bunStatus())}\n`)
  else throw new Error('用法: bun.mjs <install|remove|status>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}

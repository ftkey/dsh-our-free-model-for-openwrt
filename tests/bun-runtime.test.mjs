import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { bunArch, bunAsset, bunStatus, installBun, removeBun } from '../files/usr/lib/ourfreemodel-access/bun.mjs'
import { createControl } from '../files/usr/lib/ourfreemodel-access/control.mjs'

function zip(files) {
  const locals = [], centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const data = Buffer.from(file.data)
    const compressed = file.deflate ? deflateRawSync(data) : data
    const method = file.deflate ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const localRecord = Buffer.concat([local, name, compressed])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(localRecord)
    centrals.push(Buffer.concat([central, name]))
    offset += localRecord.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

async function fixture(t, { deflate = true, sha } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ourfreemodel-bun-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const member = 'bun-linux-x64-musl/bun'
  const archive = zip([{ name: member, data: '#!/bin/sh\necho bun 1.4.4\n', deflate }])
  const manifestFile = path.join(dir, 'bun-assets.json')
  await fs.writeFile(manifestFile, JSON.stringify({
    version: '1.4.4',
    assets: { x64: { file: 'bun-linux-x64-musl.zip', sha256: sha || createHash('sha256').update(archive).digest('hex'), binary: member } },
  }))
  return {
    dir, archive, member, manifestFile,
    binaryFile: path.join(dir, 'bin', 'bun'),
    jobFile: path.join(dir, 'bun-install.json'),
    fetchImpl: async () => new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } }),
  }
}

test('Bun 架构映射与资产清单只接受受支持的官方归档', async t => {
  assert.equal(bunArch('aarch64'), 'aarch64')
  assert.equal(bunArch('x86_64'), 'x64')
  assert.throws(() => bunArch('mips'), /不支持的架构/)
  const { manifestFile } = await fixture(t)
  const asset = await bunAsset({ manifestFile, machine: 'x86_64' })
  assert.equal(asset.url, 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64-musl.zip')
  await fs.writeFile(manifestFile, JSON.stringify({ version: '1.4.4', assets: { x64: { file: '../bun.zip', sha256: 'a'.repeat(64), binary: 'bun' } } }))
  await assert.rejects(bunAsset({ manifestFile, machine: 'x86_64' }), /清单不完整/)
})

test('下载 Bun 时校验 SHA256、解压单个成员并可移除', async t => {
  const file = await fixture(t)
  const result = await installBun({ binaryFile: file.binaryFile, manifestFile: file.manifestFile, jobFile: file.jobFile, machine: 'x86_64', fetchImpl: file.fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(await fs.readFile(file.binaryFile, 'utf8'), '#!/bin/sh\necho bun 1.4.4\n')
  assert.equal((await fs.stat(file.binaryFile)).mode & 0o777, 0o755)
  const status = await bunStatus({ binaryFile: file.binaryFile, manifestFile: file.manifestFile, jobFile: file.jobFile, machine: 'x86_64' })
  assert.equal(status.installed, true)
  assert.equal(status.version, '1.4.4')
  assert.equal(status.job.state, 'done')
  await removeBun({ binaryFile: file.binaryFile, jobFile: file.jobFile })
  assert.equal((await bunStatus({ binaryFile: file.binaryFile, manifestFile: file.manifestFile, jobFile: file.jobFile, machine: 'x86_64' })).installed, false)
})

test('Bun 归档校验失败或缺少成员时不留下运行时文件', async t => {
  const wrong = await fixture(t, { sha: '0'.repeat(64) })
  await assert.rejects(installBun({ binaryFile: wrong.binaryFile, manifestFile: wrong.manifestFile, jobFile: wrong.jobFile, machine: 'x86_64', fetchImpl: wrong.fetchImpl }), /SHA256/)
  assert.equal((await bunStatus({ binaryFile: wrong.binaryFile, manifestFile: wrong.manifestFile, jobFile: wrong.jobFile, machine: 'x86_64' })).installed, false)
  assert.equal((await fs.readFile(wrong.jobFile, 'utf8')).includes('"state":"error"'), true)

  const missing = await fixture(t)
  const archive = zip([{ name: 'other/bun', data: 'nope' }])
  await fs.writeFile(missing.manifestFile, JSON.stringify({ version: '1.4.4', assets: { x64: {
    file: 'bun-linux-x64-musl.zip', sha256: createHash('sha256').update(archive).digest('hex'), binary: 'bun-linux-x64-musl/bun' } } }))
  await assert.rejects(installBun({ binaryFile: missing.binaryFile, manifestFile: missing.manifestFile, jobFile: missing.jobFile,
    machine: 'x86_64', fetchImpl: async () => new Response(archive) }), /找不到/)
  assert.equal((await bunStatus({ binaryFile: missing.binaryFile, manifestFile: missing.manifestFile, jobFile: missing.jobFile, machine: 'x86_64' })).installed, false)
})

test('LuCI 控制器暴露 Bun 状态并转发安装、移除操作', async t => {
  const file = await fixture(t)
  let started = 0
  const control = createControl({
    credentialFile: path.join(file.dir, 'credential.json'), secretFile: path.join(file.dir, 'secret'),
    stateFile: path.join(file.dir, 'state.json'), versionFile: path.join(file.dir, 'version.json'),
    run: async () => ({ stdout: '' }),
    bun: { binaryFile: file.binaryFile, manifestFile: file.manifestFile, jobFile: file.jobFile, machine: 'x86_64' },
    startBun: async () => { started++; return { started: true, pid: 42 } },
  })
  assert.equal((await control.status()).bun.installed, false)
  assert.equal((await control.bun_install()).pid, 42)
  assert.equal(started, 1)
  await installBun({ binaryFile: file.binaryFile, manifestFile: file.manifestFile, jobFile: file.jobFile, machine: 'x86_64', fetchImpl: file.fetchImpl })
  assert.equal((await control.status()).bun.installed, true)
  assert.equal((await control.bun_remove()).ok, true)
  assert.equal((await control.status()).bun.installed, false)
})

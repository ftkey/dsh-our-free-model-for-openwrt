import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

const scrypt = promisify(crypto.scrypt)
const CREDENTIAL_FILE = '/etc/ourfreemodel-access.json'
const SECRET_FILE = '/etc/ourfreemodel-webui-secret'
// 去掉易混淆的 i l o 0 1，方便在手机上手动抄录。
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function randomPassword(length = 16) {
  let value = ''
  for (let index = 0; index < length; index++) value += ALPHABET[crypto.randomInt(ALPHABET.length)]
  return value
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('WebUI 管理密码长度必须为 12–128 个字符')
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = await scrypt(password, salt, 32)
  return { algorithm: 'scrypt', salt, hash: hash.toString('hex') }
}

export async function loadCredential(file) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'))
  if (value.algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{64}$/.test(value.hash)) {
    throw new Error('尚未配置 WebUI 密码，请在 LuCI OurFreeModel 中设置，或运行 /etc/init.d/ourfreemodel password')
  }
  return value
}

export async function verifyPassword(password, credential) {
  if (typeof password !== 'string' || password.length > 128) return false
  const actual = await scrypt(password, credential.salt, 32)
  return crypto.timingSafeEqual(actual, Buffer.from(credential.hash, 'hex'))
}

export async function saveCredential(file, password) {
  const credential = await hashPassword(password)
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(credential) + '\n', { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

// 仅用于让 LuCI 展示并复制初始随机密码；权限 0600，仅 root 可读。
export async function saveSecret(file, password) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, `${password}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export async function loadSecret(file) {
  try {
    const value = (await fs.readFile(file, 'utf8')).trim()
    return value.length >= 12 && value.length <= 128 && !/\s/.test(value) ? value : ''
  } catch {
    return ''
  }
}

export async function removeSecret(file) {
  await fs.rm(file, { force: true })
}

// 首次安装或密码文件缺失时生成随机密码；已有密码时不做任何改动。
export async function ensureCredential({ credentialFile = CREDENTIAL_FILE, secretFile = SECRET_FILE } = {}) {
  try {
    await loadCredential(credentialFile)
    return { created: false }
  } catch {}
  const password = randomPassword()
  await saveCredential(credentialFile, password)
  await saveSecret(secretFile, password)
  return { created: true, password }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // generate：首次初始化随机密码，已有密码则不改动，供安装脚本与服务启动调用。
  if (process.argv[2] === 'generate') {
    try {
      const result = await ensureCredential()
      // 不把密码写进安装日志或 syslog，只在 LuCI 中展示。
      process.stdout.write(result.created
        ? '已生成 WebUI 随机密码，可在 LuCI → 服务 → OurFreeModel 查看并复制。\n'
        : 'WebUI 密码已存在，未改动。\n')
    } catch (error) {
      process.stderr.write(`随机密码初始化失败：${error.message}\n`)
      process.exitCode = 1
    }
  } else {
    const credentialFile = process.argv[2] ?? CREDENTIAL_FILE
    // readline writes typed characters to this silent output instead of the terminal.
    const silent = new Writable({ write(chunk, encoding, done) { done() } })
    const rl = createInterface({ input: process.stdin, output: silent, terminal: Boolean(process.stdin.isTTY) })
    try {
      if (!process.stdin.isTTY) throw new Error('请在 SSH 交互终端中设置密码')
      process.stdout.write('设置 WebUI 管理密码（12–128 个字符，输入不显示）：')
      const password = await rl.question('')
      process.stdout.write('\n再次输入：')
      const confirmation = await rl.question('')
      process.stdout.write('\n')
      if (password !== confirmation) throw new Error('两次密码不一致，未修改配置')
      await saveCredential(credentialFile, password)
      // 手动设置的密码不留明文副本，LuCI 只显示“已设置”。
      await removeSecret(SECRET_FILE)
      process.stdout.write('WebUI 管理密码已保存。\n')
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    } finally { rl.close() }
  }
}

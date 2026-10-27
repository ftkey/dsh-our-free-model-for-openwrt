import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

const scrypt = promisify(crypto.scrypt)

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
    throw new Error('尚未配置 WebUI 密码，请在 LuCI OurFreeModel 中设置，或运行 /etc/init.d/ofm password')
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
    await saveCredential(process.argv[2] ?? '/etc/ofm-access.json', password)
    process.stdout.write('WebUI 管理密码已保存。\n')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  } finally { rl.close() }
}

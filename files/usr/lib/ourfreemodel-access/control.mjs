import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadCredential, loadSecret, randomPassword, removeSecret, saveCredential, saveSecret } from './password.mjs'

const execute = promisify(execFile)
export const METHODS = { status: {}, password: {}, reset_password: {}, set_password: { password: '', confirmation: '' }, service: { action: '' } }

export function createControl({ credentialFile = '/etc/ourfreemodel-access.json', secretFile = '/etc/ourfreemodel-webui-secret',
  stateFile = '/var/run/ourfreemodel/status.json', versionFile = '/usr/lib/ourfreemodel/PORT-VERSION.json',
  run = (file, args) => execute(file, args, { timeout: 15000, maxBuffer: 65536 }) } = {}) {
  const reload = async () => {
    try { await run('/etc/init.d/ourfreemodel', ['reload_password']); return true } catch { return false }
  }
  return {
    async status() {
      let runtime = {}, processes = {}, version = '', autostart = false
      try { runtime = JSON.parse(await fs.readFile(stateFile, 'utf8')) } catch {}
      try { version = JSON.parse(await fs.readFile(versionFile, 'utf8')).version } catch {}
      try { processes = JSON.parse((await run('/bin/ubus', ['call', 'service', 'list', '{"name":"ourfreemodel"}'])).stdout) } catch {}
      try { await run('/etc/init.d/ourfreemodel', ['enabled']); autostart = true } catch {}
      const instance = Object.values(processes.ourfreemodel?.instances ?? {}).find(row => row.running === true)
      const current = instance && instance.pid === runtime.pid
      const endpoint = kind => current ? runtime[kind] ?? { running: false } : { running: false }
      return {
        running: Boolean(instance), autostart, version, nodeVersion: process.version,
        passwordSet: await loadCredential(credentialFile).then(() => true, () => false),
        passwordVisible: Boolean(await loadSecret(secretFile)),
        startedAt: current ? runtime.startedAt : null, dataDir: runtime.dataDir ?? '',
        error: runtime.error ?? '', api: endpoint('api'), web: endpoint('web'),
      }
    },
    // 供 LuCI 展示并复制初始随机密码；手动设置的密码不留明文，返回空字符串。
    async password() {
      return { password: await loadSecret(secretFile) }
    },
    async reset_password() {
      const password = randomPassword()
      await saveCredential(credentialFile, password)
      await saveSecret(secretFile, password)
      const reloaded = await reload()
      return { ok: true, password, reloaded, message: '已生成新的随机 WebUI 密码，旧管理会话已失效；模型 API 不受影响。' }
    },
    async set_password({ password, confirmation }) {
      if (typeof password !== 'string' || password !== confirmation) throw new Error('两次输入的 WebUI 密码不一致')
      await saveCredential(credentialFile, password)
      // 手动设置的密码不保存明文，避免 LuCI 继续显示已失效的旧随机密码。
      await removeSecret(secretFile)
      const reloaded = await reload()
      return { ok: true, reloaded, message: reloaded ? 'WebUI 密码已更新，旧管理会话已失效；模型 API 不受影响。' : '密码已保存，请启动或重新加载 WebUI。' }
    },
    async service({ action }) {
      if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw new Error('不支持的服务操作')
      try { await run('/etc/init.d/ourfreemodel', [action]) } catch { throw new Error('服务操作失败，请检查系统日志') }
      return { ok: true }
    },
  }
}

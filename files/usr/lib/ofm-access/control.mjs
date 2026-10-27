import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadCredential, saveCredential } from './password.mjs'

const execute = promisify(execFile)
export const METHODS = { status: {}, set_password: { password: '', confirmation: '' }, service: { action: '' } }

export function createControl({ credentialFile = '/etc/ofm-access.json', stateFile = '/var/run/ofm/status.json',
  versionFile = '/usr/lib/ofm/PORT-VERSION.json', run = (file, args) => execute(file, args, { timeout: 15000, maxBuffer: 65536 }) } = {}) {
  return {
    async status() {
      let runtime = {}, processes = {}, version = '', autostart = false
      try { runtime = JSON.parse(await fs.readFile(stateFile, 'utf8')) } catch {}
      try { version = JSON.parse(await fs.readFile(versionFile, 'utf8')).version } catch {}
      try { processes = JSON.parse((await run('/bin/ubus', ['call', 'service', 'list', '{"name":"ofm"}'])).stdout) } catch {}
      try { await run('/etc/init.d/ofm', ['enabled']); autostart = true } catch {}
      const instance = Object.values(processes.ofm?.instances ?? {}).find(row => row.running === true)
      const current = instance && instance.pid === runtime.pid
      const endpoint = kind => current ? runtime[kind] ?? { running: false } : { running: false }
      return {
        running: Boolean(instance), autostart, version, nodeVersion: process.version,
        passwordSet: await loadCredential(credentialFile).then(() => true, () => false),
        startedAt: current ? runtime.startedAt : null, dataDir: runtime.dataDir ?? '',
        error: runtime.error ?? '', api: endpoint('api'), web: endpoint('web'),
      }
    },
    async set_password({ password, confirmation }) {
      if (typeof password !== 'string' || password !== confirmation) throw new Error('两次输入的 WebUI 密码不一致')
      await saveCredential(credentialFile, password)
      let reloaded = true
      try { await run('/etc/init.d/ofm', ['reload_password']) } catch { reloaded = false }
      return { ok: true, reloaded, message: reloaded ? 'WebUI 密码已更新，旧管理会话已失效；模型 API 不受影响。' : '密码已保存，请启动或重新加载 WebUI。' }
    },
    async service({ action }) {
      if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw new Error('不支持的服务操作')
      try { await run('/etc/init.d/ofm', [action]) } catch { throw new Error('服务操作失败，请检查系统日志') }
      return { ok: true }
    },
  }
}

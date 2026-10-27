import fs from 'node:fs/promises'
import { startStandalone } from '../ofm/packages/standalone/service.mjs'
import { loadCredential } from './password.mjs'
import { startAccessGateway } from './gateway.mjs'

let service, gateway
try {
  const credential = await loadCredential('/etc/ofm-access.json')
  const port = Number(process.env.OFM_PORT ?? 18900)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535')
  service = await startStandalone({ dataDir: process.env.OFM_HOME, port: 0, lanEnabled: false })
  const settings = JSON.parse(await fs.readFile(service.keyFile, 'utf8'))
  gateway = await startAccessGateway({
    targetUrl: service.url, managementKey: settings.managementKey, credential,
    host: process.env.OFM_HOST ?? '0.0.0.0', port,
    publicOrigin: process.env.OFM_PUBLIC_ORIGIN || undefined,
  })
  process.stdout.write(`Our Free Model 密码保护端口：${gateway.port}；管理会话有效期 8 小时\n`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    try { await gateway.close(); await service.close() } catch { process.exitCode = 1 }
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
} catch (error) {
  process.stderr.write(`启动失败：${error.message}\n`)
  await gateway?.close()
  await service?.close()
  process.exitCode = 1
}

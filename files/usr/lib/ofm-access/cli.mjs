import fs from 'node:fs/promises'
import { startStandalone } from '../ofm/packages/standalone/service.mjs'
import { loadCredential } from './password.mjs'
import { startAccessGateway } from './gateway.mjs'
import { startApiGateway } from './api.mjs'
import { resolveBinding, parsePort, httpAddress } from './bind.mjs'

const stateFile = '/var/run/ofm/status.json'
const state = { pid: process.pid, startedAt: Date.now(), dataDir: process.env.OFM_HOME,
  api: { running: false }, web: { running: false } }
let service, api, web, closing = false
let changes = Promise.resolve()
const saveState = async () => {
  await fs.mkdir('/var/run/ofm', { recursive: true, mode: 0o700 })
  await fs.writeFile(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 })
  await fs.rename(stateFile + '.tmp', stateFile)
}
const endpoint = async (kind, defaultPort) => {
  const iface = process.env[`OFM_${kind}_INTERFACE`] || 'lan'
  const port = parsePort(process.env[`OFM_${kind}_PORT`] || defaultPort, kind === 'API' ? 'API' : 'WebUI')
  const host = await resolveBinding(iface, process.env[`OFM_${kind}_ADDRESS`] || '')
  return { interface: iface, host, port, url: httpAddress(host, port) }
}
const close = async () => {
  if (closing) return
  closing = true
  await changes.catch(() => {})
  await web?.close()
  await api?.close()
  await service?.close()
  await fs.rm(stateFile, { force: true })
}
try {
  const apiPort = parsePort(process.env.OFM_API_PORT || '18900', 'API')
  const webPort = parsePort(process.env.OFM_WEB_PORT || '18901', 'WebUI')
  if (apiPort === webPort) throw new Error('API 与 WebUI 必须使用不同端口')
  service = await startStandalone({ dataDir: process.env.OFM_HOME, port: 0, lanEnabled: false,
    startRelay: async () => { throw new Error('API 接口和端口由 LuCI OurFreeModel 配置') } })
  state.dataDir = service.dataDir
  state.version = service.version
  try {
    const binding = await endpoint('API', apiPort)
    api = await startApiGateway({ targetUrl: service.url, ...binding, getApiKey: () => service.runtime.state().settings.forwardKey })
    state.api = { ...binding, running: true }
  } catch (error) { state.api.error = `API 启动失败：${error.message}` }
  const reloadWeb = async () => {
    await web?.close()
    web = undefined
    state.web = { running: false }
    try {
      const credential = await loadCredential('/etc/ofm-access.json')
      const binding = await endpoint('WEB', webPort)
      const settings = JSON.parse(await fs.readFile(service.keyFile, 'utf8'))
      web = await startAccessGateway({
        targetUrl: service.url, managementKey: settings.managementKey, credential, ...binding,
        publicOrigin: process.env.OFM_WEB_PUBLIC_ORIGIN || undefined,
        apiBaseUrl: req => {
          if (!state.api.running) return httpAddress('127.0.0.1', apiPort)
          const host = ['0.0.0.0', '::'].includes(state.api.host) ? new URL(`http://${req.headers.host}`).hostname : state.api.host
          return httpAddress(host, state.api.port)
        },
      })
      state.web = { ...binding, url: process.env.OFM_WEB_PUBLIC_ORIGIN || binding.url, running: true }
    } catch (error) { state.web.error = `WebUI 启动失败：${error.message}` }
    await saveState()
  }
  await reloadWeb()
  for (const kind of ['api', 'web']) {
    process.stdout.write(`${kind.toUpperCase()}：${state[kind].running ? state[kind].url : state[kind].error}\n`)
  }
  process.on('SIGHUP', () => {
    if (!closing) changes = changes.then(reloadWeb).catch(() => { process.stderr.write('重新加载 WebUI 密码失败\n') })
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void close().catch(() => { process.exitCode = 1 })
  })
} catch (error) {
  state.error = error.message
  await saveState().catch(() => {})
  process.stderr.write(`启动失败：${error.message}\n`)
  await web?.close()
  await api?.close()
  await service?.close()
  process.exitCode = 1
}

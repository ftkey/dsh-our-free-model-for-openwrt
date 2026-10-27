import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import os from 'node:os'

const run = promisify(execFile)

export function parsePort(value, name) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${name}端口必须为 1–65535`)
  return Number(value)
}

export async function resolveBinding(iface, address = '', { query = async name => {
  const { stdout } = await run('/bin/ubus', ['call', `network.interface.${name}`, 'status'], { timeout: 5000, maxBuffer: 65536 })
  return JSON.parse(stdout)
}, interfaces = os.networkInterfaces } = {}) {
  if (iface === '*') {
    if (!address) return '0.0.0.0'
    const local = Object.values(interfaces()).flat().map(entry => entry.address)
    if (!net.isIP(address) || !local.includes(address)) throw new Error('指定监听地址不是路由器当前本地 IP')
    return address
  }
  if (!/^[a-zA-Z0-9_]+$/.test(iface)) throw new Error('请选择有效的路由器网络接口')
  let status
  try { status = await query(iface) } catch { throw new Error(`接口 ${iface} 无法读取，请检查接口是否存在`) }
  const addresses = [...(status['ipv4-address'] ?? []), ...(status['ipv6-address'] ?? []),
    ...(status['ipv6-prefix-assignment'] ?? []).map(entry => entry['local-address']).filter(Boolean)]
    .map(entry => entry.address).filter(net.isIP)
  if (status.up !== true || !addresses.length) throw new Error(`接口 ${iface} 未启用或没有可用本地 IP`)
  if (address && !addresses.includes(address)) throw new Error(`指定 IP 不属于接口 ${iface}`)
  return address || addresses[0]
}

export function httpAddress(host, port) {
  return `http://${net.isIPv6(host) ? `[${host}]` : host}:${port}`
}

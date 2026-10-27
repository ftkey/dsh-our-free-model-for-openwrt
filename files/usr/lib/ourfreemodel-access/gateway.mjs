import http from 'node:http'
import crypto from 'node:crypto'
import { verifyPassword } from './password.mjs'

const LOGIN = '/ourfreemodel-access/login'
const SESSION_MS = 8 * 60 * 60_000
const CLIENT = `const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const path = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href).pathname;
  if (path.startsWith('/api/management/') && (response.status === 401 || (path === '/api/management/logout' && response.ok))) {
    location.replace('/ourfreemodel-access/login');
  }
  return response;
};`
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Our Free Model · WebUI 登录</title>
<style>body{margin:0;background:#f5f6f8;color:#1f2937;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{box-sizing:border-box;background:white;padding:32px;border-radius:16px;box-shadow:0 8px 32px #0001;width:min(92vw,400px)}h1{font-size:24px}p{color:#64748b;line-height:1.6}label{display:block;margin:24px 0 8px}input,button{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #cbd5e1;border-radius:8px}button{margin-top:20px;background:#0f766e;color:white;border:0;cursor:pointer}</style>
<main><h1>Our Free Model</h1><p>请输入 WebUI 管理密码，验证后进入原管理页面。</p><form method="post" action="${LOGIN}"><label for="password">WebUI 管理密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128" autofocus><button type="submit">验证并进入</button></form></main></html>`

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
export function cleanHeaders(headers) {
  const blocked = new Set([...HOP, ...String(headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())))
}

export async function startAccessGateway({ targetUrl, managementKey, credential, host = '127.0.0.1', port = 18901, publicOrigin, apiBaseUrl,
  sessionMs = SESSION_MS, now = Date.now }) {
  const target = new URL(targetUrl)
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:') throw new Error('内部服务必须为 IPv4 本机 HTTP 地址')
  if (publicOrigin) {
    const parsed = new URL(publicOrigin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== publicOrigin) throw new Error('public_origin 必须为完整 HTTP(S) 来源，不包含路径')
  }
  const sessions = new Map()
  const failures = new Map()
  let activeChecks = 0
  let cookieName
  const json = (res, status, error, headers = {}) => {
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify({ error }))
  }
  const loginPage = (res, status = 200, message = '', headers = {}) => {
    res.writeHead(status, { ...HEADERS, 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(message ? PAGE.replace('<form ', `<p role="alert">${message}</p><form `) : PAGE)
  }
  const origin = req => publicOrigin || new URL(`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`).origin
  const cookie = (id, req, maxAge) => `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin(req).startsWith('https:') ? '; Secure' : ''}`
  const sessionId = req => String(req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  const revoke = entry => {
    void fetch(new URL('/api/management/logout', target), {
      method: 'POST', headers: { cookie: entry.upstreamCookie, 'content-type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(5000),
    }).then(response => response.arrayBuffer()).catch(() => {})
  }
  const prune = () => {
    for (const [id, entry] of sessions) if (entry.until <= now()) { sessions.delete(id); revoke(entry) }
    for (const [id, entry] of failures) if (entry.until <= now()) failures.delete(id)
  }
  const sameOrigin = req => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    try {
      const own = origin(req)
      return ['origin', 'referer'].every(key => req.headers[key] === undefined || new URL(req.headers[key]).origin === own)
    } catch { return false }
  }
  const check = async (password, req, res, html = false) => {
    const reject = (status, message, headers) => html ? loginPage(res, status, message, headers) : json(res, status, message, headers)
    const ip = req.socket.remoteAddress
    if ((failures.get(ip)?.count ?? 0) >= 5 || activeChecks >= 2 || failures.size >= 1024) {
      reject(429, '验证过于频繁，请稍后重试（连续失败后等待 15 分钟）', { 'retry-after': '900' })
      return false
    }
    activeChecks++
    let valid
    try { valid = await verifyPassword(password, credential) } finally { activeChecks-- }
    if (valid) { failures.delete(ip); return true }
    const entry = failures.get(ip) ?? { count: 0, until: now() + 15 * 60_000 }
    entry.count++
    failures.set(ip, entry)
    reject(401, '访问密码不正确，请重试')
    return false
  }
  const server = http.createServer(async (req, res) => {
    try {
      prune()
      if (!sameOrigin(req)) return json(res, 403, '不允许跨站访问')
      const pathname = new URL(req.url, 'http://localhost').pathname
      if (pathname === LOGIN) {
        if (req.method === 'GET') {
          return loginPage(res)
        }
        if (req.method !== 'POST') return json(res, 405, '请求方法不支持')
        if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) return json(res, 415, '请使用密码登录表单')
        if (sessions.size >= 64) return json(res, 429, '登录会话过多，请稍后重试')
        const chunks = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > 4096) return json(res, 413, '请求内容过大')
          chunks.push(chunk)
        }
        const password = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('password')
        if (!await check(password, req, res, true)) return
        const upstream = await fetch(new URL('/api/management/session', target), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: managementKey }), signal: AbortSignal.timeout(5000),
        })
        const upstreamCookie = upstream.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
        await upstream.arrayBuffer()
        if (!upstream.ok || !upstreamCookie) return json(res, 502, '内部管理登录失败，请重启服务')
        const id = crypto.randomBytes(32).toString('base64url')
        const oldId = sessionId(req)
        if (sessions.has(oldId)) { revoke(sessions.get(oldId)); sessions.delete(oldId) }
        sessions.set(id, { until: now() + sessionMs, upstreamCookie })
        res.writeHead(303, { ...HEADERS, location: '/', 'set-cookie': cookie(id, req, Math.floor(sessionMs / 1000)) })
        return res.end()
      }
      const id = sessionId(req)
      const session = sessions.get(id)
      if (!session) {
        if (req.method === 'GET' && (pathname === '/' || String(req.headers.accept).includes('text/html'))) {
          res.writeHead(303, { ...HEADERS, location: LOGIN })
          return res.end()
        }
        return json(res, 401, '请先验证 WebUI 管理密码')
      }
      if (!pathname.startsWith('/api/management/') && !pathname.startsWith('/assets/') && pathname !== '/' && pathname !== '/ourfreemodel-access/client.js') {
        return json(res, 404, '此端口仅用于 WebUI，模型请求请使用 API 端口')
      }
      if (pathname === '/api/management/session' || pathname === '/api/management/login/terminal') return json(res, 403, '请使用 WebUI 密码登录页面')
      if (pathname === '/ourfreemodel-access/client.js' && req.method === 'GET') {
        res.writeHead(200, { ...HEADERS, 'content-type': 'text/javascript; charset=utf-8' })
        return res.end(CLIENT)
      }
      if (pathname === '/api/management/logout') {
        if (req.method !== 'POST') return json(res, 405, '请求方法不支持')
        revoke(session)
        sessions.delete(id)
        res.writeHead(200, { ...HEADERS, 'content-type': 'application/json', 'set-cookie': cookie('', req, 0) })
        return res.end('{"ok":true}')
      }
      let settingsBody
      if (pathname === '/api/management/settings' && req.method === 'POST') {
        const chunks = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > 16384) return json(res, 413, '设置内容过大')
          chunks.push(chunk)
        }
        settingsBody = Buffer.concat(chunks)
        let patch
        try { patch = JSON.parse(settingsBody.toString('utf8')) } catch { return json(res, 400, '设置不是有效 JSON') }
        if (patch?.standaloneLanEnabled === true || Object.hasOwn(patch ?? {}, 'standaloneLanPort')) {
          return json(res, 400, 'API 监听接口和端口请在 LuCI → 服务 → OurFreeModel 中配置')
        }
      }
      const headers = cleanHeaders(req.headers)
      headers.host = target.host
      delete headers.cookie
      delete headers.forwarded
      for (const key of Object.keys(headers)) if (key.startsWith('x-forwarded-')) delete headers[key]
      if (session) headers.cookie = session.upstreamCookie
      if (/^Basic /i.test(headers.authorization ?? '')) delete headers.authorization
      if (headers.origin) headers.origin = target.origin
      if (headers.referer) headers.referer = `${target.origin}/`
      const proxy = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers }, upstream => {
        const replyHeaders = cleanHeaders(upstream.headers)
        delete replyHeaders['set-cookie']
        delete replyHeaders['access-control-allow-origin']
        const page = pathname === '/' && String(replyHeaders['content-type']).startsWith('text/html')
        const summary = pathname === '/api/management/summary' && upstream.statusCode === 200
        const channelInfo = pathname === '/api/management/channels/rpc' && upstream.statusCode === 200
        const app = pathname === '/assets/app.js' && upstream.statusCode === 200
        if ((req.method === 'GET' && (page || summary || app)) || channelInfo) {
          const chunks = []
          upstream.on('data', chunk => chunks.push(chunk))
          upstream.on('error', () => res.destroy())
          upstream.on('end', () => {
            try {
              let body = Buffer.concat(chunks).toString('utf8')
              if (page) body = body.replace('<head>', '<head><script src="/ourfreemodel-access/client.js"></script>')
              else if (app) {
                body = body.replaceAll('仅监听回环地址', 'WebUI 密码保护').replaceAll('仅回环地址', '按 LuCI 接口配置')
              } else {
                const value = JSON.parse(body)
                if (summary) {
                  value.baseUrl = (typeof apiBaseUrl === 'function' ? apiBaseUrl(req) : apiBaseUrl) || origin(req)
                  value.webUiUrl = origin(req)
                  if (value.capabilities) value.capabilities.lan = false
                } else if (value.value?.address && apiBaseUrl) {
                  const api = new URL(typeof apiBaseUrl === 'function' ? apiBaseUrl(req) : apiBaseUrl)
                  value.value.address = { host: api.hostname, port: Number(api.port) }
                }
                body = JSON.stringify(value)
              }
              delete replyHeaders['content-length']
              res.writeHead(upstream.statusCode, replyHeaders)
              res.end(body)
            } catch { json(res, 502, '内部服务响应无效') }
          })
          return
        }
        res.writeHead(upstream.statusCode, replyHeaders)
        upstream.on('error', () => res.destroy())
        upstream.pipe(res)
      })
      proxy.setTimeout(10 * 60_000, () => proxy.destroy())
      proxy.on('error', () => { if (!res.headersSent) json(res, 502, '内部服务连接失败'); else res.destroy() })
      res.on('close', () => proxy.destroy())
      req.on('error', () => proxy.destroy())
      if (settingsBody) proxy.end(settingsBody)
      else req.pipe(proxy)
    } catch {
      if (!res.headersSent && !res.destroyed) json(res, 500, '访问验证失败，请重试或检查服务日志')
      else res.destroy()
    }
  })
  server.maxHeadersCount = 100
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  cookieName = `ourfreemodel_access_${server.address().port}`
  let closing
  return {
    port: server.address().port,
    close: () => closing ??= new Promise((resolve, reject) => {
      for (const entry of sessions.values()) revoke(entry)
      sessions.clear()
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

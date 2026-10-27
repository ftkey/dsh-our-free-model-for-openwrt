import http from 'node:http'
import crypto from 'node:crypto'
import { cleanHeaders } from './gateway.mjs'

const PATHS = new Set(['/health', '/v1/models', '/models', '/v1/chat/completions', '/chat/completions',
  '/v1/responses', '/responses', '/v1/messages', '/messages', '/v1/messages/count_tokens', '/messages/count_tokens', '/v1beta/models'])

export function isModelPath(pathname) {
  return PATHS.has(pathname) || /^\/(?:v1|v1beta)\/models\/[^/]+$/.test(pathname)
}

export async function startApiGateway({ targetUrl, getApiKey, host, port }) {
  const target = new URL(targetUrl)
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:') throw new Error('API 内部目标必须为本机地址')
  const server = http.createServer((req, res) => {
    const error = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }))
    }
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { return error(400, 'Invalid request URL') }
    const pathname = url.pathname.replace(/\/+$/, '')
    if (!isModelPath(pathname)) return error(404, 'This is the model API port; WebUI is on a separate port')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, X-API-Key, X-Goog-API-Key, Anthropic-Version' })
      return res.end()
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim()
    const gemini = pathname.startsWith('/v1beta/models') || pathname.startsWith('/v1/models/')
    const presented = bearer || req.headers['x-api-key'] || (gemini ? req.headers['x-goog-api-key'] || url.searchParams.get('key') : '')
    const expected = getApiKey()
    if (typeof presented !== 'string' || typeof expected !== 'string' || !expected || !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(presented).digest(), crypto.createHash('sha256').update(expected).digest())) {
      return error(401, 'Missing or invalid API key')
    }
    const headers = cleanHeaders(req.headers)
    headers.host = target.host
    headers.authorization = `Bearer ${expected}`
    delete headers.cookie
    delete headers.origin
    delete headers.referer
    delete headers['sec-fetch-site']
    const proxy = http.request({ hostname: target.hostname, port: target.port, path: pathname + url.search, method: req.method, headers }, upstream => {
      const reply = cleanHeaders(upstream.headers)
      delete reply['set-cookie']
      res.writeHead(upstream.statusCode, reply)
      upstream.on('error', () => res.destroy())
      upstream.pipe(res)
    })
    proxy.setTimeout(10 * 60_000, () => proxy.destroy())
    proxy.on('error', () => { if (!res.headersSent) error(502, 'Internal model service unavailable'); else res.destroy() })
    res.on('close', () => proxy.destroy())
    req.on('error', () => proxy.destroy())
    req.pipe(proxy)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  let closing
  return { port: server.address().port, close: () => closing ??= new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

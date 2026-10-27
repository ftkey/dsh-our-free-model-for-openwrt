import { createControl, METHODS } from './control.mjs'
import { StringDecoder } from 'node:string_decoder'

try {
  if (process.argv[2] === 'list') {
    process.stdout.write(JSON.stringify(METHODS) + '\n')
  } else if (process.argv[2] === 'call' && Object.hasOwn(METHODS, process.argv[3])) {
    let input = ''
    let body
    const decoder = new StringDecoder('utf8')
    // rpcd writes a complete JSON object, without promising a trailing newline
    // or EOF. Process it once it parses; never put passwords in argv or logs.
    for await (const chunk of process.stdin) {
      input += decoder.write(chunk)
      if (Buffer.byteLength(input) > 4096) throw new Error('请求内容过大')
      try { body = JSON.parse(input) } catch { continue }
      break
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('无效的请求参数')
    const method = process.argv[3]
    for (const key of Object.keys(METHODS[method])) if (typeof body[key] !== 'string') throw new Error('缺少有效请求参数')
    process.stdout.write(JSON.stringify(await createControl()[method](body)) + '\n')
  } else throw new Error('不支持的 RPC 方法')
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message, ok: false }) + '\n')
}

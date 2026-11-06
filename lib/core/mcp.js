// MCP（Model Context Protocol）服务端，零依赖实现：stdio 给本地客户端用，HTTP（POST /mcp）给远程客户端用。
import { PROTOCOL, callTool, toolsAs } from './tools.js'

export const VERSION = '0.1.0'
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05']

export async function handleMessage(brain, msg, ctx = {}) {
  const { method, id, params = {} } = msg || {}
  if (id === undefined || id === null) return null // 通知
  const reply = result => ({ jsonrpc: '2.0', id, result })
  try {
    switch (method) {
      case 'initialize':
        if (params.clientInfo?.name) ctx.client = params.clientInfo.name
        return reply({
          protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'forget-me-not', title: '勿忘我 · 记忆大脑', version: VERSION },
          instructions: PROTOCOL,
        })
      case 'ping': return reply({})
      case 'tools/list': return reply({ tools: toolsAs('mcp') })
      case 'tools/call': {
        try {
          const out = await callTool(brain, params.name, params.arguments || {}, ctx.agent || ctx.client)
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out?.ok === false })
        } catch (e) { return reply({ content: [{ type: 'text', text: `出错了：${e.message}` }], isError: true }) }
      }
      case 'resources/list': return reply({ resources: [] })
      case 'prompts/list': return reply({ prompts: [] })
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }
  }
}

export async function handlePayload(brain, payload, ctx = {}) {
  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map(m => handleMessage(brain, m, ctx)))).filter(Boolean)
    return out.length ? out : null
  }
  return handleMessage(brain, payload, ctx)
}

/**
 * stdio 模式。记忆的私钥只活在「被唤醒的那个进程」里，所以如果星环服务正在运行（FMN_URL，默认 http://127.0.0.1:7777），
 * 就把请求转发给它；否则在本进程里打开大脑（这时只能写入，回想需要先唤醒）。
 */
export async function serveStdio(brainFactory, url = process.env.FMN_URL || 'http://127.0.0.1:7777') {
  let remote = false
  try { remote = (await fetch(url + '/api/connect', { signal: AbortSignal.timeout(800) })).ok } catch { }
  const brain = remote ? null : brainFactory()
  const ctx = {}
  process.stderr.write(`forget-me-not MCP ready (${remote ? 'proxy → ' + url : 'local'})\n`)
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', async chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let payload, resp
      try { payload = JSON.parse(line) } catch { resp = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }
      if (payload) {
        if (remote) {
          const r = await fetch(url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': ctx.client || 'mcp' }, body: line }).catch(() => null)
          if (payload.method === 'initialize') ctx.client = payload.params?.clientInfo?.name
          resp = r && r.status === 200 ? await r.json() : null
        } else resp = await handlePayload(brain, payload, ctx)
      }
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n')
    }
  })
}

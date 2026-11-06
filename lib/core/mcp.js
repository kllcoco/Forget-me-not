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

/** stdio 模式：多个进程（MCP、星环服务、dsh）可以同时打开同一个数据目录。 */
export function serveStdio(brain) {
  const ctx = {}
  process.stderr.write(`forget-me-not MCP ready · ${brain.home}\n`)
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', async chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let resp
      try { resp = await handlePayload(brain, JSON.parse(line), ctx) } catch { resp = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n')
    }
  })
}

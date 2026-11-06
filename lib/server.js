// 独立运行：node 自带的 http 服务，打开 http://127.0.0.1:7777 就能看到记忆星环。
import http from 'node:http'
import { Brain } from './core/brain.js'
import { createHandler } from './core/http.js'
import { envChat, envEmbedder } from './core/llm.js'

export function serve({ host = '127.0.0.1', port = 7777, home } = {}) {
  const brain = new Brain(home)
  brain.chat = envChat(); brain.embedder = envEmbedder()
  brain.maintain()
  brain.backfillEmbeddings().catch(() => { })
  const timer = setInterval(() => { try { brain.maintain() } catch { } brain.backfillEmbeddings().catch(() => { }) }, 10 * 60 * 1000)
  timer.unref()
  const handle = createHandler({ brain, connect: { mcp_stdio: { command: 'npx', args: ['-y', 'dsh-forget-me-not', 'mcp'] } } })
  const server = http.createServer((req, res) => {
    // 只接受本机页面的跨源请求，防止别的网站偷偷调用
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) { res.writeHead(403); res.end('forbidden'); return }
    handle(req, res)
  })
  server.listen(port, host, () => {
    console.log(`🌸 勿忘我 · 记忆星环： http://${host}:${port}`)
    console.log(`   远程 MCP： http://${host}:${port}/mcp   ·   数据目录： ${brain.home}`)
    console.log(`   自动总结（POST /api/digest）：${brain.chat ? '可用' : '未配置模型'} · 语义向量：${brain.embedder ? '开' : '关'}`)
    if (!brain.initialized) console.log('   还没有记忆：模型第一次写入时，会在桌面生成唯一的超级管理员钥匙')
  })
  return { server, brain }
}

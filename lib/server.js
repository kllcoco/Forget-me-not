// 独立运行：node 自带的 http 服务，打开 http://127.0.0.1:7777 就能看到记忆星环。
import http from 'node:http'
import { Brain } from './core/brain.js'
import { createHandler } from './core/http.js'

export function serve({ host = '127.0.0.1', port = 7777, home } = {}) {
  const brain = new Brain(home)
  brain.maintain()
  const timer = setInterval(() => { try { brain.maintain() } catch { } }, 10 * 60 * 1000)
  timer.unref()
  const handle = createHandler({ brain, connect: { mcp_stdio: { command: 'npx', args: ['-y', 'forget-me-not', 'mcp'] } } })
  const server = http.createServer((req, res) => {
    // 只接受本机页面的跨源请求，防止别的网站偷偷调用
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) { res.writeHead(403); res.end('forbidden'); return }
    handle(req, res)
  })
  server.listen(port, host, () => {
    console.log(`🌸 勿忘我 · 记忆星环： http://${host}:${port}`)
    console.log(`   远程 MCP： http://${host}:${port}/mcp   ·   数据目录： ${brain.home}`)
    if (!brain.initialized) console.log('   第一次使用：打开网页，点「封存中」设定超级管理员密码')
  })
  return { server, brain }
}

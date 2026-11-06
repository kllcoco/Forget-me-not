// 独立运行：node 自带的 http 服务，打开 http://127.0.0.1:7777 就能看到记忆星环。
// 多角色：主角色在 /，其他角色在 /c/<角色 id>/。
import http from 'node:http'
import { defaultHome } from './core/brain.js'
import { createMultiHandler } from './core/http.js'
import { envChat, envEmbedder } from './core/llm.js'
import { proactiveConfig, startProactive } from './proactive.js'

/** 给每个大脑接上模型、开定时器：代谢（10 分钟）、补语义向量、每天睡一觉整理记忆。 */
export function setupBrain(brain) {
  brain.chat = envChat(); brain.embedder = envEmbedder()
  // 设置了 QQ 就顺便开启主动聊天（只对主角色，或 FMN_CHARACTER 指定的角色）
  const pc = proactiveConfig()
  if (pc.qq && pc.onebot && brain.chat && (brain.label || 'main') === (process.env.FMN_PROACTIVE_CHARACTER || brain.label || 'main') && !setupBrain.proactive) {
    setupBrain.proactive = startProactive(brain, brain.chat, pc)
    console.log(`   主动聊天：开（发到 QQ ${pc.qq}，${pc.hours[0]}–${pc.hours[1]} 点，每天最多 ${pc.maxPerDay} 次）`)
  }
  try { brain.maintain() } catch { }
  brain.backfillEmbeddings().catch(() => { })
  setInterval(() => { try { brain.maintain() } catch { } brain.backfillEmbeddings().catch(() => { }) }, 10 * 60 * 1000).unref()
  setInterval(() => { if (brain.unlocked) brain.consolidate().catch(() => { }) }, 24 * 3600 * 1000).unref()
}

const LOCAL_HOST = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/

export async function serve({ host = '127.0.0.1', port = 7777, home } = {}) {
  const root = home || defaultHome()
  const multi = await createMultiHandler({ root, setup: setupBrain, connect: { mcp_stdio: { command: 'npx', args: ['-y', 'dsh-forget-me-not', 'mcp'] } } })
  const brain = multi.brainOf('main')
  const server = http.createServer(async (req, res) => {
    // 只接受本机页面的跨源请求，防止别的网站偷偷调用
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) { res.writeHead(403); res.end('forbidden'); return }
    // 只在本机上监听时：Host 也必须是本机，防止别的网站用 DNS 重绑定读走记忆
    if (LOCAL_HOST.test(host) && !LOCAL_HOST.test(String(req.headers.host || '').replace(/:\d+$/, ''))) { res.writeHead(403); res.end('forbidden'); return }
    try { if (!(await multi.handle(req, res))) { res.writeHead(404); res.end() } } catch (e) { console.error('[forget-me-not]', e); if (!res.headersSent) { res.writeHead(500); res.end() } }
  })
  server.listen(port, host, () => {
    console.log(`🌸 勿忘我 · 记忆星环： http://${host}:${port}`)
    console.log(`   远程 MCP： http://${host}:${port}/mcp（其他角色：/c/<角色 id>/mcp）   ·   数据目录： ${root}`)
    console.log(`   自动总结（POST /api/digest）：${brain.chat ? '可用' : '未配置模型'} · 语义向量：${brain.embedder ? '开' : '关'}`)
    if (!brain.initialized) console.log('   还没有记忆：模型第一次写入时，会在桌面生成唯一的超级管理员钥匙')
  })
  return { server, brain, multi }
}

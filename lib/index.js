// DeepSeek Harness (dsh) 插件的 Host 端：
//   1. 给 AI 注册四个工具（醒来 / 封存写入 / 联想回想 / 性格养成）；
//   2. 把记忆使用说明放进系统提示词，并实时告诉 AI 钥匙在不在、TA 现在是什么性格；
//   3. 每段对话结束后，借用 dsh 正在用的模型自动总结成记忆（也会顺便反思性格）；
//      用户每说一句话，自动找出可能相关的记忆放进上下文；
//   4. 在 dsh 网页服务上挂载 /forget-me-not —— 记忆星环页面和它的接口（只有 dsh 的主人能打开，读内容还要超级管理员钥匙在登记的位置）。
// 浏览器端（左侧栏的「记忆」入口）在 ./client.js。
import path from 'node:path'
import { Brain, defaultHome } from './core/brain.js'
import { createHandler } from './core/http.js'
import { PROTOCOL, TOOLS, callTool } from './core/tools.js'
import { digest } from './core/digest.js'
import { dshChat, envChat, envEmbedder } from './core/llm.js'

export const name = 'forget-me-not'
// 只有工具是必需的；提示词、模型、网页服务都是「有就用」——这样在 dsh 的 web / tui / headless 里都能工作。
export const inject = ['tools']

/** 插件配置（写在 cordis.patch.yml 的 config 里）：
 *   dataDir     数据目录
 *   autoDigest  是否自动总结对话（默认 true）
 *   digestEvery 每几轮对话总结一次（默认 1；太短的闲聊会跳过，对话很长时会提前总结）
 *   autoRecall  用户说话时自动想起相关记忆放进上下文（默认 true）
 */
export const MOUNT = '/forget-me-not'

let defineTool = null
try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')) } catch { /* 不在 dsh 里运行时没有这个包 */ }

// dsh 的参数格式：属性表，必填项写 required: true；对象要写 additionalProperties；不支持 minimum/maximum。
function toDshValue(v) {
  const { minimum, maximum, required, ...rest } = v
  if (rest.items) rest.items = toDshValue(rest.items)
  if (rest.type === 'object') { rest.properties = toDshParameters(v); rest.additionalProperties = false }
  return rest
}
function toDshParameters(schema) {
  const out = {}
  for (const [k, v] of Object.entries(schema.properties || {})) {
    out[k] = toDshValue(v)
    if (schema.required?.includes(k)) out[k].required = true
  }
  return out
}

function dataDirFrom(config) {
  if (config?.dataDir) return config.dataDir
  if (process.env.FMN_HOME) return process.env.FMN_HOME
  if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, 'forget-me-not')
  return defaultHome()
}

export function apply(ctx, config = {}) {
  const brain = new Brain(dataDirFrom(config))
  let lastTarget = null   // 最近一次对话用的模型
  const fallbackChat = envChat()
  brain.chat = fallbackChat
  ctx.inject(['llm'], scope => {
    const viaDsh = dshChat(scope.llm, () => lastTarget)
    brain.chat = async (...a) => lastTarget || !fallbackChat ? viaDsh(...a) : fallbackChat(...a)
    scope.effect?.(() => () => { brain.chat = fallbackChat })
  })
  brain.embedder = envEmbedder()
  brain.maintain()
  const timer = setInterval(() => { try { brain.maintain() } catch { } brain.backfillEmbeddings().catch(() => { }) }, 10 * 60 * 1000)
  timer.unref?.()
  ctx.effect?.(() => () => clearInterval(timer))

  // ---- 1. 工具
  if (!defineTool) throw new Error('forget-me-not: 找不到 @deepseek-ai/dsh-tools，请在 dsh 里通过 `dsh plugin add` 安装')
  for (const t of TOOLS) {
    ctx.tools.register(defineTool({
      name: t.name,
      description: t.description,
      parameters: toDshParameters(t.parameters),
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent?.name || exec?.agent?.id || 'dsh'
        return JSON.parse(JSON.stringify(await callTool(brain, t.name, args, String(agent))))
      },
    }))
  }

  // ---- 2. 系统提示词
  ctx.inject(['systemPrompt'], scope => {
  scope.systemPrompt.section({ name: 'forget-me-not:protocol', order: 900, text: PROTOCOL })
  scope.systemPrompt.context({
    name: 'forget-me-not:state',
    order: 900,
    text: (c) => {
      const k = brain.keyStatus()
      if (!k.initialized) return '【记忆大脑】还没有任何记忆。第一次写入时会在用户桌面生成唯一的超级管理员钥匙，届时请立刻告诉用户。'
      if (!k.unlocked) return `【记忆大脑】锁着：在 ${k.key_path} 找不到超级管理员钥匙。你可以写入，但不能回想；请提醒用户把钥匙放回去，或在「记忆」右下角的小钥匙里填新路径。`
      let text = '【记忆大脑】已解锁：可以写入，也可以回想。\n' + (brain.personaText() || '')
      const hints = recallHints.get(String(c?.agent?.session?.id))
      if (hints?.length) text += '\n【可能相关的记忆】（自动想起，不一定准确；需要更多就用 memory_recall）\n' + hints.map(m => `- ${m.content}`).join('\n')
      return text
    },
  })
  })

  // ---- 3. 自动想起 + 自动总结
  const recallHints = new Map()   // 会话 id → 这句话可能相关的记忆
  const textOf = msg => (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
  if (config.autoRecall !== false) {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user' || !brain.unlocked) return
      const q = textOf(event.data).slice(0, 500)
      try { recallHints.set(String(session.id), q ? brain.search(q, { limit: 4 }).filter(m => m.score > 0.42 && m.status === 'active') : []) } catch { }
    })
  }
  const progress = new Map()     // 会话 id → { done: 已总结到第几条消息, turns }
  let digesting = Promise.resolve()
  if (config.autoDigest !== false) {
    ctx.on('agent/turn-stopping', ({ agent }) => {
      try {
        const cfg = agent.session.requestHeader?.()?.config
        if (cfg?.provider && cfg?.model) lastTarget = { provider: cfg.provider, model: cfg.model }
        const msgs = agent.session.deriveMessages()
        const key = String(agent.session.id), p = progress.get(key) || { done: 0, turns: 0 }
        p.turns++; progress.set(key, p)
        const fresh = msgs.slice(p.done).filter(m => (m.role === 'user' && m.source?.kind === 'user') || m.role === 'assistant')
          .map(m => ({ role: m.role, text: textOf(m) })).filter(t => t.text.trim())
        const size = fresh.reduce((n, t) => n + t.text.length, 0)
        if (!fresh.length || size < 40 || (p.turns < (config.digestEvery || 1) && size < 3000)) return
        p.done = msgs.length; p.turns = 0
        // 不阻塞对话：排队在后台总结
        digesting = digesting.then(() => digest(brain, brain.chat, fresh, { agent: 'auto-digest' }))
          .then(r => { if (r?.memories?.length) console.log(`[forget-me-not] 自动总结：写入 ${r.memories.length} 段记忆`) })
          .catch(e => console.warn('[forget-me-not] 自动总结失败：', e.message))
      } catch (e) { console.warn('[forget-me-not]', e.message) }
    })
  }

  // ---- 4. 记忆星环页面
  const handle = createHandler({ brain, base: MOUNT, exposeTools: false, connect: { dsh: 'dsh plugin --profile web add dsh-forget-me-not' } })
  ctx.inject(['webServer', 'connection'], scope => scope.webServer.register({
    kind: 'prefix',
    path: MOUNT,
    handler: async (req, res) => {
      const rejection = scope.connection.requestRejection(req)
      if (rejection) { res.writeHead(rejection, { 'content-type': 'text/plain' }); res.end(rejection === 401 ? 'unauthorized' : 'forbidden'); return }
      if (!(await handle(req, res))) { res.writeHead(404); res.end() }
    },
  }))
  console.log(`[forget-me-not] 已加载 ${TOOLS.length} 个工具（${TOOLS.map(t => t.name).join(', ')}）；自动总结：${config.autoDigest !== false ? '开' : '关'}；语义向量：${brain.embedder ? '开' : '关'}；记忆星环：${MOUNT}/ ；数据：${brain.home}`)
}

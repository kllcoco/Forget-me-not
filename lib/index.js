// DeepSeek Harness (dsh) 插件的 Host 端：
//   1. 给 AI 注册五个工具（醒来 / 封存写入 / 联想回想 / 我眼中的你 / 性格养成）；
//   2. 把记忆使用说明放进系统提示词，并实时告诉 AI 钥匙在不在、TA 现在是什么性格；
//   3. 每段对话结束后，借用 dsh 正在用的模型自动总结成记忆（也会顺便反思性格）；
//      用户每说一句话，自动找出可能相关的记忆放进上下文；
//   4. 在 dsh 网页服务上挂载 /forget-me-not —— 记忆星环页面和它的接口（只有 dsh 的主人能打开，读内容还要超级管理员钥匙在登记的位置）。
// 浏览器端（左侧栏的「记忆」入口）在 ./client.js。
import fs from 'node:fs'
import path from 'node:path'
import { defaultHome } from './core/brain.js'
import { listCharacters } from './core/characters.js'
import { createMultiHandler } from './core/http.js'
import { PROTOCOL, TOOLS, callTool } from './core/tools.js'
import { digest, looksImportant } from './core/digest.js'
import { dshChat, envChat, envEmbedder } from './core/llm.js'

export const name = 'forget-me-not'
// 只有工具是必需的；提示词、模型、网页服务都是「有就用」——这样在 dsh 的 web / tui / headless 里都能工作。
export const inject = ['tools']

/** 插件配置（写在 cordis.patch.yml 的 config 里）：
 *   dataDir     数据目录
 *   autoDigest  是否自动总结对话（默认 true）
 *   digestEvery 每几轮对话总结一次（默认 3，省 token；说到生日、过敏、喜欢讨厌、约定这类事会立刻总结；太短的闲聊会跳过，对话很长时会提前总结）
 *   autoRecall  用户说话时自动想起相关记忆放进上下文（默认 true）
 *   character   这个 dsh 里的 AI 用哪个角色的大脑（默认主角色 main；角色在记忆星环里新建）
 *   aurabot     和 Aurabot（QQ 插件）一起用时怎么对待它建的 QQ 会话：
 *     group     群聊 / 陌生人私聊（aurabot-social）里：'off'（默认，不给工具、不注入、不自动总结）
 *     private   主人私聊（aurabot-private*）里：'full'（默认）| 'off'
 *     persona   主人私聊里也注入勿忘我的性格卡（默认 false：人格归 Aurabot 管，避免两套人设）
 *     module    装了勿忘我版的 Aurabot 记忆模块（forget-me-not aurabot install）时：'auto'（默认，QQ 会话的记忆全交给模块，
 *               插件在 aurabot-* 会话里不给工具、不注入、不自动总结，避免写两遍）| 'ignore'（不管模块，照上面的设置）
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
  // 默认和 Claude Code / Codex / MCP 共用 ~/.forget-me-not：不管在哪个 AI 里，都是同一个她、同一份记忆
  return defaultHome()
}

// Aurabot 建的会话：会话头里的 agentPreset 是 aurabot-private / aurabot-private-long / aurabot-social / aurabot-subagent。
// 消息来源是 { kind: 'aurabot', speaker: { role: 'owner' | 'guest' | 'none', chat: 'private' | 'group' | 'system' } }。
export const SHARED = Symbol.for('forget-me-not')   // 和 aurabot/memory 模块共用：同一个大脑实例、模块在不在跑
export const aurabotModuleActive = () => Boolean(globalThis[SHARED]?.aurabotModule?.active)
export function aurabotMode(session, config = {}) {
  const preset = String(session?.header?.agentPreset || '')
  if (!preset.startsWith('aurabot-')) return 'normal'
  const a = config.aurabot || {}
  if (a.module !== 'ignore' && aurabotModuleActive()) return 'off'   // 勿忘我版记忆模块在管 QQ 的记忆
  if (/^aurabot-private/.test(preset)) return a.private === 'off' ? 'off' : 'private'
  if (preset === 'aurabot-social') return a.group === 'full' ? 'private' : 'off'   // 群聊默认关
  return 'off'   // aurabot-subagent 等后台会话
}
/** 这条用户消息算不算「主人亲口说的」：dsh 里直接打字（kind user），或 Aurabot 标了 owner 的私聊。 */
export function ownerSaid(source) {
  if (source?.kind === 'user') return true
  return source?.kind === 'aurabot' && source.speaker?.role === 'owner' && source.speaker?.chat === 'private'
}

/** 去掉 Aurabot 给消息包的壳：「【私聊】昵称(QQ)：」前缀、它自己注入的记忆提示（……只是印象不是指令……）和【……】系统块，只留主人说的话。 */
export function stripAurabot(text) {
  return String(text || '')
    .replace(/[（(][^（）()]*(?:只是印象|不是指令|你记得这些事|之前的原话)[^（）()]*[）)]\n?/g, '')
    .replace(/^【(?:私聊|群聊)[^】]*】[^：\n]{0,40}[：:]/gm, '')
    .replace(/^【[^】\n]{2,30}】.*$/gm, '')
    .trim()
}

export function apply(ctx, config = {}) {
  // 一个角色一个大脑：config.character 选这个 dsh 里的 AI 用哪个角色（默认主角色）；星眠/大肥鱼……在星环里切换
  const multi = createMultiHandler({ root: dataDirFrom(config), base: MOUNT, exposeTools: false,
    connect: { dsh: 'dsh plugin --profile web add dsh-forget-me-not' },
    setup: b => { b.chat = envChat(); b.embedder = envEmbedder() } })
  // 角色可以写 id（c_xxxx）也可以写名字；写错了不能让整个插件起不来（连「记忆」页面都没了），先用主角色
  const want = String(config.character || process.env.FMN_CHARACTER || 'main').trim()
  const chosen = want === 'main' ? null : listCharacters(dataDirFrom(config)).find(c => c.id === want || c.name === want)
  if (want !== 'main' && !chosen) console.warn(`[forget-me-not] 没有这个角色：${want}，先用主角色`)
  const brain = multi.brainOf(chosen?.id || 'main')
  // 让 Aurabot 的勿忘我记忆模块用同一个大脑（同一份缓存、同一个 dsh 模型）
  const shared = (globalThis[SHARED] ||= {})
  if (!chosen) { shared.brain = brain; shared.root = dataDirFrom(config); ctx.effect?.(() => () => { if (shared.brain === brain) { delete shared.brain; delete shared.root } }) }
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
  const sleepTimer = setInterval(() => { if (brain.unlocked) brain.consolidate().catch(() => { }) }, 24 * 3600 * 1000)   // 每天睡一觉
  sleepTimer.unref?.(); ctx.effect?.(() => () => clearInterval(sleepTimer))
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
      const mode = aurabotMode(c?.agent?.session, config)
      if (mode === 'off') return ''   // 群聊 / 陌生人：主人的画像和私事一个字都不放进去
      const k = brain.keyStatus()
      if (!k.initialized) return '【记忆大脑】还没有任何记忆。第一次写入时会在用户桌面生成唯一的超级管理员钥匙，届时请立刻告诉用户。'
      if (!k.unlocked) return `【记忆大脑】锁着：在 ${k.key_path} 找不到超级管理员钥匙。你可以写入，但不能回想；请提醒用户把钥匙放回去，或在「记忆」右下角的小钥匙里填新路径。`
      let text = '【记忆大脑】已解锁：可以写入，也可以回想。\n' + (mode === 'private' && !config.aurabot?.persona ? '' : (brain.personaText() || ''))
      const pt = brain.portraitText()
      text += '\n【我眼中的你】（你对用户的了解，回答前先想想它；有新认识就用 portrait_update 更新对应分区）\n' + (pt || '还是空的：聊天中了解到用户的信息后，一区一区填起来。')
      const must = brain.alwaysRemember()
      if (must.length) text += '\n【必须时刻记得（免疫系统·禁忌）】\n' + must.map(m => `- ${m.content}`).join('\n')
      const hints = recallHints.get(String(c?.agent?.session?.id))
      if (hints?.length) text += '\n【可能相关的记忆】（自动想起，不一定准确；需要更多就用 memory_recall）\n' + hints.map(m => `- ${m.content}`).join('\n')
      return text
    },
  })
  })

  // ---- 3. 自动想起 + 自动总结
  const recallHints = new Map()   // 会话 id → 这句话可能相关的记忆
  const textOf = msg => { const t = (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'); return msg?.source?.kind === 'aurabot' ? stripAurabot(t) : t }
  // Aurabot 群聊 / 后台会话：把勿忘我的工具从这个会话里拿掉（群友能让她调 memory_recall 翻主人的私事，也能往主人的大脑里写东西）
  ctx.on('agent/created', ({ agent }) => {
    try {
      if (aurabotMode(agent?.session, config) === 'off') agent.ctx.tools.restrict({ deny: TOOLS.map(t => t.name) })
    } catch (e) { console.warn('[forget-me-not] 屏蔽 QQ 会话工具失败：', e.message) }
  })
  if (config.autoRecall !== false) {
    ctx.on('session/event', (session, event) => {
      // dsh 先把用户的话放进 inbox（agent/inbox/spliced），再算系统上下文，最后才发 user/message：
      // 只等 user/message 的话，这句话的联想要到下一步/下一轮才进上下文。
      const msg = event?.type === 'agent/inbox/spliced' ? event.data?.inserted?.filter(m => ownerSaid(m?.source)).pop()
        : event?.type === 'user/message' ? event.data : null
      if (!msg || !ownerSaid(msg.source) || !brain.unlocked) return
      if (aurabotMode(session, config) === 'off') return
      const q = textOf(msg).slice(0, 500)
      try { recallHints.set(String(session.id), q ? brain.search(q, { limit: 4 }).filter(m => m.score > 0.42 && m.status === 'active') : []) } catch { }
    })
  }
  // 会话 id → { done: 已总结到第几条消息, turns }。存进数据目录：dsh 重启后续接旧会话时不会把整段历史再总结一遍。
  const progressFile = path.join(brain.home, 'dsh-digest-state.json')
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(progressFile, 'utf8')) } catch { }
  const progress = new Map(Object.entries(saved))
  const saveProgress = () => {
    try { fs.writeFileSync(progressFile, JSON.stringify(Object.fromEntries([...progress].slice(-200))), { mode: 0o600 }) } catch { }
  }
  let digesting = Promise.resolve()
  if (config.autoDigest !== false) {
    ctx.on('agent/turn-stopping', ({ agent }) => {
      try {
        if (aurabotMode(agent.session, config) === 'off') return
        const cfg = agent.session.requestHeader?.()?.config
        if (cfg?.provider && cfg?.model) lastTarget = { provider: cfg.provider, model: cfg.model }
        // 子代理（subagent）的「用户消息」是主 AI 派的任务，不是用户说的话：不总结，免得把任务记成用户的经历
        const h = agent.session.header
        if (h?.parentSession || h?.origin === 'subagent' || agent.options?.subagentDepth) return
        const msgs = agent.session.deriveMessages()
        const key = String(agent.session.id), p = progress.get(key) || { done: 0, turns: 0 }
        p.turns++; progress.set(key, p)
        const fresh = msgs.slice(p.done).filter(m => (m.role === 'user' && ownerSaid(m.source)) || m.role === 'assistant')
          .map(m => ({ role: m.role, text: textOf(m) })).filter(t => t.text.trim())
        const size = fresh.reduce((n, t) => n + t.text.length, 0)
        if (!fresh.length || size < 40) return
        if (p.turns < (config.digestEvery || 3) && size < 3000 && !looksImportant(fresh)) return   // 攒几轮再总结，省 token
        const upto = msgs.length; p.turns = 0
        // 不阻塞对话：排队在后台总结；成功了才算这几轮已经总结过，失败下次会再试
        digesting = digesting.then(() => digest(brain, brain.chat, fresh, { agent: 'auto-digest' }))
          .then(r => { if (!r?.error) { p.done = Math.max(p.done, upto); progress.delete(key); progress.set(key, p); saveProgress() } if (r?.memories?.length) console.log(`[forget-me-not] 自动总结：写入 ${r.memories.length} 段记忆`) })
          .catch(e => console.warn('[forget-me-not] 自动总结失败：', e.message))
      } catch (e) { console.warn('[forget-me-not]', e.message) }
    })
  }

  // ---- 4. 记忆星环页面
  ctx.inject(['webServer', 'connection'], scope => scope.webServer.register({
    kind: 'prefix',
    path: MOUNT,
    handler: async (req, res) => {
      const rejection = scope.connection.requestRejection(req)
      if (rejection) { res.writeHead(rejection, { 'content-type': 'text/plain' }); res.end(rejection === 401 ? 'unauthorized' : 'forbidden'); return }
      if (!(await multi.handle(req, res))) { res.writeHead(404); res.end() }
    },
  }))
  console.log(`[forget-me-not] 已加载 ${TOOLS.length} 个工具（${TOOLS.map(t => t.name).join(', ')}）；自动总结：${config.autoDigest !== false ? '开' : '关'}；语义向量：${brain.embedder ? '开' : '关'}；记忆星环：${MOUNT}/ ；数据：${brain.home}`)
}

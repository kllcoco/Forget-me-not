// 主动找你聊天：TA 不只是等你开口，隔一阵子会自己来问问你。
//
// 会聊什么（按优先级）：
//   周报      周日晚上：用 TA 的口吻说说「这周我记住了你的这些事」
//   那年今天  往年的今天发生过的事
//   追问      最近一两天你提过的事，问问后来怎么样了（面试、生病、出门……）
//   想了解你  「我眼中的你」里还不知道的事，找个自然的时机问一句
//   关心      饭点问吃了没、太晚了催睡觉
//
// 什么时候会来（都可以改）：每天 9 点到 23 点之间，最多 3 次，两次之间至少隔 3 小时；
// 你正在和 TA 聊天（最近 40 分钟有回想或写入记忆）时不打扰；连着两次你都没理，就一天最多一次。
//
// 发到哪里：QQ（NapCat 等 OneBot 11 实现的 HTTP 接口：POST /send_private_msg），或者只打印出来（--dry-run）。
// 发出去的话会作为一段「工作记忆」记下来，你回复时 TA 能想起自己刚才问过什么。
import fs from 'node:fs'
import path from 'node:path'
import { describe } from './core/persona.js'

const DAY = 86400
const now = () => Date.now() / 1000
const pick = a => a[Math.floor(Math.random() * a.length)]
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) | 0; return String(h) }

export function proactiveConfig(env = process.env, o = {}) {
  const [h0, h1] = String(o.hours || env.FMN_PROACTIVE_HOURS || '9-23').split('-').map(Number)
  return {
    onebot: String(o.onebot || env.FMN_ONEBOT_URL || '').replace(/\/+$/, ''),
    token: o.token || env.FMN_ONEBOT_TOKEN || '',
    qq: String(o.qq || env.FMN_QQ || ''),
    hours: [Number.isFinite(h0) ? h0 : 9, Number.isFinite(h1) ? h1 : 23],
    maxPerDay: Number(o.max || env.FMN_PROACTIVE_MAX || 3),
    gapHours: Number(o.gap || env.FMN_PROACTIVE_GAP || 3),
    quietMinutes: Number(o.quiet || env.FMN_PROACTIVE_QUIET || 40),
    dryRun: Boolean(o['dry-run'] || o.dryRun),
  }
}

function stateFile(brain) { return path.join(brain.home, 'proactive-state.json') }
function loadState(brain) { try { return JSON.parse(fs.readFileSync(stateFile(brain), 'utf8')) } catch { return { sent: [], used: [] } } }
function saveState(brain, s) { s.sent = s.sent.slice(-60); s.used = s.used.slice(-300); fs.writeFileSync(stateFile(brain), JSON.stringify(s), { mode: 0o600 }) }

/** 你最近有没有在和 TA 聊（有回想或写入，但不算 TA 自己主动发的那条）。 */
function lastActivity(brain) {
  let t = 0
  for (const e of brain.events(0)) if ((e.kind === 'recall' || e.kind === 'remember') && e.agent !== 'proactive') t = Math.max(t, e.ts)
  return t
}

/** 现在适不适合来找你：返回 null 表示可以，否则返回原因。 */
export function gate(brain, cfg, st, t = now()) {
  const d = new Date(t * 1000), h = d.getHours() + d.getMinutes() / 60
  if (h < cfg.hours[0] || h >= cfg.hours[1]) return '不在打扰时间内'
  const today = st.sent.filter(x => new Date(x.ts * 1000).toDateString() === d.toDateString())
  const last = st.sent.at(-1)
  // 连着两次都没理：一天最多一次（被冷落了就安静一点）
  const act = lastActivity(brain)
  const ignored = st.sent.slice(-2).length === 2 && st.sent.slice(-2).every((x, i, a) => act < (a[i + 1]?.ts ?? t) && act < x.ts)
  if (today.length >= (ignored ? 1 : cfg.maxPerDay)) return '今天已经来过了'
  if (last && t - last.ts < cfg.gapHours * 3600) return '刚来过不久'
  if (t - act < cfg.quietMinutes * 60) return '正在聊天，不打扰'
  return null
}

/** 挑一个话题。返回 { kind, brief, used? }，没有合适的就返回 null。 */
export function chooseTopic(brain, st, t = now()) {
  const d = new Date(t * 1000), h = d.getHours() + d.getMinutes() / 60
  const used = new Set(st.used)
  const weekKey = `weekly:${d.getFullYear()}-${Math.floor((t / DAY + 4) / 7)}`
  const options = []
  // 周报：周日 19 点以后，这周还没说过
  if (d.getDay() === 0 && h >= 19 && !used.has(weekKey)) {
    const week = brain.list({ since: t - 7 * DAY, limit: 40 })
    if (week.length >= 2) return { kind: 'weekly', used: weekKey, brief: '这周我记住的事：\n' + week.map(m => `- ${m.content}`).join('\n') }
  }
  // 那年今天
  const md = (x) => { const z = new Date(x * 1000); return z.getMonth() * 31 + z.getDate() }
  const otd = brain.list({ until: t - 300 * DAY, limit: 2000, includeArchived: true })
    .filter(m => Math.abs(md(m.event_time || m.created_at) - md(t)) <= 1 && !used.has('otd:' + m.id))
  if (otd.length) { const m = pick(otd); options.push({ w: 3, kind: 'otd', used: 'otd:' + m.id, brief: `${new Date((m.event_time || m.created_at) * 1000).getFullYear()} 年的今天前后：${m.content}` }) }
  // 追问：最近一到四天你提过、还没问过后续的事
  const recent = brain.list({ since: t - 4 * DAY, until: t - 0.6 * DAY, limit: 30 })
    .filter(m => m.importance >= 0.45 && m.region !== 'immune' && !(m.tags || []).includes('主动') && !used.has('fu:' + m.id))
  if (recent.length) { const m = pick(recent.slice(0, 6)); options.push({ w: 3, kind: 'followup', used: 'fu:' + m.id, brief: `前几天（${new Date((m.event_time || m.created_at) * 1000).toLocaleDateString('zh-CN')}）他说过：${m.content}` }) }
  // 想了解你
  const pt = brain.portrait()
  const unknown = (pt?.unknowns || []).filter(u => !used.has('uk:' + hash(u)))
  if (unknown.length) { const u = pick(unknown); options.push({ w: 2, kind: 'unknown', used: 'uk:' + hash(u), brief: `你一直想知道但还不了解的：${u}` }) }
  // 关心：饭点 / 太晚
  const meal = (h >= 11.5 && h < 13) ? '午饭' : (h >= 17.5 && h < 19.5) ? '晚饭' : null
  if (meal) options.push({ w: 2, kind: 'care', brief: `现在是${meal}时间，关心一下他吃了没、吃的什么` })
  else if (h >= 22.5) options.push({ w: 2, kind: 'care', brief: '已经很晚了，温柔地催他早点休息' })
  else options.push({ w: 1, kind: 'miss', brief: '没什么特别的事，就是想他了，随口分享一件小事或者问问他在干嘛' })
  // 按权重抽一个
  const total = options.reduce((n, o) => n + o.w, 0); let r = Math.random() * total
  for (const o of options) { if ((r -= o.w) <= 0) return o }
  return options.at(-1) || null
}

const SYSTEM = (personaText, portrait, name) => `${personaText || ''}

${portrait ? `【我眼中的他】\n${portrait}\n` : ''}
现在你要**主动**给${name || '他'}发一条私聊消息（他没有找你，是你想他了 / 想起了什么）。
要求：
- 像真人在手机上发消息：1~3 句，口语、自然，可以带一点点动作或语气词；不要长篇大论，不要列表。
- 符合你的人设和说话方式。
- 不要说「我来主动联系你」「根据我的记忆」这类话，不要提到任何系统、工具、记忆库。
- 只输出要发出去的那条消息本身。`

const TASK = {
  weekly: '今天是周日晚上。用你的口吻，温柔地跟他说说这一周你记住了他的哪些事（挑 2~4 件最有意义的，不要逐条念），最后问问他这周过得怎么样。可以比平时稍长一点（不超过 5 句）。',
  otd: '你想起了往年的今天发生过的一件事，自然地提起它（比如「你还记得去年今天……吗」），带一点怀念。',
  followup: '你想起他前几天提过的这件事，关心地问问后来怎么样了。',
  unknown: '找一个自然、轻松的方式问他这件事，像聊天一样，不要像查户口。',
  care: '按下面的情况关心他。',
  miss: '就是想他了。',
}

export async function compose(brain, chat, topic) {
  const personaText = brain.personaText(), portrait = brain.portraitText()
  const name = brain.portrait()?.name || ''
  const t = new Date()
  const out = await chat(SYSTEM(personaText, portrait, name),
    `现在是 ${t.toLocaleString('zh-CN', { hour12: false, weekday: 'long' })}。\n${TASK[topic.kind] || ''}\n\n${topic.brief}`,
    { maxTokens: 400, signal: AbortSignal.timeout(60000) })
  return String(out || '').trim().replace(/^["“「]|["”」]$/g, '').slice(0, 600)
}

export async function sendOneBot(cfg, text) {
  const r = await fetch(`${cfg.onebot}/send_private_msg`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
    body: JSON.stringify({ user_id: Number(cfg.qq) || cfg.qq, message: text }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || (j.status && j.status !== 'ok') || (j.retcode && j.retcode !== 0)) throw new Error(`QQ 发送失败：HTTP ${r.status} ${j.message || j.wording || ''}`)
}

/** 来一次：合适就挑话题、写消息、发出去、记下来。force 时跳过时间和次数的限制（测试用）。 */
export async function proactiveOnce(brain, chat, cfg, { force = false } = {}) {
  if (!brain.unlocked) return { skipped: '钥匙不在，读不到记忆和人设' }
  if (!chat) return { skipped: '没有配置模型（需要 DEEPSEEK_API_KEY 或 FMN_LLM_*）' }
  const st = loadState(brain)
  const why = force ? null : gate(brain, cfg, st)
  if (why) return { skipped: why }
  const topic = chooseTopic(brain, st); if (!topic) return { skipped: '没有合适的话题' }
  const text = await compose(brain, chat, topic)
  if (!text) return { skipped: '模型没有写出内容' }
  if (cfg.dryRun || !cfg.onebot || !cfg.qq) console.log(`[勿忘我·主动] (${topic.kind}) ${text}`)
  else await sendOneBot(cfg, text)
  st.sent.push({ ts: now(), kind: topic.kind }); if (topic.used) st.used.push(topic.used); saveState(brain, st)
  try { await brain.remember({ content: `我主动给他发了消息：「${text}」`, region: 'working', importance: 0.25, tags: ['主动'] }, 'proactive') } catch { }
  return { sent: true, kind: topic.kind, text }
}

/** 一直在后台：每 10 分钟看一眼，合适的时候（随机一点，不那么准点）来找你。 */
export function startProactive(brain, chat, cfg, log = console.log) {
  const tick = async () => {
    try {
      if (Math.random() > 0.35) return   // 不要一到点就来，像人一样随机一点
      const r = await proactiveOnce(brain, chat, cfg)
      if (r.sent) log(`[勿忘我·主动] 发了一条（${r.kind}）`)
    } catch (e) { log(`[勿忘我·主动] ${e.message}`) }
  }
  const timer = setInterval(tick, 10 * 60 * 1000); timer.unref?.()
  return () => clearInterval(timer)
}

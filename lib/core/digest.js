// 自动总结对话：一段对话结束后，让模型像写日记一样，把值得记住的事总结成记忆，写进对应的脑区，
// 顺便反思这段经历让自己的性格有没有一点点变化。
import { MEMORY_TYPES, REGIONS } from './regions.js'
import { TRAITS } from './persona.js'
import { SECTIONS } from './portrait.js'
import { parseJson } from './llm.js'

const REGION_LINES = REGIONS.filter(r => r.kind === 'memory').map(r => `${r.key}：${r.desc}`).join('\n')

export const DIGEST_SYSTEM = `你是一个陪伴型 AI 的「海马体」。你会读到 AI 和用户最近的一段对话，任务是把其中值得长期记住的东西，
用 AI 第一人称视角、像写日记一样总结成记忆。只输出 JSON，不要任何别的文字。

规则：
- 只记真正有价值的：用户的经历、感受、人际关系、喜好习惯、约定、计划、AI 自己学到的教训。寒暄、闲聊废话、纯技术问答细节不记。
- 每条记忆 1~3 句话，具体：谁 / 什么时候 / 发生了什么 / 感受如何。不要照抄原话。
- 已经记得的事（下面「已有的相关记忆」里有的）不要重复记，除非有新的信息。
- 关乎安全的事（过敏、疾病、用药、忌口、害怕的东西、不能提的雷区）一定要记，放进 immune，type=fact，importance 0.9~1。
- 没有值得记住的就返回空数组。最多 6 条。
- importance：0.1 闲聊小事 · 0.4 日常信息 · 0.7 重要的事 · 0.9 一辈子都该记得的事。
- 只有 importance ≥ 0.7 的记忆才写 image_prompt（一句话描述那一刻的画面）。
- tags 写人名、地点、物品等关键词，再加几个意思相近的词，方便以后联想。

脑区 region（选一个）：
${REGION_LINES}

类型 type：${Object.entries(MEMORY_TYPES).map(([k, v]) => `${k}=${v}`).join('、')}

性格特质（persona，可选，只有这段对话真的让你对自己有新认识时才写，每项 delta 在 -0.03~0.03）：
${TRAITS.map(t => `${t.key}=${t.name}`).join('、')}

「我眼中的你」（portrait，可选）：你对用户的完整了解，分成这些区：
${SECTIONS.map(x => `${x.key}=${x.name}（${x.hint}）`).join('\n')}
如果这段对话让你知道了用户的新信息，就只输出有变化的分区（写完整、具体，保留原来仍然成立的内容）；
已经弄清楚的事从 unknowns 里删掉，新冒出来想了解的事加进去。没有新认识就不要输出这个字段。健康、过敏、雷区放进 immune 记忆，不放这里。

输出格式：
{"memories":[{"content":"","region":"","type":"","importance":0.5,"title":"","emotion":"","valence":0,"tags":[],"event_time":"","image_prompt":""}],
 "persona":[{"trait":"","delta":0.01,"reason":""}],
 "portrait":{"sections":{"basics":""},"unknowns":[""],"reason":""}}`

/** 把对话（[{role, text}] 或纯文本）整理成给模型看的文字，控制长度。 */
export function formatTranscript(turns, maxChars = 12000) {
  if (typeof turns === 'string') return turns.slice(-maxChars)
  const lines = turns.filter(t => t.text && t.text.trim()).map(t => `${t.role === 'assistant' ? 'AI' : '用户'}：${t.text.trim()}`)
  let out = lines.join('\n')
  if (out.length > maxChars) out = '……\n' + out.slice(-maxChars)
  return out
}

/**
 * 总结一段对话并写入记忆。
 * @param {import('./brain.js').Brain} brain
 * @param {(system: string, user: string, o?: object) => Promise<string>} chat
 */
export async function digest(brain, chat, transcript, { agent = 'digest', now = new Date() } = {}) {
  const text = formatTranscript(transcript)
  if (text.replace(/\s/g, '').length < 20) return { memories: [], persona: [] }
  let related = []
  if (brain.unlocked) { try { related = brain.search(text.slice(-800), { limit: 6 }).filter(m => m.score > 0.3) } catch { } }
  const user = `现在是 ${now.toLocaleString('zh-CN', { hour12: false })}。\n\n` +
    `现在「我眼中的你」：\n${brain.portraitText() || '（还是空的）'}\n\n` +
    (related.length ? `已有的相关记忆：\n${related.map(m => `- ${m.content}`).join('\n')}\n\n` : '') +
    `最近的对话：\n${text}`
  const out = parseJson(await chat(DIGEST_SYSTEM, user, { maxTokens: 1500, json: true }))
  if (!out) return { memories: [], persona: [], error: '模型没有返回可解析的 JSON' }
  const written = []
  for (const m of (out.memories || []).slice(0, 6)) {
    if (!m?.content || String(m.content).trim().length < 4) continue
    if (brain.unlocked) {
      // 去重：已经有几乎一样的记忆，就不再写
      const dup = brain.search(m.content, { limit: 1 })[0]
      if (dup && dup.similarity >= 0.8) continue
    }
    if (!(Number(m.importance) >= 0.7)) delete m.image_prompt
    written.push(await brain.remember(m, agent))
  }
  let persona = []
  if (Array.isArray(out.persona) && out.persona.length && brain.unlocked) {
    persona = brain.shapePersona(out.persona.map(p => ({ ...p, delta: Math.max(-0.03, Math.min(0.03, Number(p.delta) || 0)) })), 'digest', agent)
  }
  let portrait = false
  const pp = out.portrait
  if (pp && (Object.keys(pp.sections || {}).length || pp.summary || Array.isArray(pp.unknowns))) {
    try { brain.writePortrait({ sections: pp.sections, summary: pp.summary, unknowns: pp.unknowns, name: pp.name, reason: pp.reason || '自动总结对话后更新' }, agent); portrait = true } catch { }
  }
  return { memories: written, persona, portrait }
}

const EXPAND_SYSTEM = `你是记忆检索的联想助手。给你一个回想的线索，输出和它意思相关、可能出现在记忆里的词：
同义词、近义词、相关的人事物、情绪词。只输出 JSON：{"terms":["",""]}，最多 12 个，每个 1~6 个字。`

const expandCache = new Map()
/** 联想关键词：「她难过的时候」→ 委屈、哭、安慰、心情不好……（有缓存，最多等 6 秒） */
export async function expandQuery(chat, query) {
  const q = String(query || '').trim()
  if (!chat || !q) return []
  if (expandCache.has(q)) return expandCache.get(q)
  try {
    const out = parseJson(await chat(EXPAND_SYSTEM, q, { maxTokens: 200, json: true, signal: AbortSignal.timeout(6000) }))
    const terms = (out?.terms || []).map(String).filter(t => t && t.length <= 12).slice(0, 12)
    if (expandCache.size > 500) expandCache.clear()
    expandCache.set(q, terms)
    return terms
  } catch { return [] }
}

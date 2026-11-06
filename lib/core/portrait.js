// 「我眼中的你」：AI 对用户的完整了解——就像你对一个老朋友心里有一份档案。
// 分成 12 个区，AI 有了新认识就改对应的那几区；「还不了解的」列出想慢慢知道的事。
// 健康、过敏、雷区放在「免疫系统·禁忌」（永不遗忘），这里不重复。

export const SECTIONS = [
  { key: 'basics', name: '基本信息', hint: '称呼、年龄或生日、所在城市、职业或学业、家庭情况' },
  { key: 'personality', name: '性格', hint: 'TA 是个怎样的人，外人看到的样子和真实的样子' },
  { key: 'people', name: '身边重要的人', hint: '家人、朋友、同事、宠物，以及 TA 和他们的关系' },
  { key: 'likes', name: '喜欢的', hint: '爱吃的、爱玩的、喜欢的音乐电影书、让 TA 眼睛发亮的东西' },
  { key: 'dislikes', name: '不喜欢的', hint: '讨厌的东西、受不了的事' },
  { key: 'routine', name: '作息与习惯', hint: '几点睡几点起、通勤、周末怎么过、小习惯' },
  { key: 'emotions', name: '情绪', hint: '什么会让 TA 开心或难过，难过时希望被怎样陪伴' },
  { key: 'communication', name: '沟通方式', hint: '喜欢怎样被说话、讨厌怎样被说话、你们之间的暗号' },
  { key: 'now', name: '最近', hint: 'TA 最近在经历的事、在忙的事、在烦恼的事' },
  { key: 'dreams', name: '目标与梦想', hint: '想成为什么样的人、想做的事、计划' },
  { key: 'values', name: '在意的事', hint: '价值观、原则、底线' },
  { key: 'us', name: '我们', hint: '你们的关系走到了哪里、默契、只属于你们的回忆' },
]
export const SECTION_KEYS = SECTIONS.map(s => s.key)
const BY_KEY = Object.fromEntries(SECTIONS.map(s => [s.key, s]))
const BY_NAME = Object.fromEntries(SECTIONS.map(s => [s.name, s.key]))

/** 统一成新格式（兼容早期只有一段 content 的版本）。 */
export function normalize(p) {
  if (!p) return null
  const sections = {}
  for (const [k, v] of Object.entries(p.sections || {})) { const key = BY_KEY[k] ? k : BY_NAME[k]; if (key && String(v || '').trim()) sections[key] = String(v).trim() }
  return {
    name: p.name || null,
    summary: (p.summary || p.content || '').trim() || null,
    sections,
    unknowns: Array.isArray(p.unknowns) ? p.unknowns.map(String).filter(Boolean) : [],
    at: p.at, by: p.by, reason: p.reason || null,
    known: Object.keys(sections).length, total: SECTIONS.length,
  }
}

/** 在旧档案上改：只动这次给出的区；某区给空字符串就清掉；unknowns 给了就整体替换。 */
export function merge(cur, patch) {
  const next = normalize(cur) || normalize({})
  if (patch.name !== undefined && String(patch.name).trim()) next.name = String(patch.name).trim().slice(0, 40)
  const summary = patch.summary ?? patch.content
  if (summary !== undefined && String(summary).trim()) next.summary = String(summary).trim().slice(0, 2000)
  for (const [k, v] of Object.entries(patch.sections || {})) {
    const key = BY_KEY[k] ? k : BY_NAME[k]; if (!key) continue
    const text = String(v ?? '').trim()
    if (text) next.sections[key] = text.slice(0, 1500); else delete next.sections[key]
  }
  if (Array.isArray(patch.unknowns)) next.unknowns = patch.unknowns.map(x => String(x).trim()).filter(Boolean).slice(0, 12).map(x => x.slice(0, 80))
  next.known = Object.keys(next.sections).length
  return next
}

export const changed = patch => ['name', 'summary', 'content'].some(k => patch[k] !== undefined && String(patch[k]).trim())
  || Object.keys(patch.sections || {}).length > 0 || Array.isArray(patch.unknowns)

/** 给模型看的文字：放进每次对话的上下文里。 */
export function portraitText(p) {
  p = normalize(p); if (!p) return ''
  const lines = []
  if (p.name) lines.push(`称呼：${p.name}`)
  if (p.summary) lines.push(`总体印象：${p.summary}`)
  for (const s of SECTIONS) if (p.sections[s.key]) lines.push(`· ${s.name}：${p.sections[s.key]}`)
  if (p.unknowns.length) lines.push(`还不了解的（在自然的时候慢慢知道，别像查户口一样问）：${p.unknowns.join('；')}`)
  lines.push(`了解程度：${p.known}/${p.total}`)
  return lines.join('\n')
}

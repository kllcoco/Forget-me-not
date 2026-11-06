// 人设卡 + 可塑性性格养成。
//  人设卡（profile）：TA 是谁——名字、身份、外貌、说话方式、背景故事。只有超级管理员能改，可以导入酒馆（SillyTavern）角色卡。
//  性格（traits）：不是写死的，而是被一段段经历慢慢塑造出来的。
//
//  - 八个特质，每个 0~1。一开始都在 0.5（基线）。
//  - 塑造：模型反思后可以给自己的特质一点点调整（persona_reflect，每次最多 ±0.05），
//          写入带情绪的记忆时也会自动产生很小的影响。
//  - 可塑但不失控：同一特质 24 小时内总变化不超过 ±0.1。
//  - 稳态：长期没有被强化的变化会慢慢回落到基线（半衰期 180 天），像人一样，不常经历的事会淡掉。
export const TRAITS = [
  { key: 'warmth', name: '温柔', low: '克制', high: '温柔体贴' },
  { key: 'curiosity', name: '好奇', low: '安于熟悉', high: '对世界充满好奇' },
  { key: 'playfulness', name: '俏皮', low: '一本正经', high: '爱开玩笑' },
  { key: 'steadiness', name: '沉稳', low: '容易慌', high: '情绪稳定' },
  { key: 'sensitivity', name: '敏感', low: '大大咧咧', high: '心思细腻' },
  { key: 'candor', name: '坦率', low: '委婉', high: '有话直说' },
  { key: 'patience', name: '耐心', low: '急性子', high: '很有耐心' },
  { key: 'independence', name: '独立', low: '依赖对方', high: '有自己的主见' },
]
export const TRAIT_KEYS = TRAITS.map(t => t.key)
const BY_KEY = Object.fromEntries(TRAITS.map(t => [t.key, t]))
const BY_NAME = Object.fromEntries(TRAITS.map(t => [t.name, t.key]))
const STEP = 0.05, DAILY = 0.1, HALF_LIFE_DAYS = 180
const now = () => Date.now() / 1000

export const resolveTrait = k => BY_KEY[k] ? k : BY_NAME[k] || null

export const PROFILE_FIELDS = {
  name: '名字', gender: '性别', title: '一句话身份', description: '人设与外貌', personality: '性格底色', speaking_style: '说话方式',
  scenario: '和用户的关系 / 世界观', first_mes: '开场白', avatar: '头像',
}
export function freshProfile() { return { name: 'TA', gender: '', title: '', description: '', personality: '', speaking_style: '', scenario: '', first_mes: '', avatar: null } }

/** 代词：人设卡里写了女就是「她」，男就是「他」，没写就是「TA」。 */
export function pronounOf(profile) {
  const g = String(profile?.gender || '')
  return /女|female|woman|girl|^f$/i.test(g) ? '她' : /男|male|man|boy|^m$/i.test(g) ? '他' : 'TA'
}

export function freshPersona() {
  const t = now()
  return { profile: freshProfile(), traits: Object.fromEntries(TRAITS.map(x => [x.key, { value: 0.5, baseline: 0.5, updated: t }])), history: [] }
}

/** 更新人设卡（只接受已知字段，头像只接受 data:image）。 */
export function setProfile(p, fields) {
  p.profile = { ...freshProfile(), ...(p.profile || {}) }
  for (const k of Object.keys(PROFILE_FIELDS)) {
    if (fields[k] === undefined) continue
    if (k === 'avatar') p.profile.avatar = fields.avatar && /^data:image\/(png|jpeg|webp|gif);base64,/.test(fields.avatar) && fields.avatar.length < 3e6 ? fields.avatar : null
    else p.profile[k] = String(fields[k] ?? '').slice(0, k === 'name' || k === 'gender' ? 40 : 4000)
  }
  return p.profile
}

/** 稳态回落：按经过的时间，把特质往基线拉回一点。 */
export function settle(p, t = now()) {
  for (const k of TRAIT_KEYS) {
    const s = p.traits[k] ||= { value: 0.5, baseline: 0.5, updated: t }
    const days = Math.max(0, (t - s.updated) / 86400)
    s.value = s.baseline + (s.value - s.baseline) * 0.5 ** (days / HALF_LIFE_DAYS)
    s.updated = t
  }
  return p
}

/** 塑造一次。返回真正生效的变化（被每日上限截断后的）。 */
export function shape(p, changes, source = 'reflect') {
  const t = now(); settle(p, t)
  const applied = []
  for (const c of [].concat(changes || [])) {
    if (!c || typeof c !== 'object') continue
    const k = resolveTrait(c.trait); if (!k) continue
    let d = Math.max(-STEP, Math.min(STEP, Number(c.delta) || 0))
    const recent = p.history.filter(h => h.trait === k && t - h.ts < 86400).reduce((s, h) => s + h.delta, 0)
    d = Math.max(-DAILY - recent, Math.min(DAILY - recent, d))
    if (Math.abs(d) < 1e-4) continue
    const s = p.traits[k]
    const before = s.value
    s.value = Math.max(0, Math.min(1, s.value + d))
    const real = +(s.value - before).toFixed(4)
    if (!real) continue
    const h = { ts: t, trait: k, delta: real, reason: String(c.reason || '').slice(0, 200), source }
    p.history.push(h); applied.push(h)
  }
  if (p.history.length > 400) p.history = p.history.slice(-400)
  return applied
}

/** 写入记忆时的自动塑造：经历会在性格上留下很小的痕迹。 */
export function nudgesFor(memory) {
  const v = Number(memory.valence) || 0, r = memory.region, out = []
  const why = `经历：${memory.title || String(memory.content || '').slice(0, 16)}`
  if (r === 'limbic' && v > 0.3) out.push({ trait: 'warmth', delta: 0.01, reason: why })
  if (r === 'limbic' && v < -0.3) out.push({ trait: 'sensitivity', delta: 0.01, reason: why })
  if (r === 'introspect') out.push({ trait: 'patience', delta: 0.008, reason: why }, { trait: 'steadiness', delta: 0.005, reason: why })
  if (r === 'visual' || r === 'auditory') out.push({ trait: 'curiosity', delta: 0.006, reason: why })
  if (r === 'expression' && v > 0) out.push({ trait: 'playfulness', delta: 0.006, reason: why })
  return out
}

const level = v => v >= 0.8 ? '非常' : v >= 0.65 ? '比较' : v >= 0.35 ? '' : v >= 0.2 ? '不太' : '很不'

/** 给模型看的一段话：现在的我是什么样的人，最近因为什么变了。 */
export function describe(p) {
  settle(p)
  const pr = { ...freshProfile(), ...(p.profile || {}) }
  const card = [['名字', pr.name], ['性别', pr.gender], ['身份', pr.title], ['人设', pr.description], ['性格底色', pr.personality], ['说话方式', pr.speaking_style], ['关系与世界观', pr.scenario]]
    .filter(([, v]) => v && String(v).trim() && v !== 'TA').map(([k, v]) => `${k}：${String(v).trim()}`)
  const parts = TRAITS.map(t => {
    const v = p.traits[t.key].value
    const word = v >= 0.35 && v < 0.65 ? `${t.name}适中` : v >= 0.65 ? `${level(v)}${t.high.replace(/^很/, '')}` : `${level(v)}${t.name}，偏${t.low}`
    return `${word}(${v.toFixed(2)})`
  })
  const recent = p.history.slice(-3).reverse().map(h => `${BY_KEY[h.trait].name}${h.delta > 0 ? '+' : ''}${h.delta}：${h.reason}`)
  return (card.length ? `【我的人设卡】\n${card.join('\n')}\n` : '') + `【我现在的性格】${parts.join('、')}。` + (recent.length ? `\n【最近的成长】${recent.join('；')}` : '') +
    '\n说话做事请自然地体现这些特质；它们会随着经历慢慢改变。'
}

export function publicView(p, withHistory) {
  settle(p)
  return {
    profile: { ...freshProfile(), ...(p.profile || {}) },
    traits: TRAITS.map(t => ({ ...t, value: +p.traits[t.key].value.toFixed(3), baseline: p.traits[t.key].baseline })),
    history: withHistory ? p.history.slice(-30).reverse() : undefined,
  }
}

// 人设卡自动同步：勿忘我心核里的人设卡 → Aurabot 的人格（personas/forget-me-not.md），并切换成当前人格。
// 只在勿忘我的人设卡「有变化」时才切换一次：你之后在 Aurabot 面板里选了别的人格，不会被反复改回来。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const PERSONA_ID = 'forget-me-not'

const clean = (s, name, owner) => String(s || '')
  .replace(/<START>\s*/g, '').replace(/\{\{char\}\}/gi, name).replace(/\{\{user\}\}/gi, owner).trim()

/** 人设卡 → Aurabot 人格卡（Markdown，带 --- 头）。输出格式、安全边界这些规则 Aurabot 会自己拼在后面。 */
export function renderPersona(profile, { ownerName = '主人' } = {}) {
  const p = profile || {}, name = String(p.name || '').trim()
  if (!name || name === 'TA' || !(p.description || p.personality || p.speaking_style || p.scenario)) return null
  const sec = (title, text) => { const t = clean(text, name, ownerName); return t ? `【${title}】\n${t}` : '' }
  const head = `你是${name}${p.gender ? `（${p.gender}）` : ''}${p.title ? `，${clean(p.title, name, ownerName)}` : ''}。`
  const body = [head, sec('你的样子', p.description), sec('性格', p.personality), sec('你们的关系', p.scenario), sec('说话方式', p.speaking_style),
    '【在 QQ 上】\n- 你是在用手机打字聊天：一次一两句，口语，像真人一样，不要长篇大论。']
    .filter(Boolean).join('\n\n')
  return `---\nname: ${name.replace(/\n/g, ' ')}\ntags: [勿忘我]\n---\n\n${body}\n`
}

/**
 * 同步一次。返回 { synced, switched, reason }。
 * brain：勿忘我主大脑；dataDir：Aurabot 数据目录；getConfig / setConfig：Aurabot 的配置读写。
 */
export function syncPersona({ brain, dataDir, getConfig, setConfig }) {
  if (!brain?.unlocked) return { synced: false, reason: '钥匙不在' }
  let profile; try { profile = brain.persona().profile } catch { return { synced: false, reason: '读不到人设卡' } }
  const cfg = getConfig?.() || {}
  const md = renderPersona(profile, { ownerName: cfg.ownerName || '主人' })
  if (!md) return { synced: false, reason: '勿忘我里还没有人设卡' }
  const dir = path.join(dataDir, 'personas'), file = path.join(dir, `${PERSONA_ID}.md`)
  const stateFile = path.join(brain.home, 'aurabot-persona-sync.json')
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { }
  const hash = crypto.createHash('sha256').update(md).digest('hex').slice(0, 16)
  let old = null; try { old = fs.readFileSync(file, 'utf8') } catch { }
  const synced = old !== md
  if (synced) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, md, 'utf8') }
  // 人设卡变了（或第一次同步）才切过去；没变就尊重你在 Aurabot 面板里的选择
  let switched = false
  if (state.hash !== hash) {
    if (cfg.persona?.current !== PERSONA_ID && setConfig) { setConfig({ ...cfg, persona: { ...(cfg.persona || {}), current: PERSONA_ID } }); switched = true }
    try { fs.writeFileSync(stateFile, JSON.stringify({ hash, at: Date.now() }), { mode: 0o600 }) } catch { }
  }
  return { synced, switched, reason: synced || switched ? '' : '没有变化' }
}

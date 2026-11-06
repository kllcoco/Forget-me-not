// 人设卡自动同步：勿忘我心核里的人设卡 → Aurabot 的人格（personas/forget-me-not.md），并切换成当前人格。
// 只在勿忘我的人设卡「有变化」时才切换一次：你之后在 Aurabot 面板里选了别的人格，不会被反复改回来。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const PERSONA_ID = 'forget-me-not'

const clean = (s, name, owner) => String(s || '')
  .replace(/<START>\s*/g, '').replace(/\{\{char\}\}/gi, name).replace(/\{\{user\}\}/gi, owner).trim()

// 和 Aurabot 自带人格一样严格的打字规矩：她的每一行都会单独发成一条 QQ 消息
export const QQ_RULES = `【最重要：你是在手机 QQ 上打字聊天，不是在写小说】
- 每次只回一两句话（最多两行）；一行就是一条消息，所以行数越少越好。
- 绝对不要用括号写动作、神态、心理，比如「（被问得一愣，鲸鳍晃了晃）」「（戳了戳你）」——一个都不要。想表达情绪，用语气词和表情就行：嗯嗯、嘿嘿、呜…、哼、~
- 不要分段、不要空行、不要列表、不要 Markdown。
- 不要把一件事拆成好几句连着发；不要复述对方的话，不要讲一大堆道理。
- 可以只回很短的一句：「吃啦~」「在呢」「怎么啦宝宝」。
错误示范：
（被问得一愣，鲸鳍轻轻晃了晃）
我自己那碗刚盛好，还没动筷子呢~
（戳了戳你的碗边）我想等你一起嘛
正确示范：
还没呢，等你一起吃嘛~`

/** 人设卡 → Aurabot 人格卡（Markdown，带 --- 头）。输出格式、安全边界这些规则 Aurabot 会自己拼在后面。 */
export function renderPersona(profile, { ownerName = '主人' } = {}) {
  const p = profile || {}, name = String(p.name || '').trim()
  if (!name || name === 'TA' || !(p.description || p.personality || p.speaking_style || p.scenario)) return null
  const sec = (title, text) => { const t = clean(text, name, ownerName); return t ? `【${title}】\n${t}` : '' }
  // 说话方式里常带「<START> 示例对话」：那是小说式的长回复（括号动作、分段、列表），到 QQ 上每一行都会变成一条消息，
  // 她照着学就会一句话回十条。只留示例前面的文字说明，示例本身不带过去。
  const style = String(p.speaking_style || '').split(/<START>/i)[0]
    .split('\n').map(l => l.split(/(?<=[。！？；])/).filter(x => !/括号|动作|列表|emoji|🌸|💕/.test(x)).join('')).filter(l => l.trim()).join('\n')
  const head = `你是${name}${p.gender ? `（${p.gender}）` : ''}${p.title ? `，${clean(p.title, name, ownerName)}` : ''}。`
  // 打字规矩放在最前面（分量最重），外貌只在别人问起时才说，免得她一开口就演起动作
  const body = [QQ_RULES, head, sec('你的样子（别人问起才说；平时不要描写自己的动作和神态）', p.description), sec('性格', p.personality), sec('你们的关系', p.scenario), sec('说话方式', style),
    '【再说一遍】一次一两句，不写括号里的动作。']
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

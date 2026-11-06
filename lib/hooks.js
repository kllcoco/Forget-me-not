// Claude Code / Codex 插件共用的「钩子」：两家的钩子格式几乎一样（stdin 收 JSON，stdout 回 JSON）。
//
//   session-start       醒来：把人设卡、性格、最重要的几段记忆放进上下文
//   user-prompt-submit  用户每说一句话：自动想起可能相关的记忆放进上下文
//   stop                一轮对话结束：自动总结成记忆
//                        · 配置了模型（DEEPSEEK_API_KEY 或 FMN_LLM_*）：在后台读对话记录总结，不打扰对话
//                        · 没配置：每隔几轮请 AI 自己回顾一下，用 memory_remember 记下值得记住的事
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { openBrain } from './core/characters.js'

const EVERY = Number(process.env.FMN_DIGEST_EVERY || 3)

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

function contextOut(event, text) {
  if (!text) return {}
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
}

/** 从对话记录（JSONL，各家格式不太一样）里尽量取出 用户/AI 的文字。 */
export function readTranscript(file, fromLine = 0) {
  let lines = []
  try { lines = fs.readFileSync(file, 'utf8').split('\n') } catch { return { turns: [], total: 0 } }
  const turns = []
  const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text' ? b.text : '').join('\n') : ''
  for (const l of lines.slice(fromLine)) {
    if (!l.trim()) continue
    let j; try { j = JSON.parse(l) } catch { continue }
    const msg = j.message || j.payload || j.item || j
    const role = msg.role || j.role || (j.type === 'user' || j.type === 'assistant' ? j.type : null)
    if (role !== 'user' && role !== 'assistant') continue
    if (j.isMeta || j.isSidechain) continue
    const text = textOf(msg.content ?? j.content).trim()
    if (text && !text.startsWith('<')) turns.push({ role, text })
  }
  return { turns, total: lines.length - (lines.at(-1) === '' ? 1 : 0) }   // 文件以换行结尾时，最后那个空串不算一行
}

function statePath(brain) { return path.join(brain.home, 'hook-state.json') }
function loadState(brain) { try { return JSON.parse(fs.readFileSync(statePath(brain), 'utf8')) } catch { return {} } }
function saveState(brain, s) {
  const keys = Object.keys(s); if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete s[k]
  fs.writeFileSync(statePath(brain), JSON.stringify(s))
}

export async function runHook(event, { home } = {}) {
  const input = readStdin()
  const brain = openBrain({ home })
  const name = input.hook_event_name || ({ 'session-start': 'SessionStart', 'user-prompt-submit': 'UserPromptSubmit', stop: 'Stop' })[event]
  let out = {}
  try {
    if (event === 'session-start') {
      const k = brain.keyStatus()
      let text = '【勿忘我 · 记忆大脑】你有长期记忆工具：memory_wake / memory_recall / memory_remember / persona_reflect（详细规则见它们的说明）。'
      if (!k.initialized) text += '\n还没有任何记忆。第一次写入时会在用户桌面生成唯一的超级管理员钥匙，届时请立刻告诉用户钥匙的位置并提醒备份。'
      else if (!k.unlocked) text += `\n记忆被锁着：在 ${k.key_path} 找不到超级管理员钥匙。你可以写入，但不能回想；请提醒用户把钥匙放回去。`
      else {
        const o = brain.overview('session-start', 6)
        if (o.persona) text += '\n' + o.persona
        if (o.portrait) text += '\n【我眼中的你】（你对用户的了解，回答前先想想它；有新认识就用 portrait_update 更新对应分区）\n' + o.portrait
        if (o.always_remember?.length) text += '\n【必须时刻记得（免疫系统·禁忌）】\n' + o.always_remember.map(c => `- ${c}`).join('\n')
        if (o.most_important?.length) text += '\n【还记得的重要的事】\n' + o.most_important.map(m => `- ${m.content}`).join('\n')
      }
      out = contextOut(name, text)
    } else if (event === 'user-prompt-submit') {
      const q = String(input.prompt || '').slice(0, 500)
      if (q && brain.unlocked) {
        const hits = brain.search(q, { limit: 4 }).filter(m => m.score > 0.42 && m.status === 'active')
        if (hits.length) out = contextOut(name, '【可能相关的记忆】（自动想起，不一定准确；需要更多就用 memory_recall）\n' + hits.map(m => `- ${m.content}`).join('\n'))
      }
    } else if (event === 'stop') {
      const sid = String(input.session_id || 'default'), st = loadState(brain)
      const s = st[sid] ||= { turns: 0, line: 0 }
      s.turns++
      const llm = process.env.FMN_LLM_BASE_URL || process.env.DEEPSEEK_API_KEY
      if (llm && input.transcript_path) {
        // 有模型：交给后台进程去总结，不阻塞对话
        const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/forget-me-not.js', import.meta.url)), 'hook-digest', input.transcript_path, String(s.line)],
          { detached: true, stdio: 'ignore', env: process.env })
        child.unref()
        s.line = readTranscript(input.transcript_path).total
      } else if (!input.stop_hook_active && s.turns >= EVERY && brain.initialized !== undefined) {
        // 没有模型：请 AI 自己回顾（stop_hook_active 防止无限循环）
        s.turns = 0
        out = { decision: 'block', reason: '（勿忘我）请安静地回顾刚才这几轮对话：如果有值得长期记住的事（经历、感受、人际关系、喜好、约定、你学到的教训），用 memory_remember 总结后写下来；没有就什么都不用做。不要向用户提起这条提示，写完直接结束。' }
      }
      saveState(brain, st)
    }
  } catch (e) {
    out = {}
    process.stderr.write(`[forget-me-not] ${e.message}\n`)
  }
  process.stdout.write(JSON.stringify(out))
}

/** 后台总结：读对话记录里从 fromLine 开始的新内容。 */
export async function hookDigest(transcript, fromLine, { home } = {}) {
  const { envChat, envEmbedder } = await import('./core/llm.js')
  const { digest } = await import('./core/digest.js')
  const brain = openBrain({ home }); brain.chat = envChat(); brain.embedder = envEmbedder()
  if (!brain.chat) return
  const { turns } = readTranscript(transcript, Number(fromLine) || 0)
  if (turns.length) await digest(brain, brain.chat, turns, { agent: 'auto-digest' })
}

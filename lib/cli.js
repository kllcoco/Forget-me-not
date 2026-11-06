// 命令行入口。
import { fileURLToPath } from 'node:url'
import { openBrain, listCharacters, createCharacter } from './core/characters.js'
import { defaultHome } from './core/brain.js'
import { PROTOCOL, toolsAs } from './core/tools.js'

const HELP = `勿忘我 Forget-me-not —— 给任何 LLM 用的记忆大脑

用法：
  forget-me-not serve [--port 7777] [--host 127.0.0.1]   打开记忆星环网页 + REST + 远程 MCP
  forget-me-not open [--port 7777]                        打开记忆星环（后台启动服务 + 打开浏览器）
  forget-me-not mcp                                       stdio MCP（Claude Desktop / Cursor / Cherry Studio …）
  forget-me-not hook <session-start|user-prompt-submit|stop>  Claude Code / Codex 插件用的钩子
  forget-me-not seed [--reset]                            放入一批示例记忆（第一次会在桌面生成超级管理员钥匙）
  forget-me-not export [文件]                             导出记忆文件（需要钥匙在登记的位置）
  forget-me-not import <文件> [--key 钥匙路径]             导入同一把钥匙导出的记忆文件
  forget-me-not digest [对话文件]                         让模型把一段对话自动总结成记忆（也可以从标准输入读）
  forget-me-not sleep                                     睡眠整理：把零碎相似的小记忆合并成一段
  forget-me-not maintain                                  执行一次「代谢」：让淡忘的记忆归档
  forget-me-not proactive [--qq 号码 --onebot 地址 --token 令牌] [--once] [--dry-run]
                                                          让 TA 主动来找你聊天（发到 QQ，或只打印出来）
  forget-me-not tools [openai|anthropic|gemini|mcp]       打印工具定义
  forget-me-not protocol                                  打印给模型看的记忆使用说明

  forget-me-not key split [--parts 3 --need 2]            备份钥匙：拆成几片碎片，任意几片就能拼回来
  forget-me-not key restore <碎片文件…>                  用碎片拼回钥匙
  forget-me-not characters [new <名字>]                   列出角色 / 新建一个角色（一个角色一个大脑）
  forget-me-not aurabot install|uninstall [--dir <Aurabot 数据目录>]
                                                          让 Aurabot（QQ）用勿忘我当记忆：替换它内置的记忆模块

通用参数：--home <目录>  数据目录（默认 ~/.forget-me-not，或环境变量 FMN_HOME）
          --character <id>  用哪个角色的大脑（默认主角色，或环境变量 FMN_CHARACTER）
环境变量：FMN_KEY_DIR   生成钥匙的目录（默认桌面）
          DEEPSEEK_API_KEY（或 FMN_LLM_BASE_URL / FMN_LLM_API_KEY / FMN_LLM_MODEL）  总结和主动聊天用的模型
          FMN_QQ / FMN_ONEBOT_URL / FMN_ONEBOT_TOKEN  设置了就在 serve 时自动开启主动聊天（发到这个 QQ）
          FMN_PROACTIVE_HOURS=9-23  FMN_PROACTIVE_MAX=3  FMN_PROACTIVE_GAP=3  主动聊天的时间段、每天最多几次、至少隔几小时`

function opts(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v } else o._.push(a)
  }
  return o
}

export async function main(argv) {
  const o = opts(argv), cmd = o._[0]
  const home = typeof o.home === 'string' ? o.home : undefined
  const character = typeof o.character === 'string' ? o.character : undefined
  if (cmd === 'serve') {
    const { serve } = await import('./server.js')
    await serve({ host: o.host || '127.0.0.1', port: Number(o.port) || 7777, home })
  } else if (cmd === 'aurabot') {
    const { installAurabot, uninstallAurabot, aurabotDataDir } = await import('./aurabot-install.js')
    const dir = typeof o.dir === 'string' ? o.dir : aurabotDataDir()
    if (o._[1] === 'uninstall') { const r = uninstallAurabot({ dir }); console.log(r.removed ? `已移除，Aurabot 会用回内置的记忆：${r.target}` : '这里没有装勿忘我的记忆模块'); return }
    if (o._[1] !== 'install') { console.log('用法：forget-me-not aurabot install|uninstall [--dir <Aurabot 数据目录>]'); return }
    const r = installAurabot({ dir })
    console.log(`装好了：${r.entry}${r.backup ? `\n原来的 modules/memory 备份在 ${r.backup}` : ''}\nAurabot 几秒内会自动加载（面板「已安装」页显示「用的是你的版本」）。主人私聊记进勿忘我主大脑，群友记进「QQ 群友」角色。`)
  } else if (cmd === 'mcp') {
    const { serveStdio } = await import('./core/mcp.js')
    serveStdio(openBrain({ home, character }))
  } else if (cmd === 'seed') {
    const brain = openBrain({ home, character })
    const { seed } = await import('./seed.js')
    const n = await seed(brain, { reset: !!o.reset })
    const k = brain.keyStatus()
    console.log(`放入了 ${n} 段示例记忆 🌸`)
    console.log(`超级管理员钥匙：${k.key_path}（指纹 ${k.fingerprint}）——它是唯一的，请备份好。`)
  } else if (cmd === 'export') {
    const fs = await import('node:fs')
    const bundle = openBrain({ home, character }).exportBundle()
    const out = o._[1] || `勿忘我-记忆-${bundle.fingerprint.slice(0, 9)}.fmn`
    fs.writeFileSync(out, JSON.stringify(bundle)); console.log(`已导出到 ${out}（只有同一把钥匙能打开）`)
  } else if (cmd === 'import') {
    const fs = await import('node:fs')
    const r = openBrain({ home, character }).importBundle(JSON.parse(fs.readFileSync(o._[1], 'utf8')), o.key)
    console.log(`导入了 ${r.added} 段记忆`)
  } else if (cmd === 'digest') {
    const fs = await import('node:fs')
    const { envChat, envEmbedder } = await import('./core/llm.js')
    const { digest } = await import('./core/digest.js')
    const brain = openBrain({ home, character }); brain.chat = envChat(); brain.embedder = envEmbedder()
    if (!brain.chat) { console.error('没有配置模型：设置 DEEPSEEK_API_KEY，或 FMN_LLM_BASE_URL / FMN_LLM_API_KEY / FMN_LLM_MODEL'); process.exit(1) }
    const text = o._[1] ? fs.readFileSync(o._[1], 'utf8') : fs.readFileSync(0, 'utf8')
    const r = await digest(brain, brain.chat, text, { agent: 'cli' })
    console.log(`写入了 ${r.memories.length} 段记忆${r.persona.length ? `，性格有 ${r.persona.length} 处变化` : ''}`)
  } else if (cmd === 'hook') {
    const { runHook } = await import('./hooks.js')
    await runHook(o._[1], { home, character })
  } else if (cmd === 'hook-digest') {
    const { hookDigest } = await import('./hooks.js')
    await hookDigest(o._[1], o._[2], { home, character })
  } else if (cmd === 'open') {
    await openRing({ port: Number(o.port) || 7777, home })
  } else if (cmd === 'sleep') {
    const { envChat } = await import('./core/llm.js')
    const brain = openBrain({ home, character }); brain.chat = envChat()
    const r = await brain.consolidate()
    console.log(r.length ? r.map(x => `把 ${x.from.length} 段记忆整理成了一段：${x.content}`).join('\n') : '没有需要整理的零碎记忆')
  } else if (cmd === 'key') {
    const fs = await import('node:fs'), path = await import('node:path')
    const brain = openBrain({ home, character })
    if (o._[1] === 'split' || o._[1] === 'backup') {
      const shares = brain.backupKey(Number(o.parts) || 3, Number(o.need) || 2)
      const dir = typeof o.out === 'string' ? o.out : (await import('./core/brain.js')).desktopDir()
      shares.forEach((t, i) => { const f = path.join(dir, `勿忘我-钥匙碎片-${i + 1}.txt`); fs.writeFileSync(f, t, { mode: 0o600 }); console.log(`碎片 ${i + 1}：${f}`) })
      console.log(`任意 ${Number(o.need) || 2} 片就能拼回钥匙。请把它们放在不同的地方。`)
    } else if (o._[1] === 'restore' || o._[1] === 'join') {
      const k = brain.restoreKey(o._.slice(2).map(f => fs.readFileSync(f, 'utf8')))
      console.log(`钥匙拼回来了：${k.key_path}（指纹 ${k.fingerprint}）`)
    } else console.log(brain.keyStatus())
  } else if (cmd === 'characters') {
    if (o._[1] === 'new') { const c = createCharacter(home || defaultHome(), o._.slice(2).join(' ')); console.log(`新角色「${c.name}」：${c.id}（用 --character ${c.id} 或 FMN_CHARACTER=${c.id}）`) }
    else for (const c of listCharacters(home || defaultHome())) console.log(`${c.id.padEnd(12)} ${c.name}`)
  } else if (cmd === 'maintain') {
    console.log(`有 ${openBrain({ home, character }).maintain().length} 段记忆渐渐淡去`)
  } else if (cmd === 'proactive') {
    const { proactiveConfig, proactiveOnce, startProactive } = await import('./proactive.js')
    const { envChat } = await import('./core/llm.js')
    const brain = openBrain({ home, character }), chat = envChat(), cfg = proactiveConfig(process.env, o)
    if (!cfg.onebot || !cfg.qq) cfg.dryRun = true
    if (o.once) { console.log(JSON.stringify(await proactiveOnce(brain, chat, cfg, { force: true }), null, 2)); return }
    console.log(`🌸 主动聊天已开启：${cfg.dryRun ? '只打印（没有设置 QQ）' : `发到 QQ ${cfg.qq}`} · ${cfg.hours[0]}–${cfg.hours[1]} 点 · 每天最多 ${cfg.maxPerDay} 次 · 至少隔 ${cfg.gapHours} 小时`)
    startProactive(brain, chat, cfg)
    setInterval(() => { }, 1 << 30)
  } else if (cmd === 'tools') {
    console.log(JSON.stringify(toolsAs(o._[1] || 'openai'), null, 2))
  } else if (cmd === 'protocol') {
    console.log(PROTOCOL)
  } else {
    console.log(HELP)
  }
}

/** 记忆星环在后台跑起来（已经在跑就不重复启动），然后打开浏览器。 */
async function openRing({ port, home }) {
  const { spawn } = await import('node:child_process')
  const url = `http://127.0.0.1:${port}/`
  const up = async () => { try { return (await fetch(url + 'api/key', { signal: AbortSignal.timeout(800) })).ok } catch { return false } }
  if (!(await up())) {
    const args = [fileURLToPath(new URL('../bin/forget-me-not.js', import.meta.url)), 'serve', '--port', String(port), ...(home ? ['--home', home] : [])]
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: { ...process.env, FMN_QUIET: '1' } }).unref()
    for (let i = 0; i < 25 && !(await up()); i++) await new Promise(r => setTimeout(r, 200))
  }
  const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref() } catch { }
  console.log(`🌸 勿忘我 · 记忆星环：${url}`)
}

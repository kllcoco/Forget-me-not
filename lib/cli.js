// 命令行入口。
import { Brain } from './core/brain.js'
import { PROTOCOL, toolsAs } from './core/tools.js'

const HELP = `勿忘我 Forget-me-not —— 给任何 LLM 用的记忆大脑

用法：
  forget-me-not serve [--port 7777] [--host 127.0.0.1]   打开记忆星环网页 + REST + 远程 MCP
  forget-me-not mcp                                       stdio MCP（Claude Desktop / Cursor / Cherry Studio …）
  forget-me-not seed [--reset]                            放入一批示例记忆（第一次会在桌面生成超级管理员钥匙）
  forget-me-not export [文件]                             导出记忆文件（需要钥匙在登记的位置）
  forget-me-not import <文件> [--key 钥匙路径]             导入同一把钥匙导出的记忆文件
  forget-me-not maintain                                  执行一次「代谢」：让淡忘的记忆归档
  forget-me-not tools [openai|anthropic|gemini|mcp]       打印工具定义
  forget-me-not protocol                                  打印给模型看的记忆使用说明

通用参数：--home <目录>  数据目录（默认 ~/.forget-me-not，或环境变量 FMN_HOME）
环境变量：FMN_KEY_DIR   生成钥匙的目录（默认桌面）`

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
  if (cmd === 'serve') {
    const { serve } = await import('./server.js')
    serve({ host: o.host || '127.0.0.1', port: Number(o.port) || 7777, home })
  } else if (cmd === 'mcp') {
    const { serveStdio } = await import('./core/mcp.js')
    serveStdio(new Brain(home))
  } else if (cmd === 'seed') {
    const brain = new Brain(home)
    const { seed } = await import('./seed.js')
    const n = await seed(brain, { reset: !!o.reset })
    const k = brain.keyStatus()
    console.log(`放入了 ${n} 段示例记忆 🌸`)
    console.log(`超级管理员钥匙：${k.key_path}（指纹 ${k.fingerprint}）——它是唯一的，请备份好。`)
  } else if (cmd === 'export') {
    const fs = await import('node:fs')
    const bundle = new Brain(home).exportBundle()
    const out = o._[1] || `勿忘我-记忆-${bundle.fingerprint.slice(0, 9)}.fmn`
    fs.writeFileSync(out, JSON.stringify(bundle)); console.log(`已导出到 ${out}（只有同一把钥匙能打开）`)
  } else if (cmd === 'import') {
    const fs = await import('node:fs')
    const r = new Brain(home).importBundle(JSON.parse(fs.readFileSync(o._[1], 'utf8')), o.key)
    console.log(`导入了 ${r.added} 段记忆`)
  } else if (cmd === 'maintain') {
    console.log(`有 ${new Brain(home).maintain().length} 段记忆渐渐淡去`)
  } else if (cmd === 'tools') {
    console.log(JSON.stringify(toolsAs(o._[1] || 'openai'), null, 2))
  } else if (cmd === 'protocol') {
    console.log(PROTOCOL)
  } else {
    console.log(HELP)
  }
}

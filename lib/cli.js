// 命令行入口。
import readline from 'node:readline'
import { Brain } from './core/brain.js'
import { PROTOCOL, toolsAs } from './core/tools.js'

const HELP = `勿忘我 Forget-me-not —— 给任何 LLM 用的记忆大脑

用法：
  forget-me-not serve [--port 7777] [--host 127.0.0.1]   打开记忆星环网页 + REST + 远程 MCP
  forget-me-not mcp                                       stdio MCP（Claude Desktop / Cursor / Cherry Studio …）
  forget-me-not seed [--reset]                            放入一批示例记忆（会询问超级管理员密码）
  forget-me-not maintain                                  执行一次「代谢」：让淡忘的记忆归档
  forget-me-not tools [openai|anthropic|gemini|mcp]       打印工具定义
  forget-me-not protocol                                  打印给模型看的记忆使用说明

通用参数：--home <目录>  数据目录（默认 ~/.forget-me-not，或环境变量 FMN_HOME）`

function opts(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v } else o._.push(a)
  }
  return o
}

function askHidden(q) {
  if (process.env.FMN_PASSWORD) return Promise.resolve(process.env.FMN_PASSWORD)
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = s => { if (s.startsWith(q)) process.stdout.write(s) }
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); resolve(a) })
  })
}

export async function main(argv) {
  const o = opts(argv), cmd = o._[0]
  const home = typeof o.home === 'string' ? o.home : undefined
  if (cmd === 'serve') {
    const { serve } = await import('./server.js')
    serve({ host: o.host || '127.0.0.1', port: Number(o.port) || 7777, home })
  } else if (cmd === 'mcp') {
    const { serveStdio } = await import('./core/mcp.js')
    serveStdio(() => new Brain(home))
  } else if (cmd === 'seed') {
    const brain = new Brain(home)
    const pw = await askHidden(brain.initialized ? '超级管理员密码：' : '设定超级管理员密码（至少 8 位）：')
    if (brain.initialized) brain.unlock(pw); else brain.setup(pw)
    const { seed } = await import('./seed.js')
    const n = await seed(brain, { reset: !!o.reset })
    console.log(`放入了 ${n} 段示例记忆 🌸`)
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

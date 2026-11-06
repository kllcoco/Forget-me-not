// DeepSeek Harness (dsh) 插件的 Host 端：
//   1. 给 AI 注册四个工具（醒来 / 封存写入 / 联想回想 / 性格养成）；
//   2. 把记忆使用说明放进系统提示词，并实时告诉 AI 钥匙在不在、TA 现在是什么性格；
//   3. 在 dsh 网页服务上挂载 /forget-me-not —— 记忆星环页面和它的接口（只有 dsh 的主人能打开，读内容还要超级管理员钥匙在登记的位置）。
// 浏览器端（左侧栏的「记忆」入口）在 ./client.js。
import path from 'node:path'
import { Brain, defaultHome } from './core/brain.js'
import { createHandler } from './core/http.js'
import { PROTOCOL, TOOLS, callTool } from './core/tools.js'

export const name = 'forget-me-not'
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']
export const MOUNT = '/forget-me-not'

let defineTool = null
try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')) } catch { /* 不在 dsh 里运行时没有这个包 */ }

// dsh 的参数格式：属性表，必填项写 required: true；对象要写 additionalProperties；不支持 minimum/maximum。
function toDshValue(v) {
  const { minimum, maximum, required, ...rest } = v
  if (rest.items) rest.items = toDshValue(rest.items)
  if (rest.type === 'object') { rest.properties = toDshParameters(v); rest.additionalProperties = false }
  return rest
}
function toDshParameters(schema) {
  const out = {}
  for (const [k, v] of Object.entries(schema.properties || {})) {
    out[k] = toDshValue(v)
    if (schema.required?.includes(k)) out[k].required = true
  }
  return out
}

function dataDirFrom(config) {
  if (config?.dataDir) return config.dataDir
  if (process.env.FMN_HOME) return process.env.FMN_HOME
  if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, 'forget-me-not')
  return defaultHome()
}

export function apply(ctx, config = {}) {
  const brain = new Brain(dataDirFrom(config))
  brain.maintain()
  const timer = setInterval(() => { try { brain.maintain() } catch { } }, 10 * 60 * 1000)
  timer.unref?.()
  ctx.effect?.(() => () => clearInterval(timer))

  // ---- 1. 工具
  if (!defineTool) throw new Error('forget-me-not: 找不到 @deepseek-ai/dsh-tools，请在 dsh 里通过 `dsh plugin add` 安装')
  for (const t of TOOLS) {
    ctx.tools.register(defineTool({
      name: t.name,
      description: t.description,
      parameters: toDshParameters(t.parameters),
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent?.name || exec?.agent?.id || 'dsh'
        return JSON.parse(JSON.stringify(await callTool(brain, t.name, args, String(agent))))
      },
    }))
  }

  // ---- 2. 系统提示词
  ctx.systemPrompt.section({ name: 'forget-me-not:protocol', order: 900, text: PROTOCOL })
  ctx.systemPrompt.context({
    name: 'forget-me-not:state',
    order: 900,
    text: () => {
      const k = brain.keyStatus()
      if (!k.initialized) return '【记忆大脑】还没有任何记忆。第一次写入时会在用户桌面生成唯一的超级管理员钥匙，届时请立刻告诉用户。'
      if (!k.unlocked) return `【记忆大脑】锁着：在 ${k.key_path} 找不到超级管理员钥匙。你可以写入，但不能回想；请提醒用户把钥匙放回去，或在「记忆」右下角的小钥匙里填新路径。`
      return '【记忆大脑】已解锁：可以写入，也可以回想。\n' + (brain.personaText() || '')
    },
  })

  // ---- 3. 记忆星环页面
  const handle = createHandler({ brain, base: MOUNT, exposeTools: false, connect: { dsh: 'dsh plugin add forget-me-not' } })
  ctx.webServer.register({
    kind: 'prefix',
    path: MOUNT,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection) { res.writeHead(rejection, { 'content-type': 'text/plain' }); res.end(rejection === 401 ? 'unauthorized' : 'forbidden'); return }
      if (!(await handle(req, res))) { res.writeHead(404); res.end() }
    },
  })
  console.log(`[forget-me-not] 已加载 ${TOOLS.length} 个记忆工具（${TOOLS.map(t => t.name).join(', ')}）；记忆星环：${MOUNT}/ ；数据：${brain.home}`)
}

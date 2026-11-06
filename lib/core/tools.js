// 给任何 LLM 用的工具定义。同一份定义会被翻译成：dsh 工具、MCP、OpenAI / Anthropic / Gemini 的 function calling、OpenAPI。
//
// 记忆是「封存」的：AI 只能写入新记忆、回想；不能修改、不能删除、不能翻原始数据。
import { MEMORY_TYPES, REGIONS } from './regions.js'
import { BrainError } from './brain.js'

const REGION_LINES = REGIONS.filter(r => r.kind === 'memory').map(r => `- ${r.key}（${r.name}）：${r.desc}`).join('\n')
const TYPE_LINE = Object.entries(MEMORY_TYPES).map(([k, v]) => `${k}=${v}`).join('、')
const REGION_ENUM = REGIONS.filter(r => r.kind === 'memory').map(r => r.key)

export const PROTOCOL = `你拥有一个长期记忆大脑「勿忘我 Forget-me-not」。它会像人一样记住、想起，也会慢慢遗忘。

【什么时候用】
1. 每次对话开始：先调用 memory_wake，看看自己记得什么。
2. 对方提到过去、人名、喜好，或你需要背景时：调用 memory_recall，用简短的关键词去回想。
3. 对话里出现值得记住的东西：调用 memory_remember。不要原样复制聊天记录，要你自己总结：
   用一两句完整、具体的话写清楚 谁 / 什么时候 / 发生了什么 / 感受如何，像写日记一样。

【封存规则】记忆一旦写入就被加密封存：你不能修改、不能删除，也读不到原始数据，只能通过回想把它想起来。
所以写之前想清楚；写错了就再写一条更正的记忆。只有超级管理员（用户本人，凭密码）可以修改或删除。
如果工具提示「记忆大脑在沉睡」，说明超级管理员还没有输入密码唤醒它，这时你只能写入，不能回想；请温柔地提醒用户去「记忆」面板唤醒。

【写进哪个脑区 region】
${REGION_LINES}

【记忆类型 type】${TYPE_LINE}

【重要性 importance 0~1】0.1 闲聊小事 · 0.4 日常信息 · 0.7 重要的事 · 0.9 一辈子都该记得的事。
不重要的记忆会随时间淡忘，被想起的次数越多记得越牢；淡忘的记忆遇到强烈的线索还能被重新想起。

【配图】只有重要的记忆（importance ≥ 0.7）才配图：
- 对方发来了照片，或你能生成图片：把图片链接、data:image/...;base64 或本地路径放进 image；
- 生成不了图片：在 image_prompt 里用一句话描述「那一刻的画面」，星环会为它画一幅记忆画。`

export const TOOLS = [
  {
    name: 'memory_wake',
    description: '醒来：查看记忆大脑的概况（各脑区记忆数量、最重要和最近的记忆）。每次对话开始先调用一次。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'memory_remember',
    description: '把一段记忆封存进大脑。content 必须是你自己总结后的完整描述，而不是原始聊天记录。选择最合适的脑区 region 和类型 type，并给出重要性 importance。写入后无法修改或删除。只有重要的记忆(importance≥0.7)才需要 image 或 image_prompt。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '总结后的记忆内容，一到三句话，具体、有画面感。' },
        region: { type: 'string', enum: REGION_ENUM, description: '写进哪个脑区。' },
        type: { type: 'string', enum: Object.keys(MEMORY_TYPES), description: '记忆类型。' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: '重要性 0~1。' },
        title: { type: 'string', description: '十个字以内的小标题。' },
        emotion: { type: 'string', description: '这段记忆的情绪，如 开心、想念、委屈、平静。' },
        valence: { type: 'number', minimum: -1, maximum: 1, description: '情绪正负：-1 难过 ~ 1 开心。' },
        tags: { type: 'array', items: { type: 'string' }, description: '关键词，如人名、地点、物品。' },
        event_time: { type: 'string', description: '事情发生的时间，如 2026-05-20 或 2026-05-20 19:30。' },
        image: { type: 'string', description: '那一刻的图片：http(s) 链接、data:image/...;base64 或本地路径。' },
        image_prompt: { type: 'string', description: '没有图片时，用一句话描述那一刻的画面。' },
      },
      required: ['content', 'region', 'importance'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_recall',
    description: '回想：用关键词或一句话去想起相关的记忆。被想起的记忆会记得更牢，淡忘的记忆遇到强线索会复苏。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "线索，如 '火锅'、'她的生日'、'上次吵架'。" },
        region: { type: 'string', enum: REGION_ENUM, description: '只在某个脑区里找（可选）。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多想起几条，默认 6。' },
        include_archived: { type: 'boolean', description: '是否连淡忘的记忆也一起翻找。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
]

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]))

const KEEP = ['id', 'region_name', 'type_name', 'title', 'content', 'importance', 'emotion', 'tags', 'event_time', 'created_at', 'status', 'strength', 'score', 'revived', 'image_prompt', 'has_image']
const brief = m => Object.fromEntries(KEEP.filter(k => m[k] != null && !(Array.isArray(m[k]) && !m[k].length)).map(k => [k, m[k]]))

/** 执行一次工具调用，返回可 JSON 序列化的结果。 */
export async function callTool(brain, name, args = {}, agent = null) {
  args = { ...(args || {}) }
  try {
    if (name === 'memory_wake') return brain.overview(agent)
    if (name === 'memory_remember') {
      const allowed = Object.keys(TOOL_BY_NAME.memory_remember.parameters.properties)
      const input = Object.fromEntries(Object.entries(args).filter(([k]) => allowed.includes(k)))
      return { ok: true, memory: await brain.remember(input, agent), note: '已封存。之后无法修改或删除。' }
    }
    if (name === 'memory_recall') {
      const hits = brain.recall(args.query || '', { region: args.region, limit: args.limit || 6, includeArchived: !!args.include_archived }, agent)
      return { count: hits.length, memories: hits.map(brief) }
    }
  } catch (e) {
    if (e instanceof BrainError) return { ok: false, error: e.code, message: e.message }
    throw e
  }
  throw new Error(`未知工具：${name}`)
}

export function toolsAs(fmt = 'openai') {
  fmt = String(fmt).toLowerCase()
  if (fmt === 'openai') return TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  if (fmt === 'anthropic') return TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  if (fmt === 'mcp') return TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters }))
  if (fmt === 'gemini') {
    const strip = s => Array.isArray(s) ? s.map(strip) : s && typeof s === 'object'
      ? Object.fromEntries(Object.entries(s).filter(([k]) => !['minimum', 'maximum', 'additionalProperties'].includes(k)).map(([k, v]) => [k, strip(v)])) : s
    return [{ function_declarations: TOOLS.map(t => ({ name: t.name, description: t.description, parameters: strip(t.parameters) })) }]
  }
  throw new Error('format 只能是 openai / anthropic / gemini / mcp')
}

export function openapi(baseUrl) {
  const paths = {}
  for (const t of TOOLS) {
    paths[`/api/tools/${t.name}`] = { post: {
      operationId: t.name, summary: t.description.slice(0, 120), description: t.description,
      requestBody: { required: true, content: { 'application/json': { schema: t.parameters } } },
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
    } }
  }
  return { openapi: '3.1.0', info: { title: 'Forget-me-not Memory', version: '0.1.0', description: PROTOCOL }, servers: [{ url: baseUrl }], paths }
}

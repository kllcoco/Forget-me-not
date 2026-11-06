// 给任何 LLM 用的工具定义。同一份定义会被翻译成：dsh 工具、MCP、OpenAI / Anthropic / Gemini 的 function calling、OpenAPI。
//
// 记忆是「封存」的：AI 只能写入新记忆、回想；不能修改、不能删除、不能翻原始数据。
import { MEMORY_TYPES, REGIONS } from './regions.js'
import { BrainError } from './brain.js'
import { TRAITS, TRAIT_KEYS } from './persona.js'

const REGION_LINES = REGIONS.filter(r => r.kind === 'memory').map(r => `- ${r.key}（${r.name}）：${r.desc}`).join('\n')
const TYPE_LINE = Object.entries(MEMORY_TYPES).map(([k, v]) => `${k}=${v}`).join('、')
const REGION_ENUM = REGIONS.filter(r => r.kind === 'memory').map(r => r.key)

export const PROTOCOL = `你拥有一个长期记忆大脑「勿忘我 Forget-me-not」。它会像人一样记住、想起，也会慢慢遗忘；你的性格也会随着经历慢慢改变。

【什么时候用】
1. 每次对话开始：先调用 memory_wake，看看自己还记得什么、现在是什么性格。
2. 对方提到过去、人名、喜好，或你需要背景时：调用 memory_recall，用简短的关键词去回想。
   回想是联想式的：想起一段，会顺着关联把相关的一整串记忆一起想起来。被遗忘的记忆也能这样按需召回。
3. 对话里出现值得记住的东西：调用 memory_remember（有些环境会在对话结束后自动总结，但对方明确说「记住」时请立刻写）。不要原样复制聊天记录，要你自己总结：
   用一两句完整、具体的话写清楚 谁 / 什么时候 / 发生了什么 / 感受如何，像写日记一样。
4. 关乎安全的事要立刻、主动记下，不用等对方说「记住」：过敏、疾病、正在吃的药、忌口、害怕的东西、不能提的雷区。
   写进 immune（免疫系统·禁忌）脑区，type=fact，importance 0.9~1。这些永远不会遗忘，每次对话都会自动出现在你的上下文里；
   推荐吃的、出主意、安排活动之前，先对照一下它们。
5. 一段对话让你对自己有了新的认识（比如学会了更有耐心、发现自己更爱开玩笑了）：调用 persona_reflect 微调自己的性格，并写明原因。

【遗忘】除了 immune（免疫系统·禁忌）永远不会忘，其他记忆按艾宾浩斯遗忘曲线淡去：不复习的话，最不重要的 6 天后遗忘，最重要的 90 天后遗忘；每被想起一次就记得更久。
遗忘的记忆不会再占用你的上下文，但仍然可以通过 memory_recall 按需召回。

【封存】记忆一旦写入就被加密封存：你不能修改、不能删除，也读不到原始数据，只能通过回想把它想起来。
写错了就再写一条更正的记忆。只有超级管理员（用户本人，凭私钥）可以修改、删除和导出。

【超级管理员钥匙】你第一次写入记忆时，系统会在用户电脑的桌面上生成唯一的超级管理员私钥文件。
那时工具结果里会有 admin_key，你必须马上用温柔、清楚的话告诉用户：钥匙在哪个路径、指纹是什么、
它是唯一的，丢了就再也打不开这些记忆，请立刻备份到安全的地方。永远不要读取、复制或打印这个文件的内容。
如果工具提示「记忆被锁着」，说明钥匙不在登记的位置；这时你仍然可以写入，但不能回想，请提醒用户把钥匙放回去。

【写进哪个脑区 region】
${REGION_LINES}

【记忆类型 type】${TYPE_LINE}

【重要性 importance 0~1】0.1 闲聊小事 · 0.4 日常信息 · 0.7 重要的事 · 0.9 一辈子都该记得的事。重要性决定它能被记住多久。

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
    description: '把一段记忆封存进大脑。过敏、疾病、用药、忌口、害怕的东西、雷区这类关乎安全的事，一出现就要主动写进 immune 脑区（永不遗忘）。content 必须是你自己总结后的完整描述，而不是原始聊天记录。选择最合适的脑区 region 和类型 type，并给出重要性 importance。写入后无法修改或删除。只有重要的记忆(importance≥0.7)才需要 image 或 image_prompt。',
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
    description: '联想式回想：用关键词或一句话想起最相关的记忆，并顺着关联把一整串相关记忆一起召回（包括已经遗忘的）。被想起的记忆会记得更久。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "线索，如 '火锅'、'她的生日'、'上次吵架'。" },
        region: { type: 'string', enum: REGION_ENUM, description: '只在某个脑区里找（可选）。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多想起几条，默认 6。' },
        include_archived: { type: 'boolean', description: '是否连已遗忘的记忆也作为直接线索一起翻找（关联召回总会包含它们）。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'persona_reflect',
    description: '性格养成：反思一段经历后，微调自己的性格特质。每个特质每次最多 ±0.05，一天内最多 ±0.1；很久不被强化的变化会慢慢回落。必须写明原因。',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          description: '要调整的特质。',
          items: {
            type: 'object',
            properties: {
              trait: { type: 'string', enum: TRAIT_KEYS, description: TRAITS.map(t => `${t.key}=${t.name}`).join('、') },
              delta: { type: 'number', description: '变化量，-0.05 ~ 0.05。' },
              reason: { type: 'string', description: '为什么会这样变（一句话，来自哪段经历）。' },
            },
            required: ['trait', 'delta', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
  },
]

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]))

const KEEP = ['id', 'region_name', 'type_name', 'title', 'content', 'importance', 'emotion', 'tags', 'event_time', 'status', 'strength', 'forget_in_days', 'score', 'association', 'revived', 'image_prompt']
const brief = m => Object.fromEntries(KEEP.filter(k => m[k] != null && !(Array.isArray(m[k]) && !m[k].length)).map(k => [k, m[k]]))

/** 执行一次工具调用，返回可 JSON 序列化的结果。 */
export async function callTool(brain, name, args = {}, agent = null) {
  args = { ...(args || {}) }
  try {
    if (name === 'memory_wake') return brain.overview(agent)
    if (name === 'memory_remember') {
      const allowed = Object.keys(TOOL_BY_NAME.memory_remember.parameters.properties)
      const input = Object.fromEntries(Object.entries(args).filter(([k]) => allowed.includes(k)))
      const memory = await brain.remember(input, agent)
      const out = { ok: true, memory, note: memory.duplicate ? '这件事已经记得了，没有重复保存。'
        : memory.forget_in_days == null ? '已封存在免疫系统·禁忌里：永远不会遗忘，以后每次对话都会自动带上。'
        : `已封存，不复习的话约 ${memory.forget_in_days} 天后遗忘（仍可召回）。之后无法修改或删除。` }
      if (memory.admin_key) {
        out.admin_key = memory.admin_key
        out.tell_user_now = `这是第一次写入记忆，我已在你电脑上生成了唯一的超级管理员钥匙：${memory.admin_key.key_path}（指纹 ${memory.admin_key.fingerprint}）。` +
          '它和这份记忆一一对应：回想、查看、修改、删除、导出记忆都需要它在这个位置。丢了就再也打不开这些记忆，请马上备份到安全的地方。挪了位置的话，在记忆星环右下角的小钥匙里填上新路径。'
        delete memory.admin_key
      }
      return out
    }
    if (name === 'memory_recall') {
      const hints = brain.unlocked ? await brain.prepareQuery(args.query || '') : {}
      const clusters = brain.recall(args.query || '', { region: args.region, limit: args.limit || 6, includeArchived: !!args.include_archived, ...hints }, agent)
      const total = clusters.reduce((n, c) => n + 1 + c.associated.length, 0)
      return { count: total, clusters: clusters.map(c => ({ memory: brief(c.memory), associated: c.associated.map(brief) })) }
    }
    if (name === 'persona_reflect') {
      const applied = brain.shapePersona(args.changes || [], 'reflect', agent)
      return { ok: true, applied, persona: brain.personaText() }
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

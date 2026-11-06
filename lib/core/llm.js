// 借一个大模型来「总结对话」和「联想关键词」，可选一个嵌入模型来做语义回想。
//
// 模型从哪来（按顺序）：
//   1. 在 DeepSeek Harness 里：直接借用当前会话正在用的模型，什么都不用配。
//   2. 环境变量：FMN_LLM_BASE_URL + FMN_LLM_API_KEY + FMN_LLM_MODEL（任何 OpenAI 兼容接口）。
//   3. 有 DEEPSEEK_API_KEY 时：默认用 https://api.deepseek.com 的 deepseek-chat。
// 嵌入模型（可选，配了回想会更懂「意思相近」）：FMN_EMBED_BASE_URL + FMN_EMBED_API_KEY + FMN_EMBED_MODEL，
//   例如 OpenAI text-embedding-3-small、硅基流动 BAAI/bge-m3、本地 Ollama bge-m3。

/** 通用的 OpenAI 兼容对话。没有配置时返回 null。 */
export function envChat(env = process.env) {
  const key = env.FMN_LLM_API_KEY || env.DEEPSEEK_API_KEY
  const base = (env.FMN_LLM_BASE_URL || (env.DEEPSEEK_API_KEY ? 'https://api.deepseek.com' : '')).replace(/\/+$/, '')
  if (!base) return null
  const model = env.FMN_LLM_MODEL || 'deepseek-chat'
  return async (system, user, { maxTokens = 1200, json = false, signal } = {}) => {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal: signal || AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    })
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}`)
    return (await r.json()).choices?.[0]?.message?.content || ''
  }
}

/** 借用 dsh 的模型：getTarget() 返回 { provider, model }。 */
export function dshChat(llm, getTarget) {
  return async (system, user, { maxTokens = 1200, signal } = {}) => {
    const target = getTarget(); if (!target) throw new Error('没有可用的模型')
    let text = ''
    for await (const c of llm.stream({ provider: target.provider, model: target.model, system, maxTokens, signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] })) {
      if (c.type === 'text-delta') text += c.text
      if (c.type === 'finish' && (c.reason?.kind === 'error' || c.reason?.kind === 'aborted')) throw new Error('模型调用失败')
    }
    return text
  }
}

/** 嵌入模型。没有配置时返回 null。 */
export function envEmbedder(env = process.env) {
  const base = (env.FMN_EMBED_BASE_URL || '').replace(/\/+$/, '')
  if (!base) return null
  const key = env.FMN_EMBED_API_KEY, model = env.FMN_EMBED_MODEL || 'text-embedding-3-small'
  const fn = async texts => {
    const r = await fetch(`${base}/embeddings`, {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, input: texts }),
    })
    if (!r.ok) throw new Error(`embedding HTTP ${r.status}`)
    return (await r.json()).data.sort((a, b) => a.index - b.index).map(d => d.embedding)
  }
  fn.id = `${base}#${model}`
  return fn
}

/** 把模型回答里的 JSON 抠出来（模型有时会包一层 ```json）。 */
export function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '')
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b < a) return null
  try { return JSON.parse(t.slice(a, b + 1)) } catch { return null }
}

// ---- 向量压缩：float → int8，内容随记忆一起加密保存
export function quantize(v) {
  let max = 0; for (const x of v) max = Math.max(max, Math.abs(x))
  const s = max / 127 || 1, q = Int8Array.from(v, x => Math.round(x / s))
  return { s, q: Buffer.from(q.buffer).toString('base64') }
}
export function dequantize(d) {
  const b = Buffer.from(d.q, 'base64'), q = new Int8Array(b.buffer, b.byteOffset, b.length)
  const v = new Float32Array(q.length); let n = 0
  for (let i = 0; i < q.length; i++) { v[i] = q[i] * d.s; n += v[i] * v[i] }
  n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}
export function dot(a, b) { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s }
export function normalize(v) { const f = Float32Array.from(v); let n = 0; for (const x of f) n += x * x; n = Math.sqrt(n) || 1; return f.map(x => x / n) }

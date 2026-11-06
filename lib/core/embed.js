// 零依赖的轻量文本向量：中文按字/双字切，英文按单词切，哈希到稀疏向量。
// 足够让「火锅」想起「重庆火锅那家店」。

const DIM = 1 << 18
const CJK = /[㐀-鿿豈-﫿]+/g
const WORD = /[a-z0-9]+/g
const STOP = new Set('的了是我你他她它在和就也都还很吗呢吧啊呀哦嗯这那有个一不人们')

function crc32(str) {
  let c = ~0
  for (const b of Buffer.from(str, 'utf8')) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

export function* tokens(text) {
  const t = String(text || '').toLowerCase()
  for (const run of t.match(CJK) || []) {
    const chars = [...run]
    for (let i = 0; i < chars.length; i++) {
      if (!STOP.has(chars[i])) yield [chars[i], 0.4]
      if (i + 1 < chars.length) yield [chars[i] + chars[i + 1], 1.0]
    }
  }
  for (const w of t.match(WORD) || []) yield [w, 1.0]
}

export function embed(text) {
  const v = {}
  for (const [tok, w] of tokens(text)) { const h = crc32(tok) % DIM; v[h] = (v[h] || 0) + w }
  let norm = 0
  for (const k in v) { v[k] = Math.sqrt(v[k]); norm += v[k] * v[k] }
  norm = Math.sqrt(norm) || 1
  for (const k in v) v[k] /= norm
  return v
}

export function cosine(a, b) {
  let s = 0
  const [x, y] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a]
  for (const k in x) if (k in y) s += x[k] * y[k]
  return s
}

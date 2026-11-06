// 钥匙备份：沙米尔秘密分享（Shamir's Secret Sharing），在 GF(256) 上逐字节做。
// 把钥匙拆成 n 片，任意 k 片就能拼回来；少于 k 片得不到钥匙的任何信息。
import crypto from 'node:crypto'

const EXP = new Uint8Array(512), LOG = new Uint8Array(256)
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x ^= x << 1; if (x & 0x100) x ^= 0x11b } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] }
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0)

/** 拆：返回 n 片，每片 { x, data: Buffer }。 */
export function split(secret, n = 3, k = 2) {
  if (!(k >= 2 && n >= k && n <= 255)) throw new Error('碎片数要满足 2 ≤ 需要的片数 ≤ 总片数 ≤ 255')
  const shares = Array.from({ length: n }, (_, i) => ({ x: i + 1, data: Buffer.alloc(secret.length) }))
  for (let j = 0; j < secret.length; j++) {
    const coef = [secret[j], ...crypto.randomBytes(k - 1)]   // f(0) = 秘密这一字节
    for (const s of shares) { let y = 0; for (let d = coef.length - 1; d >= 0; d--) y = mul(y, s.x) ^ coef[d]; s.data[j] = y }
  }
  return shares
}

/** 拼：拉格朗日插值求 f(0)。 */
export function combine(shares) {
  const len = shares[0].data.length, out = Buffer.alloc(len)
  for (let j = 0; j < len; j++) {
    let acc = 0
    for (let i = 0; i < shares.length; i++) {
      let num = 1, den = 1
      for (let m = 0; m < shares.length; m++) if (m !== i) { num = mul(num, shares[m].x); den = mul(den, shares[m].x ^ shares[i].x) }
      acc ^= mul(shares[i].data[j], div(num, den))
    }
    out[j] = acc
  }
  return out
}

const LINE = /FMN-SHARE-1:(\d+):(\d+):([0-9A-F-]+):([A-Za-z0-9+/=]+)/

/** 钥匙文本 → n 份可以打印、可以存成 txt 的碎片文本。 */
export function splitKey(pem, fingerprint, n = 3, k = 2) {
  return split(Buffer.from(pem, 'utf8'), n, k).map(s => [
    `勿忘我 · 超级管理员钥匙碎片 ${s.x}/${n}`,
    `任意 ${k} 片放在一起，就能拼回钥匙；只有 1 片的人什么也打不开。`,
    `请把每一片放在不同的地方（抽屉、家人那里、U 盘……）。`,
    `指纹：${fingerprint}`,
    '',
    `FMN-SHARE-1:${k}:${s.x}:${fingerprint}:${s.data.toString('base64')}`,
    '',
  ].join('\n'))
}

/** 几片碎片文本 → 钥匙的 PEM 文本。 */
export function joinKey(texts) {
  const parsed = texts.map(t => String(t).match(LINE)).filter(Boolean).map(m => ({ k: +m[1], x: +m[2], fp: m[3], data: Buffer.from(m[4], 'base64') }))
  const uniq = [...new Map(parsed.map(p => [p.x, p])).values()]
  if (!uniq.length) throw Object.assign(new Error('没有找到钥匙碎片'), { code: 'BAD_SHARE' })
  const { k, fp } = uniq[0]
  if (uniq.some(p => p.fp !== fp)) throw Object.assign(new Error('这些碎片不属于同一把钥匙'), { code: 'BAD_SHARE' })
  if (uniq.length < k) throw Object.assign(new Error(`还差 ${k - uniq.length} 片：需要任意 ${k} 片`), { code: 'BAD_SHARE' })
  return { pem: combine(uniq.slice(0, k)).toString('utf8'), fingerprint: fp }
}

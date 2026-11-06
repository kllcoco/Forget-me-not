// 记忆大脑：封存写入、联想式回想、按艾宾浩斯曲线遗忘、复苏、可塑性性格。
//
// 数据目录（默认 ~/.forget-me-not/，dsh 里在 $DSH_HOME/forget-me-not/）：
//   vault.json     公钥、指纹、私钥所在的路径（只有路径，没有私钥）
//   memories.json  每段记忆：脑区、时间、重要性等「外形」是明文（用来画星环），内容全部加密
//   persona.json   性格（加密）
//   events.jsonl   大脑活动日志（回想的线索加密）
//   images/*.bin   加密后的配图
//
// 每次读取都会去 vault.json 里登记的路径读私钥：钥匙在就自动解锁，不在谁都打不开。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { embed, cosine, tokens } from './embed.js'
import { dequantize, dot, normalize, quantize } from './llm.js'
import { fingerprint, loadPrivateKey, newAdminKey, open, publicKeyOf, seal } from './vault.js'
import { MEMORY_TYPES, REGIONS, REGION_BY_KEY, resolveRegion, resolveType } from './regions.js'
import { describe, freshPersona, nudgesFor, publicView, setProfile, settle, shape } from './persona.js'

const DAY = 86400
export const ARCHIVE_STRENGTH = 0.12      // 记忆强度低于它就被遗忘（归档，可按需召回）
export const FORGET_DAYS = [6, 90]        // 不复习的话：最不重要的 6 天忘掉，最重要的 90 天忘掉
const LN_ARCHIVE = Math.log(1 / ARCHIVE_STRENGTH)
export const REVIVE_SIM = 0.3              // 已遗忘的记忆，线索足够像时会被重新想起
export const LINK_MIN = 0.3                // 两段记忆的关联度高于它，就算「连在一起」
const MAX_IMAGE = 20 * 1024 * 1024
const KEY_FILE_NAME = '勿忘我-超级管理员钥匙.key'

export const defaultHome = () => process.env.FMN_HOME || path.join(os.homedir(), '.forget-me-not')
const now = () => Date.now() / 1000

export class BrainError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const LOCKED = () => new BrainError('LOCKED', '记忆被锁着：在登记的位置找不到超级管理员钥匙。请用户把钥匙放回原处，或在记忆星环右下角的小钥匙里填上新路径。')

/** 找桌面：macOS / Windows 是 ~/Desktop，中文 Linux 常是 ~/桌面，也可能写在 XDG 配置里。 */
export function desktopDir() {
  if (process.env.FMN_KEY_DIR) return process.env.FMN_KEY_DIR
  const home = os.homedir()
  try {
    const xdg = fs.readFileSync(path.join(home, '.config/user-dirs.dirs'), 'utf8').match(/XDG_DESKTOP_DIR="([^"]+)"/)
    if (xdg) { const p = xdg[1].replace('$HOME', home); if (fs.existsSync(p)) return p }
  } catch { }
  for (const d of [path.join(home, 'Desktop'), path.join(home, '桌面'), path.join(process.env.USERPROFILE || home, 'Desktop')]) if (fs.existsSync(d)) return d
  return home
}

function parseTime(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v
  const s = String(v).trim().replace(/\//g, '-')
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') : s)
  return Number.isNaN(t) ? null : t / 1000
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const expandHome = p => String(p || '').trim().replace(/^~(?=$|[\\/])/, os.homedir())

export class Brain {
  constructor(home = defaultHome()) {
    this.home = home
    this.imageDir = path.join(home, 'images')
    fs.mkdirSync(this.imageDir, { recursive: true, mode: 0o700 })
    this.files = {
      vault: path.join(home, 'vault.json'), memories: path.join(home, 'memories.json'), persona: path.join(home, 'persona.json'),
      events: path.join(home, 'events.jsonl'), lock: path.join(home, '.lock'),
    }
    this.secrets = new Map()   // id → 解开的内容（只在钥匙在的时候缓存）
    this.memories = []
    this._mtime = 0; this._seq = 0; this._key = { stamp: null, priv: null }; this._graph = null; this._bm25 = null
    this.chat = null       // 可选：(system, user, opts) => Promise<string>，用来自动总结和联想
    this.embedder = null   // 可选：(texts) => Promise<number[][]>，用来做语义回想
    this._load()
  }

  // ------------------------------------------------------------------ 钥匙
  get vault() { try { return JSON.parse(fs.readFileSync(this.files.vault, 'utf8')) } catch { return null } }
  get initialized() { return this.vault != null }

  /** 去登记的路径看一眼钥匙在不在。在：返回私钥；不在：清空缓存，返回 null。 */
  _priv() {
    const v = this.vault
    if (!v) return null
    let st = null
    try { st = fs.statSync(v.key_path) } catch { }
    const stamp = st ? `${v.key_path}|${st.mtimeMs}|${st.size}|${v.publicKey}` : null
    if (stamp && stamp === this._key.stamp) return this._key.priv
    const priv = st ? loadPrivateKey(fs.readFileSync(v.key_path, 'utf8'), v.publicKey) : null
    if (!priv) { this.secrets.clear(); this._graph = null }
    this._key = { stamp: priv ? stamp : null, priv }
    return priv
  }
  get unlocked() { return this._priv() != null }
  _need() { const p = this._priv(); if (!p) throw LOCKED(); return p }

  keyStatus() {
    const v = this.vault
    if (!v) return { initialized: false, unlocked: false }
    const exists = fs.existsSync(v.key_path)
    return { initialized: true, unlocked: this.unlocked, key_path: v.key_path, key_exists: exists, fingerprint: v.fingerprint, created_at: v.created_at }
  }

  /** 模型第一次写记忆：在你电脑上生成唯一的超级管理员钥匙，放到桌面。 */
  _genesis() {
    const k = newAdminKey()
    const dir = desktopDir(); fs.mkdirSync(dir, { recursive: true })
    let file = path.join(dir, KEY_FILE_NAME)
    if (fs.existsSync(file)) file = path.join(dir, KEY_FILE_NAME.replace('.key', `-${k.fingerprint.slice(0, 4)}.key`))
    fs.writeFileSync(file, k.file, { mode: 0o600, flag: 'wx' })
    const v = { v: 2, publicKey: k.publicKey, fingerprint: k.fingerprint, key_path: file, created_at: now() }
    atomicWrite(this.files.vault, JSON.stringify(v, null, 2))
    this._event('genesis', [], null, { key_path: file })
    return { key_path: file, fingerprint: k.fingerprint }
  }

  /** 小钥匙按钮：换一个私钥路径。新路径上必须真的是这把钥匙。 */
  setKeyPath(p) {
    const v = this.vault; if (!v) throw new BrainError('NO_VAULT', '还没有记忆，也还没有钥匙')
    const file = path.resolve(expandHome(p))
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { throw new BrainError('KEY_MISSING', `在 ${file} 找不到文件`) }
    if (!loadPrivateKey(text, v.publicKey)) throw new BrainError('KEY_MISMATCH', '这个文件不是这份记忆的钥匙（指纹对不上）')
    atomicWrite(this.files.vault, JSON.stringify({ ...v, key_path: file }, null, 2))
    this._key = { stamp: null, priv: null }
    this._event('key', [], 'admin')
    return this.keyStatus()
  }

  // ------------------------------------------------------------------ 存取
  _load(force = false) {
    let st
    try { st = fs.statSync(this.files.memories) } catch { this.memories = []; return }
    if (!force && st.mtimeMs === this._mtime) return
    this._mtime = st.mtimeMs; this._graph = null; this._bm25 = null
    try { this.memories = JSON.parse(fs.readFileSync(this.files.memories, 'utf8')).memories || [] } catch { this.memories = [] }
    const ids = new Set(this.memories.map(m => m.id))
    for (const id of this.secrets.keys()) if (!ids.has(id)) this.secrets.delete(id)
  }

  _save() {
    atomicWrite(this.files.memories, JSON.stringify({ v: 2, memories: this.memories }))
    this._mtime = fs.statSync(this.files.memories).mtimeMs; this._graph = null; this._bm25 = null
  }

  /** 跨进程的简单文件锁：MCP 进程和网页服务可能同时写。 */
  _withLock(fn) {
    const start = Date.now()
    for (;;) {
      try { fs.closeSync(fs.openSync(this.files.lock, 'wx')); break } catch (e) {
        if (e.code !== 'EEXIST') throw e
        try { if (Date.now() - fs.statSync(this.files.lock).mtimeMs > 10000) fs.rmSync(this.files.lock, { force: true }) } catch { }
        if (Date.now() - start > 5000) throw new BrainError('BUSY', '记忆大脑正忙，请稍后再试')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
      }
    }
    try { this._load(); return fn() } finally { fs.rmSync(this.files.lock, { force: true }) }
  }

  _secret(m, priv = this._priv()) {
    if (!priv) return null
    let s = this.secrets.get(m.id)
    if (!s) { try { s = open(priv, m.box, m.id); this.secrets.set(m.id, s) } catch { return null } }
    return s
  }

  _event(kind, ids = [], agent = null, extra = {}) {
    const e = { id: Math.floor(Date.now()) * 1000 + (this._seq++ % 1000), ts: now(), kind, agent: agent || null, memory_ids: ids, ...extra }
    fs.appendFileSync(this.files.events, JSON.stringify(e) + '\n', { mode: 0o600 })
    return e
  }

  // ------------------------------------------------------------------ 遗忘曲线（艾宾浩斯）
  /** 不复习的话，这段记忆几天后被遗忘：6~90 天，越重要越久；工作记忆最多 12 天。 */
  forgetDays(m) {
    const imp = Math.max(0, Math.min(1, Number(m.importance ?? 0.5)))
    return m.region === 'working' ? 6 + 6 * imp : FORGET_DAYS[0] + (FORGET_DAYS[1] - FORGET_DAYS[0]) * imp
  }

  /** 保持率 R = e^(-t/S)。每被想起一次，稳定期 S 变长 60%（间隔重复，最多算 6 次）。 */
  strength(m, t = now()) {
    const S = this.forgetDays(m) / LN_ARCHIVE * 1.6 ** Math.min(m.access_count || 0, 6)
    const days = Math.max(0, (t - (m.last_access || t)) / DAY)
    return Math.exp(-days / S)
  }

  // ------------------------------------------------------------------ 写入（不需要钥匙）
  async remember(input, agent = null) {
    const content = String(input.content || '').trim()
    if (!content) throw new BrainError('EMPTY', 'content 不能为空：请先把要记住的内容用自己的话总结成一两句。')
    let genesis = null
    if (!this.initialized) genesis = this._withLock(() => this.initialized ? null : this._genesis())
    // 几乎一模一样的记忆已经有了，就不再存第二份（钥匙在时才能比较）
    if (input._log !== false && !genesis && this.unlocked) {
      const same = this.search(content, { limit: 1, region: input.region ? resolveRegion(input.region) : undefined })[0]
      if (same && same.similarity >= 0.9 && same.status === 'active') {
        return { id: same.id, region: same.region, region_name: same.region_name, type: same.type, importance: same.importance,
          forget_in_days: same.forget_in_days, has_image: same.has_image, duplicate: true }
      }
    }
    const v = this.vault, pub = publicKeyOf(v.publicKey)
    let tags = input.tags || []
    if (typeof tags === 'string') tags = tags.split(/[,，、\s]+/).filter(Boolean)
    const id = 'm_' + crypto.randomBytes(5).toString('hex')
    const created = parseTime(input.created_at) || now()
    let imageKind = null
    if (input.image) {
      const img = await this._fetchImage(input.image).catch(() => null)
      if (img) {
        fs.writeFileSync(path.join(this.imageDir, id + '.bin'), JSON.stringify(seal(pub, Buffer.concat([Buffer.from(img.mime.padEnd(40)), img.data]), id + ':img')), { mode: 0o600 })
        imageKind = 'photo'
      }
    }
    if (!imageKind && input.image_prompt) imageKind = 'dream'
    const secret = {
      title: input.title || null, content, emotion: input.emotion || null,
      valence: Math.max(-1, Math.min(1, Number(input.valence) || 0)), tags: tags.map(String), image_prompt: input.image_prompt || null,
    }
    secret.vec = embed([secret.title, content, secret.emotion, secret.tags.join(' ')].filter(Boolean).join(' '))
    if (this.embedder) {
      try { const [v] = await this.embedder([content + (secret.tags.length ? ' ' + secret.tags.join(' ') : '')]); secret.dv = quantize(normalize(v)); secret.dvm = this.embedder.id } catch { }
    }
    const m = {
      id, region: resolveRegion(input.region), type: resolveType(input.type),
      importance: Math.max(0, Math.min(1, Number(input.importance ?? 0.5))),
      created_at: created, event_time: parseTime(input.event_time) || created, last_access: parseTime(input.last_access) || created,
      access_count: Number(input.access_count) || 0, status: input.status === 'archived' ? 'archived' : 'active',
      has_image: Boolean(imageKind), image_kind: imageKind, source: agent || null,
      box: seal(pub, secret, id),
    }
    this._withLock(() => { this.memories.push(m); this._save() })
    if (this._priv()) this.secrets.set(id, secret)
    if (input._log !== false) {
      this._event('remember', [id], agent, { region: m.region })
      this.maintain()
      const n = nudgesFor({ ...m, ...secret })
      if (n.length && this.unlocked) this.shapePersona(n, 'experience')
    }
    const out = { id, region: m.region, region_name: REGION_BY_KEY[m.region].name, type: m.type, importance: m.importance,
      forget_in_days: Math.round(this.forgetDays(m)), has_image: m.has_image }
    if (genesis) out.admin_key = genesis
    return out
  }

  async _fetchImage(src) {
    src = String(src).trim()
    if (/^data:/.test(src)) {
      const [head, b64] = src.split(',', 2)
      return { mime: head.slice(5).split(';')[0] || 'image/png', data: Buffer.from(b64, 'base64') }
    }
    if (/^https?:\/\//.test(src)) {
      const r = await fetch(src, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'forget-me-not' } })
      if (!r.ok) throw new Error('download failed')
      const data = Buffer.from(await r.arrayBuffer())
      if (data.length > MAX_IMAGE) throw new Error('too large')
      return { mime: (r.headers.get('content-type') || 'image/jpeg').split(';')[0], data }
    }
    const p = expandHome(src)
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const ext = path.extname(p).toLowerCase().slice(1)
      return { mime: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png', data: fs.readFileSync(p) }
    }
    if (/^[A-Za-z0-9+/=\s]{200,}$/.test(src)) return { mime: 'image/png', data: Buffer.from(src, 'base64') }
    throw new Error('unsupported image')
  }

  image(id) {
    const priv = this._need()
    const file = path.join(this.imageDir, path.basename(id) + '.bin')
    if (!fs.existsSync(file)) return null
    const buf = open(priv, JSON.parse(fs.readFileSync(file, 'utf8')), id + ':img', false)
    return { mime: buf.subarray(0, 40).toString().trim(), data: buf.subarray(40) }
  }

  // ------------------------------------------------------------------ 关联：记忆之间的连线
  /** 关联度 = 内容相似 + 共同的人和事（标签）+ 发生时间相近 + 同一个脑区。 */
  _assoc(a, sa, b, sb) {
    let sim = cosine(sa.vec, sb.vec)
    if (sa.dv && sb.dv && sa.dvm === sb.dvm) sim = 0.4 * sim + 0.6 * Math.max(0, (dot(this._dense(sa), this._dense(sb)) - 0.3) / 0.7)
    const ta = new Set(sa.tags || []), tb = sb.tags || []
    const shared = tb.filter(t => ta.has(t)).length
    const jac = shared ? shared / (ta.size + tb.length - shared) : 0
    const dt = Math.abs((a.event_time || a.created_at) - (b.event_time || b.created_at)) / DAY
    return 0.55 * sim + 0.3 * jac + 0.1 * Math.exp(-dt / 3) + (a.region === b.region ? 0.05 : 0)
  }

  /** 关联图：每段记忆最多连 4 条最强的线。需要钥匙（要看内容才知道谁和谁有关）。 */
  graph() {
    const priv = this._need(); this._load()
    if (this._graph) return this._graph
    const items = this.memories.map(m => ({ m, s: this._secret(m, priv) })).filter(x => x.s)
    const adj = new Map(items.map(x => [x.m.id, []]))
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const w = this._assoc(items[i].m, items[i].s, items[j].m, items[j].s)
      if (w >= LINK_MIN) { adj.get(items[i].m.id).push([items[j].m.id, w]); adj.get(items[j].m.id).push([items[i].m.id, w]) }
    }
    for (const list of adj.values()) { list.sort((a, b) => b[1] - a[1]); list.length = Math.min(list.length, 4) }
    const links = [], seen = new Set()
    for (const [a, list] of adj) for (const [b, w] of list) { const k = a < b ? a + b : b + a; if (!seen.has(k)) { seen.add(k); links.push([a, b, +w.toFixed(3)]) } }
    return (this._graph = { adj, links })
  }

  // ------------------------------------------------------------------ 回想（需要钥匙）
  _dense(s) { return s._dv || (s._dv = s.dv ? dequantize(s.dv) : new Float32Array(0)) }

  /** BM25 的语料统计（字、双字、英文单词），只在钥匙在的时候算，按文件变化缓存。 */
  _lexicon(priv) {
    if (this._bm25) return this._bm25
    const docs = new Map(), df = new Map(); let total = 0
    for (const m of this.memories) {
      const s = this._secret(m, priv); if (!s) continue
      const tf = new Map(); let len = 0
      for (const [t] of tokens([s.title, s.content, s.emotion, (s.tags || []).join(' ')].filter(Boolean).join(' '))) { tf.set(t, (tf.get(t) || 0) + 1); len++ }
      docs.set(m.id, { tf, len }); total += len
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
    }
    return (this._bm25 = { docs, df, N: docs.size, avgdl: total / Math.max(1, docs.size) })
  }

  /**
   * 更聪明的回想：三路信号融合——
   *   字词匹配（BM25，考虑词有多罕见）· 联想词（模型扩展的近义词、相关人事物）· 语义向量（配置了嵌入模型时）。
   * opts.expand：联想词；opts.qvec：问题的语义向量。都可以没有。
   */
  _rank(query, { region, limit = 6, includeArchived = false, expand = [], qvec = null } = {}) {
    const priv = this._need(); this._load()
    const t = now(), reg = region ? resolveRegion(region) : null
    const lex = this._lexicon(priv)
    const qtok = new Map()
    for (const [tk, w] of tokens(query || '')) qtok.set(tk, Math.max(qtok.get(tk) || 0, w))
    for (const term of expand) for (const [tk, w] of tokens(term)) if (!qtok.has(tk)) qtok.set(tk, w * 0.5)
    const qv = query ? embed([query, ...expand].join(' ')) : null
    const qd = qvec ? normalize(qvec) : null
    const cand = []
    let maxBm = 0
    for (const m of this.memories) {
      if (reg && m.region !== reg) continue
      const s = this._secret(m, priv); if (!s) continue
      let bm = 0
      const d = lex.docs.get(m.id)
      if (d && qtok.size) for (const [tk, w] of qtok) {
        const f = d.tf.get(tk); if (!f) continue
        const n = lex.df.get(tk) || 0, idf = Math.log(1 + (lex.N - n + 0.5) / (n + 0.5))
        bm += w * idf * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * d.len / lex.avgdl))
      }
      maxBm = Math.max(maxBm, bm)
      const cos = qv ? cosine(qv, s.vec) : 0
      const dense = qd && s.dv ? Math.max(0, dot(qd, this._dense(s))) : null
      cand.push({ m, s, bm, cos, dense })
    }
    const out = []
    for (const c of cand) {
      const bmN = maxBm ? c.bm / maxBm : 0
      // 相关度：有语义向量时以语义为主，否则以字词为主
      const sim = c.dense != null
        ? 0.5 * Math.max(0, (c.dense - 0.25) / 0.6) + 0.3 * bmN * Math.min(1, c.cos * 4) + 0.2 * c.cos
        : 0.55 * bmN * Math.min(1, c.cos * 4 + 0.2) + 0.45 * c.cos
      if (query) {
        if (c.bm === 0 && c.cos < 0.06 && !(c.dense > 0.45)) continue
        if (c.m.status === 'archived' && !includeArchived && sim < REVIVE_SIM) continue
      } else if (c.m.status === 'archived' && !includeArchived) continue
      const score = query ? 0.65 * sim + 0.15 * c.m.importance + 0.2 * this.strength(c.m, t) : 0.5 * c.m.importance + 0.5 * this.strength(c.m, t)
      out.push({ m: c.m, s: c.s, score, sim })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, Math.max(1, Math.min(50, Number(limit) || 6)))
  }

  /** 回想之前的准备（异步）：联想词 + 语义向量。没有配置模型时什么也不做。 */
  async prepareQuery(query) {
    const out = {}
    const { expandQuery } = await import('./digest.js')
    const [terms, vec] = await Promise.all([
      this.chat ? expandQuery(this.chat, query) : [],
      this.embedder ? this.embedder([String(query)]).then(r => r[0]).catch(() => null) : null,
    ])
    if (terms.length) out.expand = terms
    if (vec) out.qvec = vec
    return out
  }

  /** 给还没有语义向量的记忆补上（钥匙在、配置了嵌入模型时，后台慢慢做）。内容不变，只是重新封存。 */
  async backfillEmbeddings(batch = 32) {
    const priv = this._priv(); if (!priv || !this.embedder) return 0
    const todo = this.memories.filter(m => { const s = this._secret(m, priv); return s && s.dvm !== this.embedder.id }).slice(0, batch)
    if (!todo.length) return 0
    const vecs = await this.embedder(todo.map(m => { const s = this.secrets.get(m.id); return s.content + (s.tags?.length ? ' ' + s.tags.join(' ') : '') }))
    const pub = publicKeyOf(this.vault.publicKey)
    this._withLock(() => {
      todo.forEach((t, i) => {
        const m = this.memories.find(x => x.id === t.id); if (!m) return
        const { _dv, ...s } = this.secrets.get(m.id)
        s.dv = quantize(normalize(vecs[i])); s.dvm = this.embedder.id
        m.box = seal(pub, s, m.id); this.secrets.set(m.id, s)
      })
      this._save()
    })
    return todo.length
  }

  reveal(m, s = this.secrets.get(m.id), extra = {}) {
    const { box, ...meta } = m
    const r = { ...meta, strength: +this.strength(m).toFixed(4), forget_in_days: Math.round(this.forgetDays(m)),
      region_name: REGION_BY_KEY[m.region]?.name, type_name: MEMORY_TYPES[m.type], ...extra }
    if (s) { const { vec, dv, dvm, _dv, ...rest } = s; Object.assign(r, rest) }
    return r
  }

  /**
   * 联想式回想：先按线索想起最相关的几段，再顺着关联线把「一整套」相关的记忆一起想起来（最多两跳）。
   * 被想起的记忆都会记得更牢；已经遗忘的会复苏。
   */
  recall(query, opts = {}, agent = null) {
    const limit = Math.max(1, Math.min(20, Number(opts.limit) || 6))
    const direct = this._rank(query, { ...opts, limit })
    const { adj } = this.graph()
    const byId = new Map(this.memories.map(m => [m.id, m]))
    const taken = new Set(direct.map(h => h.m.id)), cap = limit * 3
    const clusters = direct.map(h => ({ hit: h, assoc: [] }))
    let frontier = clusters.map(c => ({ id: c.hit.m.id, c, depth: 0, w: 1 }))
    for (let depth = 1; depth <= 2 && frontier.length; depth++) {
      const next = []
      for (const f of frontier) for (const [nid, w] of adj.get(f.id) || []) {
        if (taken.size >= cap) break
        if (taken.has(nid) || w < LINK_MIN + 0.05 * (depth - 1)) continue
        taken.add(nid)
        const a = { id: nid, via: f.id, depth, w: +(w * f.w).toFixed(3) }
        f.c.assoc.push(a); next.push({ id: nid, c: f.c, depth, w: a.w })
      }
      frontier = next
    }
    const t = now(), revived = []
    this._withLock(() => {
      for (const id of taken) {
        const m = this.memories.find(x => x.id === id); if (!m) continue
        if (m.status === 'archived') revived.push(id)
        m.status = 'active'; m.last_access = t; m.access_count = (m.access_count || 0) + 1
        byId.set(id, m)
      }
      this._save()
    })
    const v = this.vault
    this._event('recall', [...taken], agent, { direct: direct.map(h => h.m.id), q: seal(publicKeyOf(v.publicKey), String(query || ''), 'q') })
    if (revived.length) this._event('revive', revived, agent)
    const mark = (m, extra) => this.reveal(m, this.secrets.get(m.id), { ...extra, revived: revived.includes(m.id) || undefined })
    return clusters.map(c => ({
      memory: mark(byId.get(c.hit.m.id), { score: +c.hit.score.toFixed(4), similarity: +c.hit.sim.toFixed(4) }),
      associated: c.assoc.map(a => mark(byId.get(a.id), { via: a.via, association: a.w })),
    }))
  }

  /** 只看不碰（超级管理员在星环里搜索用）。 */
  search(query, opts = {}) {
    opts = { ...opts }
    return this._rank(query, { includeArchived: true, limit: 12, ...opts }).map(h => this.reveal(h.m, h.s, { score: +h.score.toFixed(4), similarity: +h.sim.toFixed(4) }))
  }

  /** 代谢：强度低于阈值的记忆被遗忘（归档）——不再占用上下文，但随时可以按需召回。不需要钥匙。 */
  maintain(agent = null) {
    const t = now(), faded = []
    this._withLock(() => {
      for (const m of this.memories) if (m.status === 'active' && this.strength(m, t) < ARCHIVE_STRENGTH) { m.status = 'archived'; faded.push(m.id) }
      if (faded.length) this._save()
    })
    if (faded.length) this._event('archive', faded, agent || 'metabolism', { reason: 'decay' })
    return faded
  }

  /** 醒来：只带上「还记得」的、最重要和最近的几段，上下文不会被占满。 */
  overview(agent = null, top = 8) {
    this._load()
    const regions = REGIONS.filter(r => r.kind === 'memory').map(r => ({ key: r.key, name: r.name, desc: r.desc,
      remembered: this.memories.filter(m => m.region === r.key && m.status === 'active').length,
      forgotten: this.memories.filter(m => m.region === r.key && m.status === 'archived').length }))
    const res = { initialized: this.initialized, unlocked: this.unlocked, regions, types: MEMORY_TYPES }
    if (!this.initialized) { res.note = '还没有任何记忆。第一次写入时会在用户电脑桌面生成超级管理员钥匙。'; return res }
    if (!res.unlocked) { res.note = LOCKED().message; return res }
    const act = this.memories.filter(m => m.status === 'active')
    const brief = m => { const s = this._secret(m) || {}; return { id: m.id, region_name: REGION_BY_KEY[m.region].name, type_name: MEMORY_TYPES[m.type], title: s.title, content: s.content, importance: m.importance, emotion: s.emotion } }
    const important = [...act].sort((a, b) => b.importance * (0.5 + 0.5 * this.strength(b)) - a.importance * (0.5 + 0.5 * this.strength(a))).slice(0, top)
    res.most_important = important.map(brief)
    res.recent = [...act].sort((a, b) => b.created_at - a.created_at).slice(0, 5).map(brief)
    res.persona = this.personaText()
    this._event('wake', important.map(m => m.id), agent)
    return res
  }

  // ------------------------------------------------------------------ 性格
  persona() {
    const priv = this._need()
    try { const raw = JSON.parse(fs.readFileSync(this.files.persona, 'utf8')); return settle(open(priv, raw.box, 'persona')) } catch (e) {
      if (e.code === 'ENOENT') return freshPersona()
      throw e
    }
  }
  personaText() { try { return describe(this.persona()) } catch { return null } }
  shapePersona(changes, source = 'reflect', agent = null) {
    this._need()
    let applied = []
    this._withLock(() => {
      const p = this.persona(); applied = shape(p, changes, source)
      atomicWrite(this.files.persona, JSON.stringify({ v: 1, box: seal(publicKeyOf(this.vault.publicKey), p, 'persona') }))
    })
    if (applied.length) this._event('persona', [], agent, { traits: applied.map(a => [a.trait, a.delta]) })
    return applied
  }
  /** 超级管理员编辑人设卡。 */
  setPersonaProfile(fields) {
    this._need()
    let out
    this._withLock(() => {
      const p = this.persona(); out = setProfile(p, fields || {})
      atomicWrite(this.files.persona, JSON.stringify({ v: 1, box: seal(publicKeyOf(this.vault.publicKey), p, 'persona') }))
    })
    this._event('persona', [], 'admin', { profile: true })
    return out
  }
  setPersonaBaseline(values) {
    this._need()
    this._withLock(() => {
      const p = this.persona()
      for (const [k, v] of Object.entries(values || {})) if (p.traits[k]) { p.traits[k].baseline = Math.max(0, Math.min(1, Number(v))); p.traits[k].value = p.traits[k].baseline }
      atomicWrite(this.files.persona, JSON.stringify({ v: 1, box: seal(publicKeyOf(this.vault.publicKey), p, 'persona') }))
    })
    this._event('persona', [], 'admin')
  }

  // ------------------------------------------------------------------ 超级管理员（需要钥匙）
  adminUpdate(id, fields) {
    const priv = this._need(), pub = publicKeyOf(this.vault.publicKey)
    let out
    this._withLock(() => {
      const m = this.memories.find(x => x.id === id); if (!m) throw new BrainError('NOT_FOUND', '找不到这段记忆')
      const { _dv, ...s } = this._secret(m, priv)
      if (fields.content !== undefined && fields.content !== s.content) { delete s.dv; delete s.dvm }
      for (const k of ['title', 'content', 'emotion', 'image_prompt']) if (fields[k] !== undefined) s[k] = fields[k]
      if (fields.tags !== undefined) s.tags = Array.isArray(fields.tags) ? fields.tags : String(fields.tags).split(/[,，、\s]+/).filter(Boolean)
      if (fields.valence !== undefined) s.valence = Number(fields.valence)
      s.vec = embed([s.title, s.content, s.emotion, (s.tags || []).join(' ')].filter(Boolean).join(' '))
      if (fields.importance !== undefined) m.importance = Math.max(0, Math.min(1, Number(fields.importance)))
      if (fields.region) m.region = resolveRegion(fields.region)
      if (fields.type) m.type = resolveType(fields.type)
      if (fields.event_time !== undefined) m.event_time = parseTime(fields.event_time)
      if (fields.status === 'archived' || fields.status === 'active') { m.status = fields.status; if (m.status === 'active') m.last_access = now() }
      if (s.image_prompt && !m.has_image) { m.has_image = true; m.image_kind = 'dream' }
      m.box = seal(pub, s, id); m.updated_at = now()
      this.secrets.set(id, s); this._save()
      out = this.reveal(m, s)
    })
    this._event('update', [id], 'admin')
    return out
  }

  adminDelete(id) {
    this._need()
    this._withLock(() => {
      const i = this.memories.findIndex(x => x.id === id); if (i < 0) throw new BrainError('NOT_FOUND', '找不到这段记忆')
      this.memories.splice(i, 1); this.secrets.delete(id); this._save()
      fs.rmSync(path.join(this.imageDir, id + '.bin'), { force: true })
    })
    this._event('delete', [id], 'admin')
  }

  /**
   * 导出：必须有钥匙。导出的文件里内容仍然是加密的，而且只认这一把钥匙——钥匙和记忆文件一一对应。
   */
  exportBundle() {
    this._need(); this._load()
    const v = this.vault
    const images = {}
    for (const m of this.memories) if (m.image_kind === 'photo') { try { images[m.id] = JSON.parse(fs.readFileSync(path.join(this.imageDir, m.id + '.bin'), 'utf8')) } catch { } }
    let persona = null
    try { persona = JSON.parse(fs.readFileSync(this.files.persona, 'utf8')) } catch { }
    this._event('export', [], 'admin')
    return { format: 'forget-me-not', v: 2, exported_at: now(), publicKey: v.publicKey, fingerprint: v.fingerprint, memories: this.memories, persona, images }
  }

  /** 导入：只有同一把钥匙导出的文件才能导进来。keyPath 是那把钥匙现在的位置。 */
  importBundle(bundle, keyPath) {
    if (bundle?.format !== 'forget-me-not' || !bundle.publicKey) throw new BrainError('BAD_BUNDLE', '这不是勿忘我的记忆文件')
    if (fingerprint(bundle.publicKey) !== bundle.fingerprint) throw new BrainError('BAD_BUNDLE', '记忆文件的指纹不对')
    const file = path.resolve(expandHome(keyPath || this.vault?.key_path || ''))
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { }
    if (!loadPrivateKey(text, bundle.publicKey)) throw new BrainError('KEY_MISMATCH', '需要导出这份记忆时用的那把钥匙')
    const v = this.vault
    if (v && v.publicKey !== bundle.publicKey && this.memories.length) throw new BrainError('KEY_MISMATCH', '这里已经有另一把钥匙的记忆了，不能混在一起')
    let added = 0
    this._withLock(() => {
      if (!v || v.publicKey !== bundle.publicKey) atomicWrite(this.files.vault, JSON.stringify({ v: 2, publicKey: bundle.publicKey, fingerprint: bundle.fingerprint, key_path: file, created_at: now() }, null, 2))
      const have = new Set(this.memories.map(m => m.id))
      for (const m of bundle.memories || []) if (!have.has(m.id)) { this.memories.push(m); added++ }
      for (const [id, box] of Object.entries(bundle.images || {})) fs.writeFileSync(path.join(this.imageDir, path.basename(id) + '.bin'), JSON.stringify(box), { mode: 0o600 })
      if (bundle.persona && !fs.existsSync(this.files.persona)) atomicWrite(this.files.persona, JSON.stringify(bundle.persona))
      this._save()
    })
    this._key = { stamp: null, priv: null }
    this._event('import', [], 'admin', { added })
    return { added }
  }

  // ------------------------------------------------------------------ 给星环网页用
  events(after = 0, reveal = false) {
    let lines = []
    try { lines = fs.readFileSync(this.files.events, 'utf8').split('\n') } catch { return [] }
    const out = []
    const priv = reveal ? this._priv() : null
    for (const l of lines) {
      if (!l) continue
      let e; try { e = JSON.parse(l) } catch { continue }
      if (e.id <= after) continue
      if (e.q) { if (priv) { try { e.query = open(priv, e.q, 'q') } catch { } } delete e.q }
      out.push(e)
    }
    if (lines.length > 5000) { try { atomicWrite(this.files.events, lines.slice(-2000).join('\n') + '\n') } catch { } }
    return out.slice(-200)
  }

  lastEventId() { const e = this.events(0); return e.length ? e[e.length - 1].id : 0 }

  snapshot() {
    this._load()
    const priv = this._priv()
    const counts = {}
    for (const m of this.memories) counts[m.region] = (counts[m.region] || 0) + 1
    const memories = this.memories.map(m => priv ? this.reveal(m, this._secret(m, priv))
      : (({ box, ...meta }) => ({ ...meta, strength: +this.strength(m).toFixed(4), forget_in_days: Math.round(this.forgetDays(m)) }))(m))
    const evs = this.events(0)
    const recalls = evs.filter(e => e.kind === 'recall')
    const active = this.memories.filter(m => m.status === 'active').length
    let persona = null
    if (priv) { try { persona = publicView(this.persona(), true) } catch { } }
    return {
      regions: REGIONS.map(r => ({ ...r, count: counts[r.key] || 0 })),
      types: MEMORY_TYPES,
      memories,
      links: priv ? this.graph().links : [],
      persona,
      sealed: !priv,
      key: this.keyStatus(),
      stats: { total: this.memories.length, active, archived: this.memories.length - active,
        with_image: this.memories.filter(m => m.has_image).length, last_recall: recalls.length ? recalls[recalls.length - 1].ts : null },
      last_event: evs.length ? evs[evs.length - 1].id : 0,
    }
  }
}

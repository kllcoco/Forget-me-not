// 记忆大脑：封存写入、回想、遗忘（归档）、复苏。
//
// 磁盘上的文件（默认 ~/.forget-me-not/，dsh 里在 dsh 数据目录下）：
//   vault.json      公钥 + 被超级管理员密码锁住的私钥
//   memories.json   每段记忆：脑区、时间、重要性等「外形」是明文（用来画星环），内容全部加密
//   events.jsonl    大脑活动日志（写入 / 回想 / 淡去……），回想用的线索也加密
//   images/*.bin    加密后的配图
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { embed, cosine } from './embed.js'
import { createVault, openVault, publicKeyOf, rewrapVault, seal, open } from './vault.js'
import { MEMORY_TYPES, REGIONS, REGION_BY_KEY, resolveRegion, resolveType } from './regions.js'

const DAY = 86400
export const ARCHIVE_STRENGTH = 0.12   // 记忆强度低于它就会被淡忘（归档）
export const NEVER_FORGET = 0.85       // 重要性高于它的记忆永远不会被淡忘
export const REVIVE_SIM = 0.3          // 已淡忘的记忆，线索足够像时会被重新想起
const MAX_IMAGE = 20 * 1024 * 1024

export const defaultHome = () => process.env.FMN_HOME || path.join(os.homedir(), '.forget-me-not')
const now = () => Date.now() / 1000

export class BrainError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const ASLEEP = () => new BrainError('ASLEEP', '记忆大脑在沉睡：需要超级管理员在「记忆」面板输入密码唤醒后，才能回想。')
const NO_VAULT = () => new BrainError('NO_VAULT', '记忆大脑还没有设定超级管理员密码：请让用户先在「记忆」面板设定密码。')

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

export class Brain {
  constructor(home = defaultHome()) {
    this.home = home
    this.imageDir = path.join(home, 'images')
    fs.mkdirSync(this.imageDir, { recursive: true, mode: 0o700 })
    this.files = {
      vault: path.join(home, 'vault.json'),
      memories: path.join(home, 'memories.json'),
      events: path.join(home, 'events.jsonl'),
      lock: path.join(home, '.lock'),
    }
    this.privateKey = null      // 只在内存里，唤醒后才有
    this.secrets = new Map()    // id → 解开的内容（只在唤醒时）
    this.memories = []
    this._mtime = 0
    this._vault = null
    this._seq = 0
    this._load()
  }

  // ------------------------------------------------------------------ 存取
  get initialized() { return this._readVault() != null }
  get awake() { return this.privateKey != null }

  _readVault() {
    if (this._vault) return this._vault
    try { this._vault = JSON.parse(fs.readFileSync(this.files.vault, 'utf8')) } catch { this._vault = null }
    return this._vault
  }

  _load(force = false) {
    let st
    try { st = fs.statSync(this.files.memories) } catch { this.memories = []; return }
    if (!force && st.mtimeMs === this._mtime) return
    this._mtime = st.mtimeMs
    try { this.memories = JSON.parse(fs.readFileSync(this.files.memories, 'utf8')).memories || [] } catch { this.memories = [] }
    if (this.awake) for (const m of this.memories) if (!this.secrets.has(m.id)) this._openSecret(m)
    const ids = new Set(this.memories.map(m => m.id))
    for (const id of this.secrets.keys()) if (!ids.has(id)) this.secrets.delete(id)
  }

  _save() {
    atomicWrite(this.files.memories, JSON.stringify({ v: 1, memories: this.memories }))
    this._mtime = fs.statSync(this.files.memories).mtimeMs
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

  _openSecret(m) {
    try { const s = open(this.privateKey, m.box, m.id); s.vec = Object.fromEntries(Object.entries(s.vec || {}).map(([k, v]) => [k, v])); this.secrets.set(m.id, s); return s } catch { return null }
  }

  _event(kind, ids = [], agent = null, extra = {}) {
    const e = { id: Math.floor(Date.now()) * 1000 + (this._seq++ % 1000), ts: now(), kind, agent: agent || null, memory_ids: ids, ...extra }
    fs.appendFileSync(this.files.events, JSON.stringify(e) + '\n', { mode: 0o600 })
    return e
  }

  // ------------------------------------------------------------------ 超级管理员
  setup(password) {
    if (this.initialized) throw new BrainError('EXISTS', '超级管理员密码已经设定过了')
    const { record, privateKey } = createVault(password)
    atomicWrite(this.files.vault, JSON.stringify(record, null, 2))
    this._vault = record
    this.privateKey = privateKey
    this._event('setup')
  }

  unlock(password) {
    const v = this._readVault(); if (!v) throw NO_VAULT()
    const pk = openVault(v, password)
    const wasAwake = this.awake
    this.privateKey = pk
    this.secrets.clear(); this._load(true)
    for (const m of this.memories) this._openSecret(m)
    if (!wasAwake) this._event('awake')
  }

  /** 让大脑重新沉睡：丢掉内存里的私钥，AI 将无法回想，直到再次唤醒。 */
  sleep() { this.privateKey = null; this.secrets.clear(); this._event('sleep') }

  changePassword(oldPassword, newPassword) {
    const v = this._readVault(); if (!v) throw NO_VAULT()
    const pk = openVault(v, oldPassword)
    const rec = rewrapVault(v, pk, newPassword)
    atomicWrite(this.files.vault, JSON.stringify(rec, null, 2)); this._vault = rec
  }

  verifyPassword(password) { openVault(this._readVault(), password); return true }

  // ------------------------------------------------------------------ 遗忘曲线
  strength(m, t = now()) {
    const imp = Number(m.importance ?? 0.5)
    let stability = m.region === 'working' ? 0.5 + 2 * imp : 2 + 90 * imp * imp
    stability *= 1 + 0.5 * Math.min(m.access_count || 0, 10)
    const days = Math.max(0, (t - (m.last_access || t)) / DAY)
    return Math.exp(-days / stability)
  }

  // ------------------------------------------------------------------ 写入（谁都可以，不需要密码）
  async remember(input, agent = null) {
    const v = this._readVault(); if (!v) throw NO_VAULT()
    const content = String(input.content || '').trim()
    if (!content) throw new BrainError('EMPTY', 'content 不能为空：请先把要记住的内容用自己的话总结成一两句。')
    let tags = input.tags || []
    if (typeof tags === 'string') tags = tags.split(/[,，、\s]+/).filter(Boolean)
    const id = 'm_' + crypto.randomBytes(5).toString('hex')
    const created = parseTime(input.created_at) || now()
    const pub = publicKeyOf(v)
    let imageKind = null
    if (input.image) {
      const img = await this._fetchImage(input.image).catch(() => null)
      if (img) { fs.writeFileSync(path.join(this.imageDir, id + '.bin'), JSON.stringify(seal(pub, Buffer.concat([Buffer.from(img.mime.padEnd(40)), img.data]), id + ':img')), { mode: 0o600 }); imageKind = 'photo' }
    }
    if (!imageKind && input.image_prompt) imageKind = 'dream'
    const secret = {
      title: input.title || null, content, emotion: input.emotion || null,
      valence: Math.max(-1, Math.min(1, Number(input.valence) || 0)), tags: tags.map(String),
      image_prompt: input.image_prompt || null,
    }
    secret.vec = embed([secret.title, content, secret.emotion, secret.tags.join(' ')].filter(Boolean).join(' '))
    const m = {
      id, region: resolveRegion(input.region), type: resolveType(input.type),
      importance: Math.max(0, Math.min(1, Number(input.importance ?? 0.5))),
      created_at: created, event_time: parseTime(input.event_time), last_access: parseTime(input.last_access) || created,
      access_count: Number(input.access_count) || 0, status: input.status === 'archived' ? 'archived' : 'active',
      has_image: Boolean(imageKind), image_kind: imageKind, source: agent || null,
      box: seal(pub, secret, id),
    }
    this._withLock(() => { this.memories.push(m); this._save() })
    if (this.awake) this.secrets.set(id, secret)
    if (input._log !== false) { this._event('remember', [id], agent, { region: m.region }); this.maintain() }
    return { id, region: m.region, region_name: REGION_BY_KEY[m.region].name, type: m.type, importance: m.importance, sealed: true, has_image: m.has_image }
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
    const p = src.replace(/^~/, os.homedir())
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const ext = path.extname(p).toLowerCase().slice(1)
      return { mime: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png', data: fs.readFileSync(p) }
    }
    if (/^[A-Za-z0-9+/=\s]{200,}$/.test(src)) return { mime: 'image/png', data: Buffer.from(src, 'base64') }
    throw new Error('unsupported image')
  }

  /** 读取一张配图（需要唤醒）。 */
  image(id) {
    if (!this.awake) throw ASLEEP()
    const file = path.join(this.imageDir, path.basename(id) + '.bin')
    if (!fs.existsSync(file)) return null
    const buf = open(this.privateKey, JSON.parse(fs.readFileSync(file, 'utf8')), id + ':img', false)
    return { mime: buf.subarray(0, 40).toString().trim(), data: buf.subarray(40) }
  }

  // ------------------------------------------------------------------ 回想（需要唤醒）
  _rank(query, { region, limit = 6, includeArchived = false } = {}) {
    if (!this.awake) throw ASLEEP()
    this._load()
    const qv = query ? embed(query) : null
    const t = now(), out = []
    const reg = region ? resolveRegion(region) : null
    for (const m of this.memories) {
      if (reg && m.region !== reg) continue
      const s = this.secrets.get(m.id) || this._openSecret(m); if (!s) continue
      const sim = qv ? cosine(qv, s.vec) : 0
      if (m.status === 'archived' && !includeArchived && sim < REVIVE_SIM) continue
      if (qv && sim < 0.06) continue
      const score = qv ? 0.65 * sim + 0.15 * m.importance + 0.2 * this.strength(m, t) : 0.5 * m.importance + 0.5 * this.strength(m, t)
      out.push({ m, s, score, sim })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, Math.max(1, Math.min(50, Number(limit) || 6)))
  }

  reveal(m, s = this.secrets.get(m.id), extra = {}) {
    const { box, ...meta } = m
    const r = { ...meta, strength: +this.strength(m).toFixed(4), region_name: REGION_BY_KEY[m.region]?.name, type_name: MEMORY_TYPES[m.type], ...extra }
    if (s) { const { vec, ...rest } = s; Object.assign(r, rest) }
    return r
  }

  /** 真正的「想起来」：被想起的记忆更牢；已淡忘的记忆遇到强线索会复苏。 */
  recall(query, opts = {}, agent = null) {
    const hits = this._rank(query, opts)
    const t = now(), revived = []
    this._withLock(() => {
      for (const h of hits) {
        const m = this.memories.find(x => x.id === h.m.id); if (!m) continue
        if (m.status === 'archived') revived.push(m.id)
        m.status = 'active'; m.last_access = t; m.access_count = (m.access_count || 0) + 1
        h.m = m
      }
      this._save()
    })
    this._event('recall', hits.map(h => h.m.id), agent, { q: seal(publicKeyOf(this._readVault()), String(query || ''), 'q') })
    if (revived.length) this._event('revive', revived, agent)
    return hits.map(h => this.reveal(h.m, h.s, { score: +h.score.toFixed(4), similarity: +h.sim.toFixed(4), revived: revived.includes(h.m.id) || undefined }))
  }

  /** 只看不碰（超级管理员在星环里搜索用）。 */
  search(query, opts = {}) {
    return this._rank(query, { includeArchived: true, limit: 12, ...opts }).map(h => this.reveal(h.m, h.s, { score: +h.score.toFixed(4) }))
  }

  /** 代谢：把强度太低、又不够重要的记忆归档（淡忘）。 */
  maintain(agent = null) {
    const t = now(), faded = []
    this._withLock(() => {
      for (const m of this.memories) if (m.status === 'active' && m.importance < NEVER_FORGET && this.strength(m, t) < ARCHIVE_STRENGTH) { m.status = 'archived'; faded.push(m.id) }
      if (faded.length) this._save()
    })
    if (faded.length) this._event('archive', faded, agent || 'metabolism', { reason: 'decay' })
    return faded
  }

  /** 醒来时看一眼自己记得什么。 */
  overview(agent = null, top = 8) {
    this._load()
    const regions = REGIONS.filter(r => r.kind === 'memory').map(r => ({ key: r.key, name: r.name, desc: r.desc,
      count: this.memories.filter(m => m.region === r.key && m.status === 'active').length }))
    const res = { awake: this.awake, regions, types: MEMORY_TYPES }
    if (!this.awake) { res.note = ASLEEP().message; return res }
    const act = this.memories.filter(m => m.status === 'active')
    const brief = m => { const s = this.secrets.get(m.id) || {}; return { id: m.id, region_name: REGION_BY_KEY[m.region].name, type_name: MEMORY_TYPES[m.type], title: s.title, content: s.content, importance: m.importance, emotion: s.emotion } }
    const important = [...act].sort((a, b) => b.importance * (0.5 + 0.5 * this.strength(b)) - a.importance * (0.5 + 0.5 * this.strength(a))).slice(0, top)
    res.most_important = important.map(brief)
    res.recent = [...act].sort((a, b) => b.created_at - a.created_at).slice(0, 5).map(brief)
    this._event('wake', important.map(m => m.id), agent)
    return res
  }

  // ------------------------------------------------------------------ 超级管理员修改（由 HTTP 层校验密码令牌）
  adminUpdate(id, fields) {
    if (!this.awake) throw ASLEEP()
    const pub = publicKeyOf(this._readVault())
    let out
    this._withLock(() => {
      const m = this.memories.find(x => x.id === id); if (!m) throw new BrainError('NOT_FOUND', '找不到这段记忆')
      const s = { ...(this.secrets.get(id) || this._openSecret(m)) }
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
    this._withLock(() => {
      const i = this.memories.findIndex(x => x.id === id); if (i < 0) throw new BrainError('NOT_FOUND', '找不到这段记忆')
      this.memories.splice(i, 1); this.secrets.delete(id); this._save()
      fs.rmSync(path.join(this.imageDir, id + '.bin'), { force: true })
    })
    this._event('delete', [id], 'admin')
  }

  // ------------------------------------------------------------------ 给星环网页用
  events(after = 0, reveal = false) {
    let lines = []
    try { lines = fs.readFileSync(this.files.events, 'utf8').split('\n') } catch { return [] }
    const out = []
    for (const l of lines) {
      if (!l) continue
      let e; try { e = JSON.parse(l) } catch { continue }
      if (e.id <= after) continue
      if (e.q) { if (reveal && this.awake) { try { e.query = open(this.privateKey, e.q, 'q') } catch { } } delete e.q }
      out.push(e)
    }
    if (lines.length > 5000) this._trimEvents(lines)
    return out.slice(-200)
  }

  _trimEvents(lines) { try { atomicWrite(this.files.events, lines.slice(-2000).join('\n') + '\n') } catch { } }

  lastEventId() { const e = this.events(0); return e.length ? e[e.length - 1].id : 0 }

  snapshot({ reveal = false } = {}) {
    this._load()
    const show = reveal && this.awake
    const counts = {}
    for (const m of this.memories) counts[m.region] = (counts[m.region] || 0) + 1
    const memories = this.memories.map(m => show ? this.reveal(m) : (({ box, ...meta }) => ({ ...meta, strength: +this.strength(m).toFixed(4) }))(m))
    const recalls = this.events(0).filter(e => e.kind === 'recall')
    const active = this.memories.filter(m => m.status === 'active').length
    return {
      regions: REGIONS.map(r => ({ ...r, count: counts[r.key] || 0 })),
      types: MEMORY_TYPES,
      memories,
      sealed: !show,
      brain: { initialized: this.initialized, awake: this.awake },
      stats: { total: this.memories.length, active, archived: this.memories.length - active,
        with_image: this.memories.filter(m => m.has_image).length, last_recall: recalls.length ? recalls[recalls.length - 1].ts : null },
      last_event: this.lastEventId(),
    }
  }
}

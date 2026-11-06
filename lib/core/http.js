// 星环网页 + REST + 远程 MCP 的请求处理。独立服务和 dsh 插件共用这一份。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BrainError } from './brain.js'
import { PROTOCOL, TOOL_BY_NAME, callTool, openapi, toolsAs } from './tools.js'
import { handlePayload } from './mcp.js'

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' }
const TOKEN_TTL = 12 * 3600 * 1000

/** 超级管理员的登录令牌（只存在内存里）。 */
class AdminSessions {
  constructor() { this.tokens = new Map(); this.fails = 0; this.blockedUntil = 0 }
  issue() { const t = crypto.randomBytes(24).toString('base64url'); this.tokens.set(t, Date.now() + TOKEN_TTL); return t }
  valid(t) { const exp = t && this.tokens.get(t); if (!exp) return false; if (exp < Date.now()) { this.tokens.delete(t); return false } return true }
  revoke(t) { this.tokens.delete(t) }
  revokeAll() { this.tokens.clear() }
  guard() { if (Date.now() < this.blockedUntil) throw new BrainError('LOCKED_OUT', `密码错误次数太多，请 ${Math.ceil((this.blockedUntil - Date.now()) / 1000)} 秒后再试`) }
  failed() { this.fails++; if (this.fails >= 5) { this.blockedUntil = Date.now() + 30000 * 2 ** Math.min(this.fails - 5, 6) } }
  ok() { this.fails = 0 }
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', c => { n += c.length; if (n > limit) { reject(new BrainError('TOO_LARGE', '请求太大')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {object} o
 * @param {import('./brain.js').Brain} o.brain
 * @param {string} [o.base]  挂载路径，例如 dsh 里的 '/forget-me-not'；独立运行时为 ''
 * @param {object} [o.connect] 「接入」弹窗里展示的信息
 * @param {boolean} [o.exposeTools] 是否开放 /api/tools 和 /mcp 给外部 AI
 * @returns {(req, res) => Promise<boolean>} 处理了返回 true
 */
export function createHandler({ brain, base = '', connect = {}, exposeTools = true }) {
  const admin = new AdminSessions()
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
    res.end(buf)
  }
  const fail = (res, e) => {
    const map = { BAD_PASSWORD: 401, UNAUTHORIZED: 401, LOCKED_OUT: 429, ASLEEP: 423, NO_VAULT: 409, EXISTS: 409, NOT_FOUND: 404, EMPTY: 400, TOO_LARGE: 413, BUSY: 503 }
    send(res, map[e.code] || (e instanceof SyntaxError ? 400 : 500), { error: e.message, code: e.code })
  }
  const tokenOf = (req, url) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || ''
  const isAdmin = (req, url) => brain.awake && admin.valid(tokenOf(req, url))
  const needAdmin = (req, url) => { if (!isAdmin(req, url)) throw new BrainError('UNAUTHORIZED', '需要超级管理员密码') }
  const staticFile = (res, rel) => {
    const file = path.resolve(WEB_DIR, rel)
    if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' })
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' })
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local')
    if (base && !(url.pathname === base || url.pathname.startsWith(base + '/'))) return false
    let p = url.pathname.slice(base.length) || '/'
    if (base && url.pathname === base) { res.writeHead(301, { location: base + '/' }); res.end(); return true }
    const method = req.method
    try {
      if (method === 'GET' || method === 'HEAD') {
        if (p === '/' || p === '/index.html') { staticFile(res, 'index.html'); return true }
        if (p.startsWith('/static/')) { staticFile(res, decodeURIComponent(p.slice(8))); return true }
        if (p === '/api/brain') { const reveal = isAdmin(req, url); send(res, 200, { ...brain.snapshot({ reveal }), admin: { initialized: brain.initialized, awake: brain.awake, unlocked: reveal } }); return true }
        if (p === '/api/events') {
          const after = Number(url.searchParams.get('after') || 0), deadline = Date.now() + Math.min(25, Number(url.searchParams.get('wait') || 0)) * 1000
          let closed = false; req.on('close', () => { closed = true })
          for (;;) {
            const evs = brain.events(after, isAdmin(req, url))
            if (evs.length || Date.now() >= deadline || closed) { if (!closed) send(res, 200, { events: evs }); return true }
            await new Promise(r => setTimeout(r, 600))
          }
        }
        if (p === '/api/search') { needAdmin(req, url); send(res, 200, { memories: brain.search(url.searchParams.get('q') || '') }); return true }
        if (p.startsWith('/api/media/')) {
          needAdmin(req, url)
          const img = brain.image(p.slice(11)); if (!img) return send(res, 404, { error: 'not found' }), true
          send(res, 200, img.data, img.mime, { 'cache-control': 'private, max-age=600' }); return true
        }
        if (p === '/api/admin/status') { send(res, 200, { initialized: brain.initialized, awake: brain.awake, unlocked: isAdmin(req, url) }); return true }
        if (p === '/api/connect') {
          const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`
          send(res, 200, { mcp_http: exposeTools ? `${origin}${base}/mcp` : null, openapi: exposeTools ? `${origin}${base}/openapi.json` : null,
            tools: `${origin}${base}/api/tools?format=openai`, protocol: `${origin}${base}/api/protocol`, ...connect }); return true
        }
        if (p === '/api/tools') { send(res, 200, toolsAs(url.searchParams.get('format') || 'openai')); return true }
        if (p === '/api/protocol') { send(res, 200, PROTOCOL, 'text/plain; charset=utf-8'); return true }
        if (p === '/openapi.json') { send(res, 200, openapi(`${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}${base}`)); return true }
        if (p === '/mcp') { send(res, 405, { error: 'use POST' }, undefined, { allow: 'POST' }); return true }
        send(res, 404, { error: 'not found' }); return true
      }
      if (method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return true }
      const raw = await readBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const agent = req.headers['x-agent'] || null

      if (p === '/mcp' && exposeTools) {
        const out = await handlePayload(brain, body, { agent })
        if (!out) { res.writeHead(202); res.end() } else send(res, 200, out)
        return true
      }
      if (p.startsWith('/api/tools/') && exposeTools) {
        const name = p.slice(11)
        if (!TOOL_BY_NAME[name]) return send(res, 404, { error: `unknown tool ${name}` }), true
        send(res, 200, await callTool(brain, name, body, agent)); return true
      }
      if (p === '/api/admin/setup') { brain.setup(body.password); admin.ok(); send(res, 200, { token: admin.issue() }); return true }
      if (p === '/api/admin/unlock') {
        admin.guard()
        try { brain.unlock(body.password) } catch (e) { if (e.code === 'BAD_PASSWORD') admin.failed(); throw e }
        admin.ok(); send(res, 200, { token: admin.issue() }); return true
      }
      if (p === '/api/admin/lock') { admin.revoke(tokenOf(req, url)); send(res, 200, { ok: true }); return true }
      if (p === '/api/admin/sleep') { needAdmin(req, url); brain.sleep(); admin.revokeAll(); send(res, 200, { ok: true }); return true }
      if (p === '/api/admin/password') {
        needAdmin(req, url); admin.guard()
        try { brain.changePassword(body.old_password, body.new_password) } catch (e) { if (e.code === 'BAD_PASSWORD') admin.failed(); throw e }
        send(res, 200, { ok: true }); return true
      }
      let m
      if ((m = p.match(/^\/api\/admin\/memories\/([\w-]+)\/delete$/))) { needAdmin(req, url); brain.adminDelete(m[1]); send(res, 200, { ok: true }); return true }
      if ((m = p.match(/^\/api\/admin\/memories\/([\w-]+)$/))) { needAdmin(req, url); send(res, 200, brain.adminUpdate(m[1], body)); return true }
      send(res, 404, { error: 'not found' }); return true
    } catch (e) {
      if (!e.code && !(e instanceof SyntaxError)) console.error('[forget-me-not]', e)
      if (!res.headersSent) fail(res, e)
      return true
    }
  }
}

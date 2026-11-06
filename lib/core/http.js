// 星环网页 + REST + 远程 MCP 的请求处理。独立服务和 dsh 插件共用这一份。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BrainError } from './brain.js'
import { PROTOCOL, TOOL_BY_NAME, callTool, openapi, toolsAs } from './tools.js'
import { handlePayload } from './mcp.js'

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web')
const AUDIO = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.webm': 'audio/webm' }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' }

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
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
    res.end(buf)
  }
  const fail = (res, e) => {
    const map = { LOCKED: 423, KEY_MISSING: 404, KEY_MISMATCH: 403, BAD_BUNDLE: 400, NO_VAULT: 409, NOT_FOUND: 404, EMPTY: 400, TOO_LARGE: 413, BUSY: 503 }
    send(res, map[e.code] || (e instanceof SyntaxError ? 400 : 500), { error: e.message, code: e.code })
  }
  // 超级管理员 = 私钥此刻就在登记的位置。每个请求都重新检查一次。
  const staticFile = (res, rel) => {
    const file = path.resolve(WEB_DIR, rel)
    if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' })
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' })
  }

  // 背景音乐：放在 数据目录/music 里的歌，进入记忆后循环播放（或 FMN_MUSIC_DIR 指定）
  const musicDir = process.env.FMN_MUSIC_DIR || path.join(brain.home, 'music')
  fs.mkdirSync(musicDir, { recursive: true })
  const tracks = () => fs.readdirSync(musicDir).filter(f => AUDIO[path.extname(f).toLowerCase()]).sort((a, b) => a.localeCompare(b, 'zh'))
  const serveAudio = (req, res, name) => {
    const file = path.join(musicDir, path.basename(name))
    if (!tracks().includes(path.basename(name))) return send(res, 404, { error: 'not found' })
    const size = fs.statSync(file).size, type = AUDIO[path.extname(file).toLowerCase()]
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
    if (m) {
      const start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' })
      return fs.createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' })
    fs.createReadStream(file).pipe(res)
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
        if (p === '/api/brain') { send(res, 200, brain.snapshot()); return true }
        if (p === '/api/events') {
          const after = Number(url.searchParams.get('after') || 0), deadline = Date.now() + Math.min(25, Number(url.searchParams.get('wait') || 0)) * 1000
          let closed = false; req.on('close', () => { closed = true })
          for (;;) {
            const evs = brain.events(after, true)
            if (evs.length || Date.now() >= deadline || closed) { if (!closed) send(res, 200, { events: evs }); return true }
            await new Promise(r => setTimeout(r, 600))
          }
        }
        if (p === '/api/search') { send(res, 200, { memories: brain.search(url.searchParams.get('q') || '') }); return true }
        if (p.startsWith('/api/media/')) {
          const img = brain.image(p.slice(11)); if (!img) return send(res, 404, { error: 'not found' }), true
          send(res, 200, img.data, img.mime, { 'cache-control': 'private, max-age=600' }); return true
        }
        if (p === '/api/key') { send(res, 200, brain.keyStatus()); return true }
        if (p === '/api/music') { send(res, 200, { dir: musicDir, tracks: tracks().map(n => ({ name: n.replace(/\.[^.]+$/, ''), file: n })) }); return true }
        if (p.startsWith('/api/music/')) { serveAudio(req, res, decodeURIComponent(p.slice(11))); return true }
        if (p === '/api/export') {
          const bundle = brain.exportBundle()
          const name = `勿忘我-记忆-${bundle.fingerprint.slice(0, 9)}-${new Date().toISOString().slice(0, 10)}.fmn`
          send(res, 200, JSON.stringify(bundle), 'application/octet-stream', { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` })
          return true
        }
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
      if (p === '/api/music') {
        // 把歌拖进页面：原样存进音乐文件夹
        const name = path.basename(String(url.searchParams.get('name') || ''))
        if (!AUDIO[path.extname(name).toLowerCase()]) return send(res, 400, { error: '只支持 mp3 / m4a / aac / ogg / opus / flac / wav / webm' }), true
        const chunks = []; let n = 0
        for await (const c of req) { n += c.length; if (n > 80 * 1024 * 1024) return send(res, 413, { error: '文件太大' }), true; chunks.push(c) }
        fs.writeFileSync(path.join(musicDir, name), Buffer.concat(chunks))
        send(res, 200, { ok: true, file: name }); return true
      }
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
      if (p === '/api/key') { send(res, 200, brain.setKeyPath(body.path)); return true }
      if (p === '/api/persona') {
        if (body.baseline) brain.setPersonaBaseline(body.baseline)
        send(res, 200, { profile: body.profile ? brain.setPersonaProfile(body.profile) : brain.persona().profile }); return true
      }
      if (p === '/api/digest') {
        if (!brain.chat) return send(res, 501, { error: '没有配置用来总结的模型：设置 FMN_LLM_BASE_URL / FMN_LLM_API_KEY / FMN_LLM_MODEL，或 DEEPSEEK_API_KEY' }), true
        const { digest } = await import('./digest.js')
        send(res, 200, await digest(brain, brain.chat, body.transcript || body.messages || '', { agent: agent || 'digest' })); return true
      }
      if (p === '/api/import') { send(res, 200, brain.importBundle(body.bundle, body.key_path)); return true }
      let m
      if ((m = p.match(/^\/api\/admin\/memories\/([\w-]+)\/delete$/))) { brain.adminDelete(m[1]); send(res, 200, { ok: true }); return true }
      if ((m = p.match(/^\/api\/admin\/memories\/([\w-]+)$/))) { send(res, 200, brain.adminUpdate(m[1], body)); return true }
      send(res, 404, { error: 'not found' }); return true
    } catch (e) {
      if (!e.code && !(e instanceof SyntaxError)) console.error('[forget-me-not]', e)
      if (!res.headersSent) fail(res, e)
      return true
    }
  }
}

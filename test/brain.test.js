import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Brain } from '../lib/core/brain.js'
import { callTool } from '../lib/core/tools.js'
import { createHandler } from '../lib/core/http.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fmn-'))
const PW = 'correct horse battery'

test('没有设定密码时不能写入', async () => {
  const b = new Brain(tmp())
  const r = await callTool(b, 'memory_remember', { content: 'x', region: 'life', importance: 0.5 })
  assert.equal(r.ok, false); assert.equal(r.error, 'NO_VAULT')
})

test('写入的内容在磁盘上是加密的；沉睡时 AI 能写不能回想', async () => {
  const home = tmp(); let b = new Brain(home); b.setup(PW)
  await b.remember({ content: '阿遥喜欢重庆火锅，不要香菜', region: 'life', importance: 0.6 })
  const disk = fs.readFileSync(path.join(home, 'memories.json'), 'utf8')
  assert.ok(!disk.includes('火锅') && !disk.includes('香菜'), '明文不应该出现在磁盘上')
  assert.ok(!fs.readFileSync(path.join(home, 'vault.json'), 'utf8').includes('PRIVATE'))

  b = new Brain(home) // 重启：私钥不在内存里
  assert.equal(b.awake, false)
  const w = await callTool(b, 'memory_remember', { content: '新的一条', region: 'working', importance: 0.2 })
  assert.equal(w.ok, true)
  const r = await callTool(b, 'memory_recall', { query: '火锅' })
  assert.equal(r.error, 'ASLEEP')
  assert.throws(() => b.unlock('wrong password'), /密码不对/)
  b.unlock(PW)
  const r2 = await callTool(b, 'memory_recall', { query: '火锅' })
  assert.equal(r2.count >= 1, true); assert.match(r2.memories[0].content, /火锅/)
})

test('AI 没有修改和删除的工具', async () => {
  const b = new Brain(tmp()); b.setup(PW)
  await assert.rejects(() => callTool(b, 'memory_update', { id: 'x' }), /未知工具/)
  await assert.rejects(() => callTool(b, 'memory_forget', { id: 'x' }), /未知工具/)
})

test('不重要的旧记忆会淡忘，强线索能让它复苏', async () => {
  const b = new Brain(tmp()); b.setup(PW)
  const old = Date.now() / 1000 - 200 * 86400
  const m = await b.remember({ content: '阿遥在旧书店买了一本绿色封面的诗集', region: 'life', importance: 0.2, created_at: old, last_access: old, _log: false })
  const keep = await b.remember({ content: '阿遥的生日是五月二十日', region: 'longterm', importance: 0.95, created_at: old, last_access: old, _log: false })
  const faded = b.maintain()
  assert.ok(faded.includes(m.id)); assert.ok(!faded.includes(keep.id))
  const hits = b.recall('旧书店 诗集')
  assert.equal(hits[0].id, m.id); assert.equal(hits[0].revived, true)
  assert.equal(b.memories.find(x => x.id === m.id).status, 'active')
})

test('HTTP：没有超级管理员令牌看不到内容，也不能修改', async () => {
  const b = new Brain(tmp()); b.setup(PW)
  const { id } = await b.remember({ content: '秘密的记忆', region: 'limbic', importance: 0.8, image_prompt: '海边日落' })
  const handle = createHandler({ brain: b })
  const srv = http.createServer((q, s) => handle(q, s)); await new Promise(r => srv.listen(0, r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const j = async (p, o = {}) => { const r = await fetch(base + p, o); return { status: r.status, body: await r.json() } }
  try {
    const snap = await j('/api/brain')
    assert.equal(snap.body.sealed, true)
    assert.ok(!JSON.stringify(snap.body).includes('秘密'))
    assert.equal((await j(`/api/admin/memories/${id}`, { method: 'POST', body: '{"content":"改掉"}' })).status, 401)
    assert.equal((await j('/api/search?q=秘密')).status, 401)
    assert.equal((await j('/api/admin/unlock', { method: 'POST', body: '{"password":"nope nope"}' })).status, 401)
    const { body: { token } } = await j('/api/admin/unlock', { method: 'POST', body: JSON.stringify({ password: PW }) })
    const auth = { headers: { authorization: 'Bearer ' + token } }
    const open = await j('/api/brain', auth)
    assert.equal(open.body.sealed, false); assert.equal(open.body.memories[0].content, '秘密的记忆')
    const upd = await j(`/api/admin/memories/${id}`, { method: 'POST', body: '{"content":"改过的记忆"}', ...auth })
    assert.equal(upd.body.content, '改过的记忆')
    await j('/api/admin/lock', { method: 'POST', body: '{}', ...auth })
    assert.equal((await j('/api/brain', auth)).body.sealed, true)
  } finally { srv.close() }
})

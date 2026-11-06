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
function fresh() {
  const desk = tmp(); process.env.FMN_KEY_DIR = desk
  return { brain: new Brain(tmp()), desk }
}

test('第一次写入：在桌面生成唯一的钥匙，并让模型告诉用户', async () => {
  const { brain, desk } = fresh()
  assert.equal(brain.initialized, false)
  const r = await callTool(brain, 'memory_remember', { content: '阿遥喜欢重庆火锅，不要香菜', region: 'life', importance: 0.6 })
  assert.equal(r.ok, true)
  assert.match(r.tell_user_now, /唯一的超级管理员钥匙/)
  const keyFile = r.admin_key.key_path
  assert.equal(path.dirname(keyFile), desk)
  assert.match(fs.readFileSync(keyFile, 'utf8'), /BEGIN PRIVATE KEY/)
  // 数据目录里没有私钥，也没有明文
  for (const f of fs.readdirSync(brain.home)) {
    const p = path.join(brain.home, f); if (!fs.statSync(p).isFile()) continue
    const t = fs.readFileSync(p, 'utf8')
    assert.ok(!t.includes('PRIVATE KEY') && !t.includes('火锅') && !t.includes('香菜'), f)
  }
  // 一模一样的内容不会存第二份
  const dup = await callTool(brain, 'memory_remember', { content: '阿遥喜欢重庆火锅，不要香菜', region: 'life', importance: 0.6 })
  assert.equal(dup.memory.duplicate, true)
  // 第二次写入不会再生成钥匙
  const r2 = await callTool(brain, 'memory_remember', { content: '第二条', region: 'working', importance: 0.2 })
  assert.equal(r2.admin_key, undefined)
})

test('钥匙在：自动解锁；钥匙不在：谁都打不开，但还能写入；填新路径后恢复', async () => {
  const { brain } = fresh()
  const { admin_key } = await callTool(brain, 'memory_remember', { content: '阿遥的生日是五月二十日', region: 'longterm', importance: 0.9 })
  assert.equal((await callTool(brain, 'memory_recall', { query: '生日' })).count >= 1, true)

  const moved = path.join(tmp(), 'usb.key')
  fs.renameSync(admin_key.key_path, moved)
  assert.equal(brain.unlocked, false)
  assert.equal((await callTool(brain, 'memory_recall', { query: '生日' })).error, 'LOCKED')
  assert.equal((await callTool(brain, 'memory_remember', { content: '锁着也能写', region: 'life', importance: 0.3 })).ok, true)
  assert.equal(brain.snapshot().sealed, true)
  assert.ok(!JSON.stringify(brain.snapshot()).includes('生日'))

  // 另一把钥匙不行
  const other = fresh(); await other.brain.remember({ content: 'x', region: 'life', importance: 0.1 })
  assert.throws(() => brain.setKeyPath(other.brain.keyStatus().key_path), /不是这份记忆的钥匙/)
  brain.setKeyPath(moved)
  assert.equal(brain.unlocked, true)
  const hits = brain.recall('生日 五月')
  assert.match(hits[0].memory.content, /五月二十日/)
})

test('AI 没有修改和删除的工具', async () => {
  const { brain } = fresh()
  await assert.rejects(() => callTool(brain, 'memory_update', { id: 'x' }), /未知工具/)
  await assert.rejects(() => callTool(brain, 'memory_forget', { id: 'x' }), /未知工具/)
})

test('艾宾浩斯遗忘：6~90 天；遗忘后可按需召回', async () => {
  const { brain } = fresh()
  const day = 86400, t0 = Date.now() / 1000
  assert.equal(brain.forgetDays({ importance: 0 }), 6)
  assert.equal(brain.forgetDays({ importance: 1 }), 90)
  const low = await brain.remember({ content: '阿遥在旧书店买了一本绿色封面的诗集', region: 'life', importance: 0.1, created_at: t0 - 20 * day, _log: false })
  const high = await brain.remember({ content: '阿遥的妈妈做了手术', region: 'longterm', importance: 0.9, created_at: t0 - 20 * day, _log: false })
  const faded = brain.maintain()
  assert.ok(faded.includes(low.id), '20 天后不重要的记忆应当被遗忘')
  assert.ok(!faded.includes(high.id), '重要的记忆 20 天后还记得')
  const c = brain.recall('旧书店 诗集')
  assert.equal(c[0].memory.id, low.id); assert.equal(c[0].memory.revived, true)
  assert.equal(brain.memories.find(m => m.id === low.id).status, 'active')
})

test('联想式召回：一次想起一整串关联记忆', async () => {
  const { brain } = fresh()
  await brain.remember({ content: '小棠和阿哲订婚了，婚礼定在十月', region: 'longterm', importance: 0.7, tags: ['小棠', '婚礼'] })
  await brain.remember({ content: '小棠让阿遥帮忙选婚礼入场曲', region: 'auditory', importance: 0.5, tags: ['小棠', '婚礼', '音乐'] })
  await brain.remember({ content: '婚礼上阿遥作为伴娘念了一封信', region: 'limbic', importance: 0.9, tags: ['小棠', '婚礼'] })
  await brain.remember({ content: '阿遥周末去剪了短发', region: 'life', importance: 0.2, tags: ['理发'] })
  const r = await callTool(brain, 'memory_recall', { query: '订婚', limit: 1 })
  assert.equal(r.clusters.length, 1)
  assert.ok(r.clusters[0].associated.length >= 2, '应该顺着关联想起婚礼相关的记忆')
  assert.ok(!JSON.stringify(r).includes('短发'))
})

test('可塑性性格：有上限、会累积', async () => {
  const { brain } = fresh()
  await brain.remember({ content: 'x', region: 'life', importance: 0.1 })
  const a = brain.shapePersona([{ trait: 'warmth', delta: 0.5, reason: '测试' }])
  assert.equal(a[0].delta, 0.05)
  brain.shapePersona([{ trait: '温柔', delta: 0.05, reason: '再一次' }])
  const b = brain.shapePersona([{ trait: 'warmth', delta: 0.05, reason: '超过每日上限' }])
  assert.equal(b.length, 0)
  assert.match(brain.personaText(), /温柔/)
  // 人设卡
  brain.setPersonaProfile({ name: '小满', title: '会写诗的仿生人', speaking_style: '温柔，偶尔俏皮', avatar: 'javascript:alert(1)' })
  const text = brain.personaText()
  assert.match(text, /【我的人设卡】/); assert.match(text, /名字：小满/); assert.match(text, /说话方式：温柔/)
  assert.equal(brain.persona().profile.avatar, null, '只接受 data:image 头像')
})

test('导出需要钥匙，而且只有同一把钥匙能导入', async () => {
  const { brain } = fresh()
  const { admin_key } = await brain.remember({ content: '要带走的记忆', region: 'longterm', importance: 0.8 })
  const bundle = brain.exportBundle()
  assert.ok(!JSON.stringify(bundle).includes('要带走'))
  const other = fresh(); await other.brain.remember({ content: 'y', region: 'life', importance: 0.1 })
  const target = new Brain(tmp())
  assert.throws(() => target.importBundle(bundle, other.brain.keyStatus().key_path), /那把钥匙/)
  assert.equal(target.importBundle(bundle, admin_key.key_path).added, 1)
  assert.match(target.search('带走')[0].content, /要带走的记忆/)
  fs.rmSync(admin_key.key_path)
  assert.throws(() => brain.exportBundle(), /锁着/)
})

test('HTTP：钥匙不在时什么都看不到、改不了', async () => {
  const { brain } = fresh()
  const { admin_key } = await brain.remember({ content: '秘密的记忆', region: 'limbic', importance: 0.8 })
  const id = brain.memories[0].id
  const srv = http.createServer((q, s) => createHandler({ brain })(q, s)); await new Promise(r => srv.listen(0, r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const j = async (p, o = {}) => { const r = await fetch(base + p, o); return { status: r.status, body: await r.json().catch(() => null) } }
  try {
    assert.equal((await j('/api/brain')).body.sealed, false)
    const hidden = admin_key.key_path + '.away'; fs.renameSync(admin_key.key_path, hidden)
    const snap = await j('/api/brain')
    assert.equal(snap.body.sealed, true); assert.ok(!JSON.stringify(snap.body).includes('秘密'))
    assert.equal((await j(`/api/admin/memories/${id}`, { method: 'POST', body: '{"content":"改掉"}' })).status, 423)
    assert.equal((await j('/api/export')).status, 423)
    assert.equal((await j('/api/key', { method: 'POST', body: JSON.stringify({ path: hidden }) })).status, 200)
    const upd = await j(`/api/admin/memories/${id}`, { method: 'POST', body: '{"content":"改过的记忆"}' })
    assert.equal(upd.body.content, '改过的记忆')
  } finally { srv.close() }
})

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

test('免疫系统·禁忌：过敏这类事永远不会遗忘，并且每次都自动带上', async () => {
  const { brain } = fresh()
  const t0 = Date.now() / 1000 - 400 * 86400
  const r = await callTool(brain, 'memory_remember', { content: '阿遥对芒果过敏，吃了会起疹子', region: '过敏', importance: 1 })
  assert.equal(r.memory.region, 'immune')
  assert.match(r.note, /永远不会遗忘/)
  await brain.remember({ content: '阿遥对花生过敏', region: 'immune', importance: 0.95, created_at: t0, last_access: t0, _log: false })
  await brain.remember({ content: '阿遥一年前喜欢的一首歌', region: 'auditory', importance: 1, created_at: t0, last_access: t0, _log: false })
  const faded = brain.maintain()
  assert.equal(faded.length, 1, '一年没想起的普通记忆会被遗忘，过敏不会')
  const wake = await callTool(brain, 'memory_wake', {})
  assert.equal(wake.always_remember.length, 2)
  assert.ok(wake.always_remember.some(c => c.includes('花生')))
})

test('我眼中的你：像对老朋友的档案，一区一区更新，旧版保留；改需要钥匙', async () => {
  const { brain } = fresh()
  const r1 = await callTool(brain, 'portrait_update', { name: '阿遥', sections: { basics: '27 岁，在杭州做绘本编辑', personality: '要强，心软' }, unknowns: ['她的生日', '她老家在哪'], reason: '第一次' })
  assert.equal(r1.ok, true); assert.ok(r1.tell_user_now, '第一次写也会生成钥匙'); assert.match(r1.note, /2\/12/)
  await callTool(brain, 'portrait_update', { sections: { 情绪: '难过时说「今天是阴天」，需要陪着聊轻松的', personality: '' }, unknowns: ['她老家在哪'], reason: '知道了她的暗号' })
  const p = brain.portrait(5)
  assert.equal(p.name, '阿遥'); assert.match(p.sections.basics, /杭州/); assert.match(p.sections.emotions, /阴天/)
  assert.equal(p.sections.personality, undefined, '给空字符串就清掉')
  assert.deepEqual(p.unknowns, ['她老家在哪']); assert.equal(p.known, 2)
  assert.equal(p.history.length, 1); assert.match(p.history[0].sections.personality, /要强/)
  assert.ok(!fs.readFileSync(path.join(brain.home, 'portrait.json'), 'utf8').includes('杭州'))
  const wake = await callTool(brain, 'memory_wake', {})
  assert.match(wake.portrait, /· 基本信息：27 岁/); assert.match(wake.portrait, /还不了解的/); assert.match(wake.portrait, /了解程度：2\/12/)
  fs.renameSync(brain.keyStatus().key_path, brain.keyStatus().key_path + '.x')
  assert.equal(brain.portrait(), null)
  assert.equal((await callTool(brain, 'portrait_update', { sections: { now: 'x' } })).error, 'LOCKED')
})

test('记忆会过时：新的取代旧的，旧的不再被想起、也不会复苏', async () => {
  const { brain } = fresh()
  const old = await brain.remember({ content: '阿遥住在杭州西湖边', region: 'longterm', type: 'fact', importance: 0.7, tags: ['住址', '杭州'] })
  const r = await callTool(brain, 'memory_remember', { content: '阿遥搬家了，现在住在上海徐汇', region: 'longterm', type: 'fact', importance: 0.7, tags: ['住址', '上海'], supersedes: [old.id] })
  assert.deepEqual(r.memory.superseded, [old.id])
  const hits = await callTool(brain, 'memory_recall', { query: '阿遥住在哪里 杭州 上海' })
  const all = JSON.stringify(hits)
  assert.ok(all.includes('上海')); assert.ok(!all.includes('西湖'), '被取代的旧记忆不会再被想起')
  const m = brain.memories.find(x => x.id === old.id)
  assert.equal(m.superseded_by, r.memory.id); assert.equal(m.status, 'archived')
})

test('睡眠整理：零碎相似的小记忆合并成一段，原来的退休', async () => {
  const { brain } = fresh()
  const d = 86400, t = Date.now() / 1000
  for (let i = 0; i < 4; i++) await brain.remember({ content: `阿遥周末去楼下面包店买了海盐卷（第 ${i + 1} 次）`, region: 'life', importance: 0.3, created_at: t - (10 - i) * d, _log: false })
  await brain.remember({ content: '阿遥对芒果过敏', region: 'immune', importance: 1 })
  const r = await brain.consolidate()
  assert.equal(r.length, 1); assert.equal(r[0].from.length, 4)
  assert.match(r[0].content, /发生过 4 次/); assert.ok(!r[0].content.includes('第 1 次'))
  assert.equal(brain.memories.filter(m => m.merged_into === r[0].into).length, 4)
  const hits = brain.recall('海盐卷 面包店')
  assert.equal(hits.length, 1, '只会想起整理后的那一段'); assert.match(hits[0].memory.content, /4 次/)
})

test('一个角色一个大脑：各有各的记忆和钥匙，互不相通', async () => {
  const { openBrain, createCharacter, listCharacters } = await import('../lib/core/characters.js')
  const root = tmp(); process.env.FMN_KEY_DIR = tmp()
  const main = openBrain({ home: root })
  await main.remember({ content: '星眠记得阿遥对芒果过敏', region: 'immune', importance: 1 })
  const fish = createCharacter(root, '大肥鱼')
  const b = openBrain({ home: root, character: fish.id })
  const r = await b.remember({ content: '大肥鱼记得用户喜欢吃火锅', region: 'life', importance: 0.5 })
  assert.match(r.admin_key.key_path, /勿忘我-大肥鱼-超级管理员钥匙\.key$/, '每个角色有自己的钥匙')
  assert.notEqual(r.admin_key.fingerprint, main.keyStatus().fingerprint)
  assert.equal(b.search('芒果').length, 0, '大肥鱼想不起星眠的记忆')
  assert.equal(main.search('火锅').length, 0)
  assert.deepEqual(listCharacters(root).map(c => c.name), ['默认', '大肥鱼'])
  assert.throws(() => openBrain({ home: root, character: 'c_nothere1' }), /没有这个角色/)
})

test('钥匙备份：拆成 3 片，任意 2 片拼回来；1 片不行；别的钥匙的碎片不行', async () => {
  const { brain, desk } = fresh()
  const { admin_key } = await brain.remember({ content: '要好好保管的记忆', region: 'longterm', importance: 0.9 })
  const shares = brain.backupKey(3, 2)
  assert.equal(shares.length, 3)
  assert.ok(!shares.join('').includes('PRIVATE KEY'), '碎片里看不出钥匙原文')
  fs.rmSync(admin_key.key_path)                          // 钥匙丢了
  assert.equal(brain.unlocked, false)
  assert.throws(() => brain.restoreKey([shares[1]]), /还差 1 片/)
  const other = fresh(); await other.brain.remember({ content: 'x', region: 'life', importance: 0.1 })
  assert.throws(() => brain.restoreKey([other.brain.backupKey()[0], shares[2]]), /不属于同一把钥匙/)
  const k = brain.restoreKey([shares[2], shares[0]], desk)
  assert.equal(k.unlocked, true)
  assert.match(brain.search('保管')[0].content, /好好保管/)
})

test('和 Aurabot 一起用：群聊会话关掉勿忘我，只认主人私聊里亲口说的话', async () => {
  const { aurabotMode, ownerSaid } = await import('../lib/index.js')
  const s = p => ({ header: { agentPreset: p } })
  assert.equal(aurabotMode(s('aurabot-private')), 'private')
  assert.equal(aurabotMode(s('aurabot-private-long')), 'private')
  assert.equal(aurabotMode(s('aurabot-social')), 'off')
  assert.equal(aurabotMode(s('aurabot-subagent')), 'off')
  assert.equal(aurabotMode(s('default')), 'normal')
  assert.equal(aurabotMode(s('aurabot-social'), { aurabot: { group: 'full' } }), 'private')
  assert.equal(ownerSaid({ kind: 'user' }), true)
  assert.equal(ownerSaid({ kind: 'aurabot', speaker: { role: 'owner', chat: 'private' } }), true)
  assert.equal(ownerSaid({ kind: 'aurabot', speaker: { role: 'owner', chat: 'group' } }), false)
  assert.equal(ownerSaid({ kind: 'aurabot', speaker: { role: 'guest', chat: 'private' } }), false)
})

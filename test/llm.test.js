import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Brain } from '../lib/core/brain.js'
import { callTool } from '../lib/core/tools.js'
import { digest } from '../lib/core/digest.js'
import { envChat, envEmbedder } from '../lib/core/llm.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fmn-'))

// 一个假的 OpenAI 兼容模型服务：总结、联想、嵌入都给固定的回答
const GROUPS = [['难过', '委屈', '哭', '低落', '伤心'], ['火锅', '吃饭', '餐厅', '美食'], ['猫', '团子', '宠物']]
function fakeVec(text) {
  const v = GROUPS.map(g => g.some(w => text.includes(w)) ? 1 : 0)
  v.push(0.05)
  return v
}
function fakeServer() {
  const calls = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const j = JSON.parse(body); calls.push({ url: req.url, auth: req.headers.authorization })
      let out
      if (req.url.endsWith('/embeddings')) out = { data: j.input.map((t, index) => ({ index, embedding: fakeVec(t) })) }
      else {
        const sys = j.messages[0].content
        const user = j.messages[1].content
        // 挑记忆：按「意思」挑（用同一组近义词假装读懂了），故意不看字面
        if (sys.includes('回想自己的记忆')) {
          const q = fakeVec(user.split('\n')[0]).slice(0, 3)
          const ids = [...user.matchAll(/\[(m_[^\]]+)\][^\n]*：([^\n]*)/g)].filter(([, , c]) => fakeVec(c).slice(0, 3).some((x, i) => x && q[i])).map(m => m[1])
          out = { choices: [{ message: { content: JSON.stringify({ ids: [...ids, 'm_不存在'] }) } }] }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); return
        }
        const content = sys.includes('海马体')
          ? JSON.stringify({ memories: [
              { content: '阿遥今天被老板批评了，委屈地哭了很久，我陪她聊到半夜。', region: 'limbic', type: 'episode', importance: 0.8, title: '被批评', emotion: '委屈', valence: -0.8, tags: ['阿遥', '工作'], image_prompt: '深夜的窗边' },
              { content: '阿遥说周末想去吃那家重庆火锅。', region: 'life', type: 'preference', importance: 0.4, tags: ['火锅'], image_prompt: '不该出现' },
              { content: '嗯', region: 'life', importance: 0.1 },
            ], persona: [{ trait: 'warmth', delta: 0.5, reason: '陪她度过难过的夜晚' }] })
          : JSON.stringify({ terms: ['难过', '委屈', '哭'] })
        out = { choices: [{ message: { content: '```json\n' + content + '\n```' } }] }
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out))
    })
  })
  return new Promise(r => srv.listen(0, () => r({ srv, calls, base: `http://127.0.0.1:${srv.address().port}` })))
}

test('自动总结：模型把对话写成记忆，过滤无用条目，性格变化被限幅', async () => {
  const { srv, calls, base } = await fakeServer()
  try {
    process.env.FMN_KEY_DIR = tmp()
    const brain = new Brain(tmp())
    brain.chat = envChat({ FMN_LLM_BASE_URL: base, FMN_LLM_API_KEY: 'k' })
    const r = await digest(brain, brain.chat, [
      { role: 'user', text: '今天被老板骂了，好委屈，哭了好久' },
      { role: 'assistant', text: '抱抱你，我在呢。想说说发生了什么吗？' },
      { role: 'user', text: '算了不说了，周末想去吃那家重庆火锅' },
    ])
    assert.equal(r.memories.length, 2)
    assert.ok(r.memories[0].admin_key, '第一次写入会生成钥匙')
    assert.equal(calls[0].auth, 'Bearer k')
    const all = brain.search('火锅')
    assert.equal(all[0].image_prompt, null, '不重要的记忆不配图')
    assert.ok(r.persona[0].delta <= 0.03)
    // 再总结一次同样的对话：不会重复写
    const r2 = await digest(brain, brain.chat, '用户：今天被老板骂了，好委屈\nAI：抱抱你')
    assert.equal(r2.memories.length, 0)
  } finally { srv.close() }
})

test('更聪明的回想：联想词 + 语义向量能找到字面上完全不一样的记忆', async () => {
  const { srv, base } = await fakeServer()
  try {
    process.env.FMN_KEY_DIR = tmp()
    const brain = new Brain(tmp())
    await brain.remember({ content: '阿遥委屈地哭了很久', region: 'limbic', importance: 0.7 })
    await brain.remember({ content: '团子今天吐毛球了', region: 'social', importance: 0.4 })
    await brain.remember({ content: '阿遥周末去了图书馆', region: 'life', importance: 0.3 })
    // 没有模型时：「心情低落」和「委屈地哭」没有一个字相同，想不起来
    const plain = await callTool(brain, 'memory_recall', { query: '心情低落' })
    assert.ok(!JSON.stringify(plain).includes('委屈'))
    // 有联想：模型把「心情低落」扩展成 难过/委屈/哭
    brain.chat = envChat({ FMN_LLM_BASE_URL: base })
    const r = await callTool(brain, 'memory_recall', { query: '心情低落' })
    assert.match(r.clusters[0].memory.content, /委屈/)
    // 只有语义向量（没有联想）也能找到
    brain.chat = null
    brain.embedder = envEmbedder({ FMN_EMBED_BASE_URL: base, FMN_EMBED_MODEL: 'fake' })
    assert.equal(await brain.backfillEmbeddings(), 3)
    const r2 = await callTool(brain, 'memory_recall', { query: '伤心' })
    assert.match(r2.clusters[0].memory.content, /委屈/)
    assert.ok(!fs.readFileSync(path.join(brain.home, 'memories.json'), 'utf8').includes('委屈'))
  } finally { srv.close() }
})

test('DeepSeek 自己挑：一个字都不一样，也能按意思想起来，还会顺带想起关联记忆', async () => {
  const { srv, calls, base } = await fakeServer()
  try {
    process.env.FMN_KEY_DIR = tmp()
    const brain = new Brain(tmp())
    await brain.remember({ content: '团子今天吐毛球了', region: 'social', importance: 0.5 })
    await brain.remember({ content: '阿遥周末去了图书馆', region: 'life', importance: 0.3 })
    await brain.remember({ content: '阿遥说周末想去吃火锅', region: 'life', importance: 0.3 })
    const plain = await callTool(brain, 'memory_recall', { query: '宠物不舒服' })
    assert.ok(!JSON.stringify(plain).includes('毛球'), '只比字面时想不起来')
    brain.chat = envChat({ FMN_LLM_BASE_URL: base })
    const r = await callTool(brain, 'memory_recall', { query: '宠物不舒服' })
    assert.match(r.clusters[0].memory.content, /毛球/)
    assert.equal(r.clusters.length, 1, '模型编出来的 id 会被丢掉，不相关的不会混进来')
    assert.ok(calls.some(c => c.url.endsWith('/chat/completions')))
  } finally { srv.close() }
})

// 人物小档案：她对「别人」（不是主人）的印象——称呼、关系、印象、相处经验、说话方式、喜欢/讨厌。
// 和「我眼中的你」一样加密：每个人一个封存的盒子，文件里连 QQ 号都不出现（只存加盐的哈希）。
// 新建一个人不需要钥匙；在已有档案上修改要先读出旧的，所以需要钥匙。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { open, publicKeyOf, seal } from './vault.js'
import { atomicWrite, BrainError } from './brain.js'

const LIMITS = { name: 40, relation: 80, impression: 300, experience: 8, style: 6, item: 80, tags: 8 }
const fileOf = brain => path.join(brain.home, 'people.json')
const hid = (brain, id) => crypto.createHash('sha256').update(`${brain.vault?.publicKey || ''}|person|${id}`).digest('hex').slice(0, 20)
const readFile = brain => { try { return JSON.parse(fs.readFileSync(fileOf(brain), 'utf8')) } catch { return { v: 1, people: {} } } }
const clip = (s, n) => String(s ?? '').trim().slice(0, n)
const list = (xs, n) => [...new Set([].concat(xs || []).map(x => clip(x, LIMITS.item)).filter(Boolean))].slice(-n)

/** 在旧档案上合并：字符串给了就替换（给空串清掉），经验 / 说话方式是追加去重，只留最近几条；tags 给了就整体替换。 */
export function mergePerson(cur, patch = {}) {
  const p = { id: cur?.id || clip(patch.id, 60), name: cur?.name || '', relation: cur?.relation || '', impression: cur?.impression || '',
    experience: cur?.experience || [], style: cur?.style || [], tags: cur?.tags || [], created_at: cur?.created_at || Date.now() / 1000 }
  for (const k of ['name', 'relation', 'impression']) if (patch[k] !== undefined) p[k] = clip(patch[k], LIMITS[k])
  if (patch.experience !== undefined) p.experience = list([...(patch.replace ? [] : p.experience), ...[].concat(patch.experience)], LIMITS.experience)
  if (patch.style !== undefined) p.style = list([...(patch.replace ? [] : p.style), ...[].concat(patch.style)], LIMITS.style)
  if (Array.isArray(patch.tags)) p.tags = list(patch.tags, LIMITS.tags)
  p.updated_at = Date.now() / 1000
  return p
}

/** 读全部人物（需要钥匙；锁着返回 null）。 */
export function readPeople(brain) {
  const priv = brain._priv(); if (!priv) return null
  const out = []
  for (const [h, box] of Object.entries(readFile(brain).people || {})) { try { out.push(open(priv, box, 'person:' + h)) } catch { } }
  return out
}

export function readPerson(brain, id) {
  const priv = brain._priv(); if (!priv) return null
  const h = hid(brain, String(id)), box = readFile(brain).people?.[h]
  if (!box) return null
  try { return open(priv, box, 'person:' + h) } catch { return null }
}

/** 写一个人的档案。已有档案而钥匙不在时抛 LOCKED（看不到旧的就没法在它上面改）。 */
export function writePerson(brain, id, patch = {}) {
  id = clip(id, 60); if (!id) throw new BrainError('EMPTY', '要说是谁')
  brain._ensureVault()
  let next
  brain._withLock(() => {
    const f = readFile(brain), h = hid(brain, id)
    let cur = null
    if (f.people?.[h]) {
      const priv = brain._priv(); if (!priv) throw new BrainError('LOCKED', '钥匙不在：看不到这个人原来的档案，没法修改。')
      cur = open(priv, f.people[h], 'person:' + h)
    }
    next = mergePerson(cur, { ...patch, id })
    f.people = { ...(f.people || {}), [h]: seal(publicKeyOf(brain.vault.publicKey), next, 'person:' + h) }
    atomicWrite(fileOf(brain), JSON.stringify(f))
  })
  brain._event('person', [], patch.by || 'ai')
  return next
}

/** 给模型看的一行：「小明(123)——同学；人挺好…；相处：…；说话：…」 */
export function personLine(p, max = 120) {
  if (!p) return ''
  const bits = [p.tags?.length ? p.tags.join('、') : '', p.relation, p.impression,
    p.experience?.length ? '相处：' + p.experience.slice(-2).join('；') : '', p.style?.length ? '说话：' + p.style.slice(-2).join('；') : ''].filter(Boolean)
  return `${p.name || '某人'}${/^\d+$/.test(p.id) ? `(${p.id})` : ''}——${bits.join('；') || '还没什么印象'}`.slice(0, max)
}

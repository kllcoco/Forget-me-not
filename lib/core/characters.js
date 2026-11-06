// 一个角色一个大脑：星眠和大肥鱼各有各的记忆、各有各的钥匙。
//   主角色（main）就在数据目录本身（~/.forget-me-not），和以前完全一样；
//   其他角色在 ~/.forget-me-not/characters/<id>/。
//   名字记在 characters.json 里（只有名字，没有任何记忆内容）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Brain, BrainError, defaultHome } from './brain.js'

const ID = /^c_[a-z0-9]{6,12}$/
const regFile = root => path.join(root, 'characters.json')

function readReg(root) {
  try { return JSON.parse(fs.readFileSync(regFile(root), 'utf8')) } catch { return { main: { name: null }, list: [] } }
}
function writeReg(root, reg) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(regFile(root), JSON.stringify(reg, null, 2), { mode: 0o600 })
}

export function listCharacters(root = defaultHome()) {
  const reg = readReg(root)
  return [{ id: 'main', name: reg.main?.name || '默认', main: true }, ...reg.list.map(c => ({ id: c.id, name: c.name, created_at: c.created_at }))]
}

export function characterHome(root = defaultHome(), id) {
  if (!id || id === 'main') return root
  if (!ID.test(id) || !readReg(root).list.some(c => c.id === id)) throw new BrainError('NOT_FOUND', `没有这个角色：${id}`)
  return path.join(root, 'characters', id)
}

export function createCharacter(root = defaultHome(), name) {
  name = String(name || '').trim().slice(0, 40)
  if (!name) throw new BrainError('EMPTY', '给新角色起个名字吧')
  const reg = readReg(root)
  const id = 'c_' + crypto.randomBytes(4).toString('hex')
  reg.list.push({ id, name, created_at: Date.now() / 1000 })
  writeReg(root, reg)
  fs.mkdirSync(path.join(root, 'characters', id), { recursive: true, mode: 0o700 })
  return { id, name }
}

export function renameCharacter(root = defaultHome(), id, name) {
  name = String(name || '').trim().slice(0, 40); if (!name) return
  const reg = readReg(root)
  if (!id || id === 'main') reg.main = { ...(reg.main || {}), name }
  else { const c = reg.list.find(x => x.id === id); if (!c) return; c.name = name }
  writeReg(root, reg)
}

/** 打开某个角色的大脑：character 不给时看环境变量 FMN_CHARACTER，再没有就是主角色。 */
export function openBrain({ home, character } = {}) {
  const root = home || defaultHome()
  const id = character || process.env.FMN_CHARACTER || 'main'
  const brain = new Brain(characterHome(root, id))
  if (id !== 'main') brain.label = listCharacters(root).find(c => c.id === id)?.name   // 钥匙文件名里带上角色名
  return brain
}

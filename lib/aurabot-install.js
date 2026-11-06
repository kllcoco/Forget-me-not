// forget-me-not aurabot install：把勿忘我版的记忆模块装进 Aurabot（替换它内置的「记忆」模块）。
// Aurabot 的用户模块在 <数据目录>/modules/<id>/index.mjs，和内置模块同名就替换内置的；
// 数据目录 = $AURABOT_DATA_DIR，或 $DSH_HOME/plugins-data/aurabot（默认 ~/.dsh/plugins-data/aurabot，Windows 是 %USERPROFILE%\.dsh\plugins-data\aurabot）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MODULE_FILE = fileURLToPath(new URL('../aurabot/memory/index.mjs', import.meta.url))
const MARK = '勿忘我 Forget-me-not 的记忆模块入口'

export function aurabotDataDir(env = process.env) {
  return env.AURABOT_DATA_DIR || path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'plugins-data', 'aurabot')
}

/** 写入口文件（指向本包里的模块，升级勿忘我后自动是新的）。原来有别人的 modules/memory 就先改名备份。 */
export function installAurabot({ dir = aurabotDataDir() } = {}) {
  const target = path.join(dir, 'modules', 'memory'), entry = path.join(target, 'index.mjs')
  let backup = null
  if (fs.existsSync(target) && !(fs.existsSync(entry) && fs.readFileSync(entry, 'utf8').includes(MARK))) {
    backup = path.join(dir, 'modules', `_memory.bak-${Date.now()}`); fs.renameSync(target, backup)   // 「_」开头的文件夹 Aurabot 不加载
  }
  fs.mkdirSync(target, { recursive: true })
  const url = pathToFileURL(MODULE_FILE).href
  fs.writeFileSync(entry, `// ${MARK}（forget-me-not aurabot install 生成；删掉这个文件夹就用回 Aurabot 内置的记忆）\nexport * from '${url}'\nexport { default } from '${url}'\n`)
  return { entry, backup, module: MODULE_FILE }
}

export function uninstallAurabot({ dir = aurabotDataDir() } = {}) {
  const target = path.join(dir, 'modules', 'memory'), entry = path.join(target, 'index.mjs')
  if (!fs.existsSync(entry) || !fs.readFileSync(entry, 'utf8').includes(MARK)) return { removed: false }
  fs.rmSync(target, { recursive: true, force: true })
  return { removed: true, target }
}

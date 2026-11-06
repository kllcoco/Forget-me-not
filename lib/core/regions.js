// 大脑分区。记忆区（memory）存放记忆；过程区（process）是搬运记忆的器官，只在脑图里显示数据流。

export const REGIONS = [
  { key: 'longterm', name: '长期记忆库', en: 'Long-term', kind: 'memory', color: '#f5b860',
    desc: '值得长久记住的事件与事实：发生过的重要事情、对方的重要信息、约定。拿不准放哪就放这里。' },
  { key: 'limbic', name: '边缘系统·情绪', en: 'Limbic', kind: 'memory', color: '#e07bd8',
    desc: '带强烈情绪的时刻：开心、难过、争吵、感动、被安慰；以及对人或事的感受。' },
  { key: 'social', name: '神经图谱', en: 'Social graph', kind: 'memory', color: '#5fd4e8',
    desc: '人物与关系：对方身边的人是谁、和谁关系如何、各自的特点。' },
  { key: 'life', name: '生活回路', en: 'Routines', kind: 'memory', color: '#7ee08a',
    desc: '作息、习惯、口味、喜好与讨厌的东西，日常里反复出现的规律。' },
  { key: 'working', name: '工作记忆', en: 'Working', kind: 'memory', color: '#c9a7ff',
    desc: '短期有效的临时信息：正在进行的任务、这几天的安排。会很快自然淡忘。' },
  { key: 'expression', name: '语言中枢·表达', en: 'Expression', kind: 'memory', color: '#ffa36b',
    desc: '怎么说话：对方喜欢的称呼、语气、说话风格、不要说的话、彼此的暗号。' },
  { key: 'introspect', name: '内省·反馈', en: 'Introspection', kind: 'memory', color: '#ff6b7f',
    desc: 'AI 自己的反思与教训：哪里做得不好、学到了什么、下次要怎么做。' },
  { key: 'visual', name: '视觉皮层', en: 'Visual', kind: 'memory', color: '#4fb6ff',
    desc: '看到过的画面：对方分享的照片、截图、风景，适合配图。' },
  { key: 'auditory', name: '听觉皮层', en: 'Auditory', kind: 'memory', color: '#8f9bff',
    desc: '听到过的声音：歌曲、语音、音乐品味。' },
  { key: 'input', name: '语言输入', en: 'Input', kind: 'process', color: '#a9c7ff', desc: '对话进入大脑的入口。' },
  { key: 'hippocampus', name: '海马体·写入', en: 'Hippocampus', kind: 'process', color: '#6ff0c0', desc: '把总结好的记忆封存进对应脑区。' },
  { key: 'retrieval', name: '大脑中枢·检索', en: 'Retrieval', kind: 'process', color: '#ffe27a', desc: '根据线索把记忆想起来。' },
  { key: 'metabolism', name: '代谢·治理', en: 'Metabolism', kind: 'process', color: '#9a8cff', desc: '让不重要的记忆慢慢淡去。' },
]

export const MEMORY_REGIONS = REGIONS.filter(r => r.kind === 'memory').map(r => r.key)
export const REGION_BY_KEY = Object.fromEntries(REGIONS.map(r => [r.key, r]))

export const MEMORY_TYPES = { episode: '事件', fact: '事实', preference: '偏好', skill: '技能', lesson: '教训', reflection: '反思' }

const REGION_ALIASES = {}
for (const r of REGIONS) {
  if (r.kind !== 'memory') continue
  REGION_ALIASES[r.key] = r.key; REGION_ALIASES[r.name] = r.key; REGION_ALIASES[r.en.toLowerCase()] = r.key
  for (const part of r.name.split('·')) REGION_ALIASES[part] = r.key
}
Object.assign(REGION_ALIASES, { 情绪: 'limbic', 关系: 'social', 人物: 'social', 习惯: 'life', 喜好: 'life', 临时: 'working',
  反思: 'introspect', 说话: 'expression', 图片: 'visual', 音乐: 'auditory', 长期: 'longterm' })
const TYPE_ALIASES = Object.fromEntries([...Object.keys(MEMORY_TYPES).map(k => [k, k]), ...Object.entries(MEMORY_TYPES).map(([k, v]) => [v, k])])

export const resolveRegion = v => REGION_ALIASES[String(v ?? '').trim()] || REGION_ALIASES[String(v ?? '').trim().toLowerCase()] || 'longterm'
export const resolveType = v => TYPE_ALIASES[String(v ?? '').trim()] || TYPE_ALIASES[String(v ?? '').trim().toLowerCase()] || 'episode'

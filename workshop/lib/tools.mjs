// tools.mjs —— 创意工具箱 + 章节划选 AI 动作（2026-10-03，对标星月写作的「创作工具箱」与编辑器工具栏）
// 两块功能都只是「拼提示词 → 调一次模型 → 清洗结果」，不写盘、不改书（改书走已有的 /api/package/apply 与 /api/save）。
// 任务 id：tool（创意工具箱）、selection（划选改写），分配见 lib/agents.mjs 的 TASKS。
import { chat } from './llm.mjs'
import * as S from './store.mjs'
import { styleOfBook, styleRules } from './styles.mjs'

/** 番茄书名上限：15 个字符，标点也算（与 packaging.mjs 的 TITLE_MAX 同口径；这里不 import 它，免得拖进一串依赖） */
export const TITLE_MAX = 15
const len = (s) => [...String(s || '')].length

const SYS = `你是番茄小说作者的创意助手，熟悉男频女频的爆款写法：开头快、反差强、爽点明确、拒绝文艺和空话。
硬性要求：只输出结果本身，不要开场白、不要解释、不要总结、不要「好的」「以下是」，不要用 markdown 标题或加粗符号。`

// ─────────────────────────── 创意工具箱 ───────────────────────────
// 输入项 req：'always' 一定要填；'unbound' 不绑定书时必须填（绑定了书就可以空着，用书里的资料）
// rule：字符串或 (values) => 字符串，是给模型的具体要求
export const TOOLS = [
  {
    id: 'title', label: '书名', icon: '📖', multi: true, apply: 'title', maxTokens: 1500, desc: '一次给 6 个番茄风格的书名，自动过滤超过 15 个字的。',
    inputs: [
      { key: 'idea', label: '这本书讲什么（一句话）', placeholder: '例如：外卖员送单时能看到顾客的秘密', req: 'unbound', rows: 2 },
      { key: 'hint', label: '想要的味道（可不填）', placeholder: '例如：反差大一点、带点搞笑' },
    ],
    rule: `给这本书起 6 个番茄风格的书名，用「1.」「2.」…编号，每行只写书名本身（不加书名号，不加解释）。
每个书名不超过 ${TITLE_MAX} 个汉字（标点也算）。要点：有反差、悬念或身份错位，读者 3 秒看懂卖点，六个之间句式要不同。`,
  },
  {
    id: 'intro', label: '简介', icon: '📝', apply: 'intro', maxTokens: 1500, desc: '写一段能吸引人点进来的简介（约 200 字）。',
    inputs: [
      { key: 'idea', label: '故事讲什么（一句话或几句话）', placeholder: '例如：穷小子意外得到一个能看见别人欠债的眼睛，靠它一路翻身', req: 'unbound', rows: 3 },
      { key: 'title', label: '书名（可不填）', placeholder: '例如：我能看见你的欠条' },
      { key: 'extra', label: '额外要求（可不填）', placeholder: '例如：结尾要留悬念，别剧透' },
    ],
    rule: `写一段番茄风格的作品简介，180~260 字，分 2~3 小段：第一句直接抛钩子（冲突或反差）；中间交代主角处境和金手指；结尾留悬念或承诺一个大爽点。
不剧透结局，不写「本书讲述了」，不写作者感言。只输出简介正文。`,
  },
  {
    id: 'outline', label: '大纲', icon: '🗺️', maxTokens: 3500, desc: '按阶段写全书大纲：每阶段的冲突、爽点、结尾钩子。',
    inputs: [
      { key: 'idea', label: '故事讲什么', placeholder: '例如：重生回高考前，带着十年后的记忆逆袭', req: 'unbound', rows: 3 },
      { key: 'size', label: '想写多长（可不填）', placeholder: '例如：100 章 / 30 万字' },
    ],
    rule: `写全书大纲。格式：
第一行写「一句话卖点」。
然后分 3~5 个阶段，每阶段写：阶段名｜章数范围｜核心冲突｜最大的爽点｜阶段结尾钩子（每阶段不超过 4 行）。
最后列 3~5 个主要人物，每人一行（名字｜身份｜与主角的关系）。`,
  },
  {
    id: 'detail', label: '细纲（单章）', icon: '🔍', maxTokens: 2500, desc: '把某一章拆成 6~10 个场景节拍，最后一条是章末钩子。',
    inputs: [
      { key: 'chapter', label: '这一章要发生什么', placeholder: '例如：主角第一次在公司会议上当众揭穿经理的假账', req: 'always', rows: 3 },
      { key: 'prev', label: '上一章怎么结尾的（可不填）', placeholder: '例如：经理发现主角偷偷拍了账本' },
      { key: 'words', label: '这章想写多少字（可不填）', placeholder: '例如：2500' },
    ],
    rule: `把这一章拆成 6~10 个场景节拍，用「1.」「2.」…编号。每条一句话，写清：谁、在哪、做什么、冲突点在哪、情绪怎么变。
最后一条必须是章末钩子（让读者想点下一章）。只写节拍，不写正文。`,
  },
  {
    id: 'opening', label: '黄金开篇', icon: '✨', maxTokens: 1500, desc: '写出前 300 字左右，第一句就进冲突。',
    inputs: [
      { key: 'scene', label: '开篇想写什么场景或事件', placeholder: '例如：主角被当众退婚，手机突然响起神秘短信', req: 'unbound', rows: 3 },
      { key: 'who', label: '主角是谁（可不填）', placeholder: '例如：25 岁，外卖员，嘴碎心软' },
    ],
    rule: `写小说开篇，280~340 字。第一句就进冲突或反差，不写天气、醒来、自我介绍；要有一个具体画面和一句对白，结尾留一个让人想翻页的疑问。
只输出开篇正文，用中文全角标点。`,
  },
  {
    id: 'goldfinger', label: '金手指', icon: '🖐️', multi: true, maxTokens: 2500, desc: '一次给 6 个外挂方案，带代价和升级路线。',
    inputs: [
      { key: 'idea', label: '故事背景', placeholder: '例如：都市职场，主角是刚毕业的实习生', req: 'unbound', rows: 2 },
      { key: 'want', label: '想要什么类型（可不填）', placeholder: '例如：和钱有关、不要系统' },
    ],
    rule: `设计 6 个金手指（外挂）方案，用「1.」「2.」…编号。每个一小段，写清：名称（8 字内）｜能力一句话｜代价或限制｜前期怎么爽、后期怎么升级。
要新鲜，别都是「系统」；六个之间不要雷同。`,
  },
  {
    id: 'persona', label: '人设', icon: '🧑', maxTokens: 1800, desc: '写一张人设卡：性格、弱点、口头禅、出场小场景。',
    inputs: [
      { key: 'role', label: '这个人是谁', placeholder: '例如：女主，表面冷艳的集团总裁，其实怕狗', req: 'always', rows: 2 },
      { key: 'idea', label: '放在什么故事里（可不填）', placeholder: '例如：都市职场爽文' },
    ],
    rule: `写一张人设卡，按行列出：姓名｜年龄与身份｜外貌（一句话抓特征）｜性格关键词（3 个）｜核心欲望｜致命弱点｜口头禅或标志动作｜与主角的关系。
最后再写一个「出场小场景」（2 句话），让读者一眼记住这个人。`,
  },
  {
    id: 'world', label: '世界观', icon: '🌍', maxTokens: 2500, desc: '时代地点、规则分级、主要势力、最大矛盾。',
    inputs: [
      { key: 'idea', label: '故事讲什么', placeholder: '例如：灵气复苏后的现代都市', req: 'unbound', rows: 2 },
      { key: 'kind', label: '类型（可不填）', placeholder: '例如：都市异能 / 古代玄幻' },
    ],
    rule: `写世界观设定，分点列出：时代与地点｜力量或规则体系（分 3~5 级，每级一句）｜主要势力（3 个，各一句）｜这个世界最大的矛盾｜主角能钻的空子。
条理清楚，别写成论文。`,
  },
  {
    id: 'naming', label: '取名', icon: '🏷️', multi: true, maxTokens: 1500, desc: '人名、地名、功法、组织名，一次给 8 个。',
    inputs: [
      { key: 'kind', label: '取什么名', type: 'select', options: ['人名', '地名', '功法', '组织'], req: 'always' },
      { key: 'hint', label: '背景或风格', placeholder: '例如：古代仙侠，主角是落魄剑修', req: 'always', rows: 2 },
    ],
    rule: (v) => `给出 8 个${v.kind || '人名'}，用「1.」「2.」…编号，每行格式：名字——一句话特点（10 字内）。
名字要好记、不撞烂梗、读起来顺口，八个之间风格要有区别。`,
  },
  {
    id: 'brainstorm', label: '脑洞', icon: '💡', multi: true, maxTokens: 2500, desc: '给几个关键词，出 6 个带反差的故事脑洞。',
    inputs: [
      { key: 'keywords', label: '关键词或想法', placeholder: '例如：直播、重生、送外卖', req: 'unbound', rows: 2 },
      { key: 'style', label: '想要的风格（可不填）', placeholder: '例如：轻松搞笑 / 热血逆袭' },
    ],
    rule: `给 6 个故事脑洞，用「1.」「2.」…编号。每个写三句：一句话脑洞（40 字内，要有反差）｜主角的处境｜最爽的一个场面。
六个之间不要雷同。`,
  },
]
const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]))
export const toolLabel = (id) => TOOL_BY_ID.get(id)?.label || id

/** 给前端的清单：按它渲染，前端不硬编码第二份 */
export function toolList() {
  return TOOLS.map((t) => ({
    id: t.id, label: t.label, icon: t.icon, desc: t.desc, multi: !!t.multi, apply: t.apply || '',
    inputs: t.inputs.map((i) => ({ key: i.key, label: i.label, placeholder: i.placeholder || '', type: i.type || 'text', options: i.options || null, rows: i.rows || 1, required: i.req || '' })),
  }))
}

const clip = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n)

/** 校验并整理输入。错误文案是给作者看的人话 */
export function checkTool(toolId, inputs, { bound = false } = {}) {
  const t = TOOL_BY_ID.get(String(toolId || ''))
  if (!t) throw new Error('没有这个工具')
  const src = inputs && typeof inputs === 'object' ? inputs : {}
  const v = {}
  for (const f of t.inputs) {
    let x = clip(src[f.key], f.type === 'select' ? 20 : f.rows > 1 ? 800 : 300)
    if (f.type === 'select' && !f.options.includes(x)) x = f.options[0]
    if (!x && (f.req === 'always' || (f.req === 'unbound' && !bound))) throw new Error(`请先填写「${f.label.replace(/（.*?）/g, '')}」${f.req === 'unbound' ? '（或先选一本书，用书里的资料）' : ''}`)
    v[f.key] = x
  }
  return v
}

/** 绑定书时带入的资料：风格规则 1500 字、设定集 3000 字、最近 2 章前情。读不到的部分直接跳过 */
export function bookContext(id) {
  if (!id) return null
  const book = S.readBook(id)
  let rules = '', label = ''
  try { const st = styleOfBook(book); label = st.label; rules = styleRules(st).slice(0, 1500) } catch { /* 风格文件读不到就跳过 */ }
  let bible = ''; try { bible = S.readText(id, 'bible.md').slice(0, 3000) } catch { /* 无 */ }
  // 前情：pipeline.recapOf 没导出，这里直接读每章登记的 summary，没有再读 work/NNNN/summary.md
  const recap = (book.chapters || []).slice(-2).map((c) => {
    let s = String(c.summary || '')
    if (!s) { try { s = S.readText(id, 'work', S.pad(c.n), 'summary.md').slice(0, 600) } catch { s = '' } }
    return s ? `第${c.n}章 ${c.title || ''}：${s}` : ''
  }).filter(Boolean).join('\n')
  return { title: book.title || '', styleLabel: label, styleRules: rules, bible, recap }
}

/** 拼提示词（纯函数，测试直接调用）。ctx 为 bookContext() 的返回值或 null */
export function buildToolPrompt(toolId, values, ctx = null) {
  const t = TOOL_BY_ID.get(String(toolId || ''))
  if (!t) throw new Error('没有这个工具')
  const v = values || {}
  const given = t.inputs.filter((f) => v[f.key]).map((f) => `- ${f.label.replace(/（.*?）/g, '')}：${v[f.key]}`).join('\n')
  const rule = typeof t.rule === 'function' ? t.rule(v) : t.rule
  let user = `【工具】${t.label}\n【作者给的信息】\n${given || '（没有填，请完全按下面的本书资料来）'}\n\n【要求】\n${rule}`
  if (ctx) {
    const parts = [`书名：${ctx.title}`]
    if (ctx.styleLabel) parts.push(`风格：${ctx.styleLabel}`)
    if (ctx.styleRules) parts.push(`风格规则：\n${ctx.styleRules}`)
    if (ctx.bible) parts.push(`设定集：\n${ctx.bible}`)
    if (ctx.recap) parts.push(`最近的前情：\n${ctx.recap}`)
    user += `\n\n【本书资料（只供参考，别照抄原文；作者给的信息优先）】\n${parts.join('\n')}`
  }
  return { system: SYS, user, maxTokens: t.maxTokens || 2000, temperature: 0.9 }
}

/** 书名候选：按编号行解析，去书名号/后缀解释；超过 15 字的过滤掉并记下来 */
export function filterTitles(text) {
  const kept = [], dropped = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[.、．:：)）]\s*(.+?)\s*$/)
    if (!m) continue
    const title = m[1].split(/\s*(?:——|—|｜|\|)\s*/)[0].replace(/[《》“”"「」]/g, '').replace(/[*#`]/g, '').trim()
    if (!title) continue
    if (len(title) > TITLE_MAX) dropped.push({ title, len: len(title) }); else if (!kept.includes(title)) kept.push(title)
  }
  return { kept, dropped, text: kept.map((t, i) => `${i + 1}. ${t}`).join('\n') }
}

const stripFence = (s) => String(s || '').replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()

/** 跑一个工具。id 可空（不绑定书）。返回 { tool, text, titles?, dropped?, summary } */
export async function runTool({ id = '', tool, inputs }, { onStep = () => {} } = {}) {
  const t = TOOL_BY_ID.get(String(tool || ''))
  if (!t) throw new Error('没有这个工具')
  const v = checkTool(tool, inputs, { bound: !!id })
  const ctx = id ? bookContext(id) : null
  const p = buildToolPrompt(tool, v, ctx)
  onStep(`${t.label}生成中（约 10~40 秒）`)
  const r = await chat({ task: 'tool', system: p.system, user: p.user, temperature: p.temperature, maxTokens: p.maxTokens, tag: 'tool-' + tool, thinking: false })
  if (id) S.addCost(id, r.cost)
  let text = stripFence(r.content)
  if (!text) throw new Error('模型没有返回内容，请再点一次「生成」')
  const out = { tool, text }
  if (tool === 'title') {
    const f = filterTitles(text)
    if (f.kept.length) { out.text = f.text; out.titles = f.kept }
    if (f.dropped.length) out.dropped = f.dropped
    out.summary = f.kept.length ? `${f.kept.length} 个书名${f.dropped.length ? `（另有 ${f.dropped.length} 个超过 ${TITLE_MAX} 字，已过滤）` : ''}` : '没能解析出书名，已显示原文'
    if (!f.kept.length && f.dropped.length) out.text = text + `\n\n（以上书名都超过 ${TITLE_MAX} 字，番茄放不下，请再点一次生成）`
  }
  return out
}

// ─────────────────────────── 章节划选 AI 动作 ───────────────────────────
export const SEL_MAX = 3000 // 选区最多 3000 字
export const CTX_MAX = 600  // 前后文各取最多 600 字
export const SELECTION_ACTIONS = {
  expand: { label: '扩写', temp: 0.8, rule: '在不改变情节、人设和事实的前提下扩写这一段：补充动作、神态、心理、环境细节和对白的潜台词，扩到原来的 1.5~2 倍长。不要加新的剧情转折。' },
  shrink: { label: '缩写', temp: 0.5, rule: '把这一段压缩到原来的一半左右：保留关键信息、冲突和钩子，删掉重复、铺垫和可有可无的形容。' },
  rewrite: { label: '改写', temp: 0.9, rule: '换一种写法重写这一段：意思、情节和人设不变，句式、用词和节奏要明显不同，不要照抄原句，长度和原文相近。' },
  polish: { label: '润色', temp: 0.6, rule: '润色这一段：只调整表达，让它更口语、更有画面、更有网文味，去掉空话和套话，不增删情节，长度和原文相近。' },
  fix: { label: '纠错', temp: 0.2, rule: '纠错这一段：只改错别字、标点、病句、人称和称呼前后不一致的地方，能不改的一律不改，其余逐字保留。' },
  continue: { label: '续写一段', temp: 0.85, rule: '接在这一段后面继续往下写一段（200~400 字），顺着情节和语气往下走，不要重复已经写过的内容。只输出续写出来的新内容，不要把原来的那一段再抄一遍。' },
}
const SEL_SYS = `你是网文编辑，正在帮作者处理章节里他选中的一段正文。
硬性要求：只输出处理后的正文本身，不要引号包裹，不要解释，不要「修改后：」之类的前缀，不要 markdown；保持原文的中文全角标点和分段习惯。`

export const actionLabel = (a) => SELECTION_ACTIONS[a]?.label || a

/** 校验划选请求并整理（错误文案是给作者看的人话） */
export function checkSelection(body) {
  const b = body || {}
  const action = String(b.action || '')
  if (!SELECTION_ACTIONS[action]) throw new Error('没有这个动作')
  const text = String(b.text ?? '').replace(/\r/g, '')
  if (!text.trim()) throw new Error('先用鼠标选中一段正文')
  if (text.length > SEL_MAX) throw new Error(`选的太多了（${text.length} 字），一次最多 ${SEL_MAX} 字，请分段选`)
  // before/after 是上下文：超出 600 字就只取靠近选区的那部分，不报错
  const before = String(b.before ?? '').replace(/\r/g, '').slice(-CTX_MAX)
  const after = String(b.after ?? '').replace(/\r/g, '').slice(0, CTX_MAX)
  const ask = String(b.ask ?? '').trim().slice(0, 200)
  return { action, text, before, after, ask }
}

/** 拼提示词（纯函数）。style：{ label, rules } 可空 */
export function buildSelectionPrompt(req, style = null) {
  const a = SELECTION_ACTIONS[req.action]
  if (!a) throw new Error('没有这个动作')
  const n = req.text.length
  let user = `【任务：${a.label}】\n${a.rule}`
  if (req.ask) user += `\n【作者额外要求】${req.ask}`
  if (style?.label) user += `\n【本书风格】${style.label}${style.rules ? '\n' + style.rules.slice(0, 400) : ''}`
  user += `\n\n【选区前面的正文（只用来衔接，不要输出）】\n${req.before || '（没有）'}\n\n【要处理的这一段（共 ${n} 字）】\n${req.text}\n\n【选区后面的正文（只用来衔接，不要输出）】\n${req.after || '（没有）'}`
  const maxTokens = req.action === 'continue' ? 1800 : req.action === 'expand' ? Math.min(8000, n * 3 + 600) : Math.min(6000, n * 2 + 600)
  return { system: SEL_SYS, user, maxTokens, temperature: a.temp }
}

const stripPrefix = (s) => stripFence(s).replace(/^\s*(?:修改后|改写后|润色后|扩写后|缩写后|纠错后|续写|结果|正文)\s*[:：]\s*/, '')

/** 跑一次划选动作。返回 { action, original, result } */
export async function runSelection(id, n, body, { onStep = () => {} } = {}) {
  const r0 = checkSelection(body)
  let style = null
  try { const st = styleOfBook(S.readBook(id)); style = { label: st.label, rules: styleRules(st) } } catch { /* 没有风格就不带 */ }
  const p = buildSelectionPrompt(r0, style)
  onStep(`${actionLabel(r0.action)}中（约 10~40 秒）`)
  const r = await chat({ task: 'selection', system: p.system, user: p.user, temperature: p.temperature, maxTokens: p.maxTokens, tag: 'sel-' + r0.action, thinking: false })
  S.addCost(id, r.cost)
  const result = stripPrefix(r.content)
  if (!result) throw new Error('模型没有返回内容，请再来一次')
  return { action: r0.action, original: r0.text, result, chapter: Number(n) || 0, summary: `${actionLabel(r0.action)}已生成，等你决定是否替换` }
}

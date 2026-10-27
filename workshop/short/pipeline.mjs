// short/pipeline.mjs —— 工坊短篇模块：按投稿渠道规格产出「可投真人编辑」的短篇初稿
//
// 2026-10-04 D-127/D-128：工坊原来只有长篇流水线；保底只来自投稿真人编辑，主力形态是 8k–2.5w 字短篇。
// 方法层不自己发明：直接用 oh-story（MIT，7.1k★）的 story-short-write 方法论与它的确定性检查器，
// 本文件只补「把方法论变成可无人值守跑完的流水线」这一截：
//   ① 选题：情报站榜单热词 + 爆款样本 + 题材包招式 → 8 个候选 → 编辑视角打分择一（解决「AI 创意有限」：先发散再按编辑口径收敛）
//   ② 构思：生成 设定.md + 小节大纲.md → oh-story check-phase2-contract.js 机械门禁，失败按 repair_scope 定向修（≤2 轮）
//   ③ 正文：按大纲 2 节/批写，每批带上全部已写正文保证连贯
//   ④ 闸门：normalize-punctuation → check-delivery-contract（字数/节数/格式）→ check-ai-patterns（blocking）→ check-degeneration → opening-gate
//      不过就定向修：字数不足扩已有情节点、超出压复述；AI 腔 blocking 只改命中段
//   ⑤ 编辑试读：按渠道口径给「收/不收」与最大问题；导语不过关重写一次
//   ⑥ 投稿包：标题备选、导语、梗概、渠道规格与核实提示、投稿邮件模板
//
// 产物是给真人修改的初稿，不替人投稿、不替人决定 AI 申报（AGENTS 已裁决表 #1）。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chat, parseJson } from '../lib/llm.mjs'
import { CHANNELS, GENRES, channel, markerText } from './channels.mjs'
import { pickWriterRole, contextCache } from './learning.mjs'
import { refineShort, refreshFinalEvidence } from './refine.mjs'
import { polishShort } from './polish.mjs'
import { qualityReport } from './quality.mjs'
import { buildEvidencePack, sanitizeClaims } from './evidence.mjs'
export { pickWriterRole, polishShort, qualityReport, buildEvidencePack }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL = path.join(HERE, 'oh-story', 'story-short-write')
const REF = (f) => {
  const file = path.join(SKILL, 'references', f)
  if (!fs.existsSync(file)) throw new Error(`缺少短篇技能包文件 short/oh-story/story-short-write/references/${f}：短篇模块需要单独放入 oh-story 技能包（见 README「Optional data」）`)
  return fs.readFileSync(file, 'utf8')
}
const MVP = path.resolve(HERE, '..', '..')
export const SHORTS = process.env.WORKSHOP_SANDBOX ? path.join(path.resolve(process.env.WORKSHOP_SANDBOX), 'shorts') : path.join(MVP, 'projects', 'workshop-shorts')
const INTEL = process.env.WORKSHOP_INTEL || 'data\\intel'
const KNOW = process.env.WORKSHOP_KNOWLEDGE || 'data\\knowledge'
const ROLE = process.env.WORKSHOP_SHORT_ROLE || 'cheap' // 正文/构思用谁；默认便宜档（D-085：贵模型只在便宜档失败时升级）
const JUDGE_ROLE = process.env.WORKSHOP_SHORT_JUDGE || ROLE

export const visibleChars = (s) => [...String(s)].filter((c) => !/\s/u.test(c)).length

// ---------- 小工具 ----------
function runNode(script, args, cwd = SKILL) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 120e3, windowsHide: true })
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}
const tryJson = (s) => { try { return JSON.parse(s) } catch { return null } }

/** 情报站：榜单热词 / 标签 / 日增最快 —— 只取几十个词，进 prompt 当「市场风向」 */
export function trendBrief() {
  const lines = []
  try {
    const dir = path.join(INTEL, 'rank')
    const f = fs.readdirSync(dir).filter((x) => /^fq-digest-\d{8}\.json$/.test(x)).sort().pop()
    if (f) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      for (const [g, v] of Object.entries(j.byGender || {})) {
        lines.push(`${g}书名高频词：${(v.titleWords || []).slice(0, 15).map((x) => x[0]).join('、')}`)
        lines.push(`${g}新书标签：${(v.tags || []).slice(0, 10).map((x) => x[0]).join('、')}`)
        lines.push(`${g}在读日增最快：${(v.risers || []).slice(0, 5).map((x) => '《' + x.t + '》').join('')}`)
      }
      lines.unshift(`（番茄榜单 ${f.slice(10, 18)}）`)
    }
  } catch { /* 情报缺失不阻断 */ }
  try {
    const md = fs.readFileSync(path.join(KNOW, 'shortstory', '爆款短篇样本-20260925.md'), 'utf8')
    const titles = [...new Set(md.match(/《[^》]{6,30}》/g) || [])].filter((t) => !/盐选新书|死亡证明/.test(t)).slice(0, 14)
    if (titles.length) lines.push(`已证实的爆款短篇标题（学结构，不许照抄）：${titles.join('')}`)
  } catch { /* 无样本 */ }
  return lines.join('\n')
}

function genrePack(genre) {
  if (!GENRES.includes(genre)) throw new Error(`题材「${genre}」不在题材包里（可选：${GENRES.join('、')}）`)
  return fs.readFileSync(path.join(SKILL, 'references', 'genre-styles', genre + '.md'), 'utf8')
}

// ---------- 存储 ----------
function newId() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `s${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` }
export const shortDir = (id) => path.join(SHORTS, id)
const W = (id, f, t) => { fs.mkdirSync(shortDir(id), { recursive: true }); fs.writeFileSync(path.join(shortDir(id), f), t, 'utf8') }
const R = (id, f) => { const p = path.join(shortDir(id), f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' }
export function readMeta(id) { return tryJson(R(id, 'meta.json')) || {} }
function saveMeta(id, m) { m.updatedAt = new Date().toISOString(); W(id, 'meta.json', JSON.stringify(m, null, 2)) }
export function listShorts() {
  if (!fs.existsSync(SHORTS)) return []
  return fs.readdirSync(SHORTS).filter((x) => fs.existsSync(path.join(SHORTS, x, 'meta.json'))).map((id) => ({ id, ...readMeta(id) })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

// ---------- 模型调用（统一记账） ----------
async function ask(meta, tag, { system, user, json = false, maxTokens = 6000, temperature = 0.8, role = ROLE }) {
  const r = await chat({ role, system, user, json, maxTokens, temperature, tag: 'short-' + tag, thinking: false })
  meta.cost = +((meta.cost || 0) + (r.cost || 0)).toFixed(5)
  meta.calls = (meta.calls || 0) + 1
  if (!json) return String(r.content || '').trim()
  try { return looseJson(r.content) } catch (e) {
    if (tag.endsWith('-rejson')) throw e
    // 2026-10-04 实测：模型在 JSON 里用「。」当分隔符。先本地修，修不好再让它只重排 JSON 一次
    return ask(meta, tag + '-rejson', { role, temperature: 0, json: true, maxTokens, system: '你只做一件事：把用户给的内容改成合法 JSON，内容一字不改。', user: String(r.content) })
  }
}

/** 宽松 JSON：先原样解析，再修常见的中文标点分隔符 */
export function looseJson(s) {
  try { return parseJson(s) } catch { /* 继续修 */ }
  const t = String(s).replace(/([\]}"\d]|true|false)\s*[。，、；]\s*(?="[^"\n]{1,40}"\s*:)/g, '$1,')
  return parseJson(t)
}

// ---------- ① 选题 ----------
export async function proposeIdeas({ idea = '', channelId, genre, emotion = '' }, meta = {}, onStep = () => {}) {
  const c = channel(channelId)
  const pack = genrePack(genre)
  const head = pack.split(/\n## 对话风格/)[0] // 叙述腔调 + 开篇范式 + 钩子 + 情绪烈度，招式库另取
  const moves = (pack.match(/## 招式库[\s\S]*?(?=\n## )/) || [''])[0].slice(0, 5000)
  onStep('选题：按榜单风向和题材招式发散 8 个候选')
  const sys = `你是短篇网文选题策划，给「${c.name}」供稿。平台基调：${c.tone}。你只出能让编辑在导语三句内就收稿的点子。`
  const user = `【市场风向（情报站当日数据）】\n${trendBrief()}\n\n【题材包：${genre}（节选）】\n${head.slice(0, 6000)}\n\n${moves}\n\n【作者的灵感】${idea || '（无，自由发挥）'}\n【目标情绪】${emotion || '按题材默认'}\n\n出 8 个互相不同的短篇点子。硬要求：
1. 每个点子用题材包里**不同的招式**，写明用的是哪一个；
2. 必须有一个**不可替换的具体物件或数字**（如「彩礼退回的 18.8 万」「B 超单背面的电话」），换个名字就不成立的才算；
3. 情绪钩子优先于谜题钩子：读者 0 秒懂、立刻愤怒/心疼/想看打脸，不需要思考设定；前 3 句零术语；
4. 主角有底牌或后手，不是纯惨；
5. 至少 3 个点子要把一个榜单热词或爆款结构**换场景嫁接**（写明嫁接了什么），不许照抄标题；
6. 标题 ≤ 25 字，主语是人（我/我妈/老公），含极端动作或具体数字。
只输出 JSON：{"ideas":[{"title":"","move":"用的招式","graft":"嫁接了什么或空","object":"不可替换的物件/数字","logline":"主角+困境+反转+情绪落点，一句","first":"正文第一句","reversal":"核心反转一句","emotion":"目标情绪"}]}`
  const j = await ask(meta, 'ideas', { system: sys, user, json: true, maxTokens: 6000, temperature: 1.0 })
  const ideas = (j.ideas || []).filter((x) => x && x.title && x.logline).slice(0, 8)
  if (ideas.length < 3) throw new Error('选题候选不足 3 个，模型输出不合格')
  onStep('选题：编辑视角给 8 个候选打分')
  const judge = await ask(meta, 'ideas-judge', {
    role: JUDGE_ROLE, temperature: 0.2, json: true, maxTokens: 3000,
    system: `你是「${c.name}」的收稿编辑，一天看几百篇导语。你只关心：这个点子写出来，导语能不能让你收。`,
    user: `逐个打分（1-10），标准：秒懂度（3 句内懂，不需要理解设定）、情绪钩子强度（愤怒/心疼/爽，而不是好奇）、新鲜度（不是满大街同款）、物件/数字辨识度、反转可兑现性、贴合平台基调「${c.tone}」。\n\n${ideas.map((x, i) => `#${i} 《${x.title}》\n梗概：${x.logline}\n第一句：${x.first}\n反转：${x.reversal}\n物件：${x.object}`).join('\n\n')}\n\n只输出 JSON：{"scores":[{"i":0,"score":0,"why":"一句话，含最大毛病"}]}`,
  })
  for (const s of judge.scores || []) if (ideas[s.i]) Object.assign(ideas[s.i], { score: Number(s.score) || 0, why: s.why || '' })
  ideas.sort((a, b) => (b.score || 0) - (a.score || 0))
  return ideas
}

// ---------- ② 构思 ----------
function planShape(c) {
  const [lo, hi] = c.sweet
  const mid = Math.round((lo + hi) / 2)
  const sections = mid > 18000 ? 14 : mid > 10000 ? 10 : 7
  return { lo, hi, mid, sections }
}

export async function design(id, onStep = () => {}) {
  const meta = readMeta(id); const c = channel(meta.channelId); const shape = planShape(c)
  const pick = meta.idea
  const sys = `你是短篇网文架构师，按 oh-story 短篇工作流做 Phase 2 构思。输出给机器检查，字段名和表头一个字都不能改。`
  const rules = `${REF('workflow-design.md')}\n\n${REF('writing-workflow.md')}\n\n${REF('submission-craft.md')}\n\n${REF('villain-and-reveal.md').slice(0, 4000)}`
  const user = `【选定点子】《${pick.title}》\n梗概：${pick.logline}\n招式：${pick.move}\n物件/数字：${pick.object}\n第一句：${pick.first}\n反转：${pick.reversal}\n目标情绪：${pick.emotion}\n作者灵感：${meta.userIdea || '无'}\n\n【投稿渠道】${c.name}；平台基调：${c.tone}；小节标记：${markerText(c, 1)}（每节一个）；对话引号：${c.quote === 'yan' ? '「」' : '""'}。
【硬参数】目标字数：${shape.lo}-${shape.hi} 字；节数：${shape.sections} 节；题材参考写 \`references/genre-styles/${meta.genre}.md\`。
【方法论（照此执行）】\n${rules}\n\n【题材包】\n${genrePack(meta.genre).slice(0, 9000)}

按方法论写两份文件，格式要求：
- 设定.md：含「## 短篇核心框架」全部小节（基本信息里写「目标平台：${c.tone}」「目标字数：${shape.lo}-${shape.hi} 字」），以及「## Phase 2 设计校验」块（题材参考、核心招式 2-3 个用「；」分隔、反派设计五字段或「反派设计：不适用（原因）」、反转类型、「反转位置：第 X 节 ÷ 共 ${shape.sections} 节 = Z%」（Z 保留一位小数且算对）、「付费点：第 N 节末」）。不留任何 {} 占位符。
- 小节大纲.md：固定 12 列表头 \`| 结构段/五段功能 | 主事件 | 情节推进 | 情绪 | 人物/关系变化 | 因果/逻辑链 | 读者新获知什么 | 结尾承接/钩子 | 伏笔/物件 | 场景形态 | 对白作用 | 目标字数 |\`，下一行分隔行，再恰好 ${shape.sections} 行数据；「情节推进」每个单元写「具体发生了什么{功能标签}」，多个用 -> 连接，标签只能是 对话/冲突/伏笔/回忆/发现/递进；「目标字数」列只写一个整数，合计落在 ${shape.lo}-${shape.hi}；付费点那一节的「结尾承接/钩子」单元格写上「付费点」三个字，其他行不许出现这三个字；单元格里不许出现竖线 |。
输出格式：先一行 <<<设定.md>>>，接文件全文；再一行 <<<小节大纲.md>>>，接文件全文。不要别的话。`
  // 2026-10-06：上次构思已落盘但门禁没过（多为功能标签写成白名单外的词）→ 先零成本规范化再验一次，过了就不再付费重写
  if (fs.existsSync(path.join(shortDir(id), '设定.md')) && fs.existsSync(path.join(shortDir(id), '小节大纲.md'))) {
    const norm = normalizeOutline(R(id, '小节大纲.md'))
    W(id, '小节大纲.md', norm.text)
    const chk = runNode('scripts/check-phase2-contract.js', ['--json', shortDir(id)])
    if (chk.code === 0) {
      onStep('构思：上次的设定与大纲规范化后已通过门禁，直接沿用（不再花钱）')
      meta.phase2 = { ok: true, round: 'reuse', fails: [] }; meta.stage = 'designed'; saveMeta(id, meta)
      return meta
    }
  }
  onStep('构思：写设定与小节大纲')
  let out = await ask(meta, 'design', { system: sys, user, maxTokens: 9000, temperature: 0.7 })
  for (let round = 0; ; round++) {
    const m = out.match(/<<<设定\.md>>>\s*([\s\S]*?)<<<小节大纲\.md>>>\s*([\s\S]*)$/)
    if (!m) throw new Error('构思输出缺少两个文件分隔标记')
    // 2026-10-06 实测：便宜模型会把「<<<设定.md>>>…<<<小节大纲.md>>>」整段重复输出一遍，第二份被截断；只取第一份
    const outlinePart = m[2].split(/<<<设定\.md>>>/)[0]
    const norm = normalizeOutline(outlinePart.trim() + '\n')
    W(id, '设定.md', m[1].trim() + '\n'); W(id, '小节大纲.md', norm.text)
    if (norm.fixedTags || norm.dropped) { meta.outlineNormalized = [...(meta.outlineNormalized || []), { round, fixedTags: norm.fixedTags, droppedLines: norm.dropped }] }
    const chk = runNode('scripts/check-phase2-contract.js', ['--json', shortDir(id)])
    const rep = tryJson(chk.out) || {}
    const fails = (rep.checks || []).filter((x) => !x.ok)
    meta.phase2 = { ok: chk.code === 0, round, fails: fails.map((f) => f.id) }
    saveMeta(id, meta)
    if (chk.code === 0) break
    if (round >= 2) throw new Error('构思两轮修补后仍未通过 Phase 2 门禁：' + fails.map((f) => `${f.id}（${f.evidence}）`).join('；'))
    onStep(`构思门禁未过（${fails.length} 项），定向修补第 ${round + 1} 轮`)
    out = await ask(meta, 'design-fix', {
      system: sys, temperature: 0.3, maxTokens: 9000,
      user: `下面两份文件没通过机器门禁。只修失败项，其余原样保留。\n\n【失败项】\n${fails.map((f) => `- ${f.id}：现状「${f.evidence}」；要求「${f.expected}」；修法「${f.repair}」`).join('\n')}\n\n<<<设定.md>>>\n${R(id, '设定.md')}\n<<<小节大纲.md>>>\n${R(id, '小节大纲.md')}\n\n按原格式输出两份完整文件（先 <<<设定.md>>> 再 <<<小节大纲.md>>>），不要别的话。`,
    })
  }
  meta.stage = 'designed'; saveMeta(id, meta)
  return meta
}

// 2026-10-06 实测：模型把设定.md 连同第二份大纲一起塞进 小节大纲.md，旧解析把两张表都算进来，
// 10 节大纲变 18 节，正文整段重写一遍、字数超标、闸门必挂。现在与 oh-story 检查器口径一致：只认第一张大纲表。
const ALLOWED_TAGS = ['对话', '冲突', '伏笔', '回忆', '发现', '递进']
const TAG_ALIAS = { 行动: '递进', 动作: '递进', 推进: '递进', 转折: '冲突', 反转: '发现', 揭露: '发现', 揭示: '发现', 悬念: '伏笔', 铺垫: '伏笔', 情绪: '递进', 对白: '对话', 对峙: '冲突', 闪回: '回忆', 高潮: '冲突', 结算: '递进', 收尾: '递进' }
const tableCells = (line) => { const t = line.trim(); return t.startsWith('|') && t.endsWith('|') ? t.slice(1, -1).split('|').map((x) => x.trim()) : null }
const isSep = (cells) => cells.length > 0 && cells.every((x) => /^:?-{3,}:?$/.test(x))
/** 只保留第一张以「结构段/五段功能」开头的大纲表；修正「情节推进」里不在白名单的功能标签（零成本，免一轮付费修补） */
export function normalizeOutline(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const head = lines.findIndex((l) => tableCells(l)?.[0]?.replace(/\*\*/g, '') === '结构段/五段功能')
  if (head < 0) return { text: String(text), fixedTags: 0, dropped: 0 }
  let end = head + 1
  while (end < lines.length && tableCells(lines[end])) end++
  let fixedTags = 0
  const table = lines.slice(head, end).map((l, k) => {
    const cells = tableCells(l)
    if (k === 0 || isSep(cells) || cells.length !== 12) return l
    const steps = cells[2].split(/\s*(?:->|→)\s*/).filter(Boolean).map((s) => {
      const fixed = s.replace(/\{([^{}]*)\}/g, (m, t) => ALLOWED_TAGS.includes(t.trim()) ? `{${t.trim()}}` : (fixedTags++, `{${TAG_ALIAS[t.trim()] || '递进'}}`))
      return /\{(?:对话|冲突|伏笔|回忆|发现|递进)\}/.test(fixed) ? fixed : (fixedTags++, fixed + '{递进}')
    })
    cells[2] = steps.join(' -> ')
    return `| ${cells.join(' | ')} |`
  })
  const before = lines.slice(0, head).join('\n').trim()
  const dropped = lines.slice(end).filter((l) => l.trim()).length
  return { text: (before ? before + '\n\n' : '') + table.join('\n') + '\n', fixedTags, dropped }
}
export function outlineRows(id) {
  const rows = []
  const lines = R(id, '小节大纲.md').split(/\r?\n/)
  const head = lines.findIndex((l) => tableCells(l)?.[0]?.replace(/\*\*/g, '') === '结构段/五段功能')
  if (head < 0) return rows
  for (let i = head + 1; i < lines.length; i++) {
    const cells = tableCells(lines[i])
    if (!cells) break
    if (isSep(cells)) continue
    if (cells.length === 12) rows.push({ cells, target: Number((cells[11].match(/\d+/) || [0])[0]) })
  }
  return rows
}

// ---------- ③ 正文 ----------
export function writerSystem(meta, c) {
  return `你是短篇网文作者，正在写一篇投给「${c.name}」的稿子。下面是必须遵守的写法规范。\n\n${REF('short-craft.md')}\n\n${REF('short-format.md')}\n\n${REF('scene-craft.md')}\n\n【本篇题材包】\n${genrePack(meta.genre)}\n\n【本篇设定（以此为准）】\n${R(meta.id, '设定.md')}`
}
const rowText = (r, n) => `第 ${n} 节｜${r.cells[0]}｜主事件：${r.cells[1]}｜推进：${r.cells[2]}｜情绪：${r.cells[3]}｜关系变化：${r.cells[4]}｜因果：${r.cells[5]}｜读者新获知：${r.cells[6]}｜节末：${r.cells[7]}｜伏笔/物件：${r.cells[8]}｜场景：${r.cells[9]}｜对白作用：${r.cells[10]}｜目标 ${r.target} 字`
export const FORMAT_RULES = (c) => `格式：每节以单独一行「${markerText(c, 'N')}」开头（N 换成节号）；段与段之间只换一行、不留空行；对话用${c.quote === 'yan' ? '「」' : '""'}；全文不出现「……」「——」「—」「--」；不写「导语」二字、不写节标题以外的任何说明；不出现「本章/下一节/情节点/细纲」等工程词。`

export async function draft(id, onStep = () => {}) {
  const meta = readMeta(id); const c = channel(meta.channelId); const rows = outlineRows(id)
  if (!rows.length) throw new Error('小节大纲没有可用的数据行')
  const sys = writerSystem(meta, c)
  const selection = pickWriterRole(meta.genre, { defaultRole: ROLE })
  meta.writerSelections = [...(meta.writerSelections || []), { at: new Date().toISOString(), stage: 'draft', ...selection }]
  let body = ''
  for (let i = 0; i < rows.length; i += 2) {
    const batch = rows.slice(i, i + 2)
    const nums = batch.map((_, k) => i + k + 1)
    onStep(`正文：写第 ${nums.join('、')} 节（共 ${rows.length} 节）`)
    const first = i === 0 ? `第 1 节开头先写 150-220 字导语（就是正文最前面几段，不标「导语」）：四维骨架（起因+核心冲突+人设底色+情绪反转）+ 具体物件+信息差+留白钩子；第一句是事件/动作/信息炸弹，不是环境；前 100 字至少 3 个事件。\n` : ''
    const user = `【全篇大纲】\n${rows.map((r, k) => rowText(r, k + 1)).join('\n')}\n\n【已写正文】\n${body || '（还没写）'}\n\n【这次只写】\n${batch.map((r, k) => rowText(r, nums[k])).join('\n')}\n\n${first}每节字数贴近目标（±15%）；只写大纲批准的情节点，不为凑字加冲突/回忆/配角反应。${FORMAT_RULES(c)}\n直接输出这 ${batch.length} 节正文。`
    let txt = await ask(meta, `draft-${nums.join('-')}`, { role: selection.role, system: sys, user, maxTokens: Math.max(4000, Math.ceil(batch.reduce((s, r) => s + r.target, 0) * 2.2)), temperature: 0.85 })
    txt = normalizeMarkers(txt, c, nums[0])
    // 模型漏写节标记：按段落数平分成本批节数，保证节数守恒（delivery 闸门按大纲节数验）
    const got = (txt.match(/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/gm) || []).length
    if (got !== batch.length) {
      const paras = txt.split('\n').filter((l) => l.trim() && !/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/.test(l.trim()))
      const per = Math.ceil(paras.length / batch.length)
      txt = nums.map((n, k) => `${markerText(c, n)}\n\n${paras.slice(k * per, (k + 1) * per).join('\n')}`).join('\n\n') + '\n'
      meta.markerFixes = (meta.markerFixes || 0) + 1
    }
    body = (body ? body.trimEnd() + '\n\n' : '') + txt.trim() + '\n'
    W(id, '正文.md', body); saveMeta(id, meta)
  }
  meta.stage = 'drafted'; saveMeta(id, meta)
  return meta
}

/** 模型常把节标记写歪（「第1节」「### 1.」「**1.**」）：按顺序重编号成渠道规定的样式，并去掉段间空行 */
export function normalizeMarkers(txt, c, startAt = 1) {
  let n = startAt
  const isMarker = (s) => /^(#{1,4}\s*)?(\*\*)?\s*(第\s*[0-9一二三四五六七八九十百]+\s*[章节]|[0-9]{1,3}\s*[.、．])\s*(\*\*)?\s*$/.test(s) || /^#{1,4}\s*[0-9]{1,3}\s*$/.test(s)
  const out = []
  let lastWasMarker = false // 连着两个标记（「### 2」接「第2节」）只算一节
  for (const raw of String(txt).replace(/\r\n?/g, '\n').split('\n')) {
    const s = raw.trim()
    if (!s) continue
    if (/^(导语|正文)[:：]?$/.test(s)) continue
    if (isMarker(s)) { if (lastWasMarker) continue; if (out.length) out.push(''); out.push(markerText(c, n++)); out.push(''); lastWasMarker = true; continue }
    lastWasMarker = false
    out.push(s)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function splitSections(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n'); const secs = []
  for (const l of lines) {
    if (/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/.test(l.trim())) secs.push({ marker: l.trim(), lines: [] })
    else if (secs.length) secs[secs.length - 1].lines.push(l)
  }
  return secs.map((s) => ({ marker: s.marker, text: s.lines.join('\n').trim() }))
}
export const joinSections = (secs) => secs.map((s) => `${s.marker}\n\n${s.text.trim()}`).join('\n\n') + '\n'

// ---------- ④ 闸门 ----------
export function gates(id) {
  const meta = readMeta(id); const c = channel(meta.channelId); const dir = shortDir(id); const file = path.join(dir, '正文.md')
  runNode('scripts/normalize-punctuation.js', ['--quote-mode', c.quote === 'yan' ? 'yan' : 'ascii', file])
  const rows = outlineRows(id)
  const dc = runNode('scripts/check-delivery-contract.js', ['--json', '--min-chars', String(c.sweet[0]), '--max-chars', String(c.sweet[1]), '--sections', String(rows.length), dir])
  const ai = runNode('scripts/check-ai-patterns.js', ['--json', '--fail-on=blocking', file])
  const dg = runNode('scripts/check-degeneration.js', ['--json', '--fail-on=blocking', file])
  const og = runNode(path.join(HERE, 'opening-gate.mjs'), [file, '--json'], HERE)
  const delivery = tryJson(dc.out) || {}
  const aiF = (tryJson(ai.out)?.findings) || []
  const dgF = (tryJson(dg.out)?.findings) || []
  const open = (tryJson(og.out) || [])[0] || {}
  const res = {
    chars: visibleChars(fs.readFileSync(file, 'utf8')), range: c.sweet, sections: rows.length,
    deliveryOk: dc.code === 0, deliveryFails: (delivery.checks || []).filter((x) => !x.ok).map((x) => ({ id: x.id, evidence: x.evidence })),
    aiBlocking: aiF.filter((f) => f.severity === 'blocking').map((f) => ({ line: f.line, type: f.type, message: f.message, excerpt: f.excerpt })),
    aiAdvisory: aiF.filter((f) => f.severity !== 'blocking').length,
    degenBlocking: dgF.filter((f) => f.severity === 'blocking').map((f) => ({ line: f.line, type: f.type, excerpt: f.excerpt })),
    opening: (open.issues || []).map((x) => `${x.level} ${x.id}`),
  }
  res.pass = res.deliveryOk && !res.aiBlocking.length && !res.degenBlocking.length
  return res
}

/** 不过闸门就定向修：只动出问题的节或段 */
export async function repair(id, onStep = () => {}, maxRounds = 3, askModel = ask) {
  const ask = askModel
  const meta = readMeta(id); const c = channel(meta.channelId); const rows = outlineRows(id); const sys = writerSystem(meta, c)
  // 2026-10-06：旧版大纲解析会多算一张表，正文多出整段重复的节 → 先按大纲节数截掉多余节（零成本）
  const all = splitSections(R(id, '正文.md'))
  if (rows.length && all.length > rows.length) {
    onStep(`闸门：正文 ${all.length} 节多于大纲 ${rows.length} 节，删掉重复的第 ${rows.length + 1}-${all.length} 节`)
    W(id, '正文.md', joinSections(all.slice(0, rows.length)))
    meta.sectionsTrimmed = [...(meta.sectionsTrimmed || []), { at: new Date().toISOString(), from: all.length, to: rows.length }]
    saveMeta(id, meta)
  }
  let g = gates(id)
  for (let round = 1; round <= maxRounds && !g.pass; round++) {
    let secs = splitSections(R(id, '正文.md'))
    const touched = new Set()
    // 漏写/残缺的节（不到目标 40%）：按大纲整节补写到目标字数，不受「每轮最多改 30%」限制
    for (const [k, s] of secs.entries()) {
      const cur = visibleChars(s.text), tgt = rows[k]?.target || 0
      if (!tgt || cur >= tgt * 0.4) continue
      onStep(`闸门：第 ${k + 1} 节只有 ${cur} 字（大纲 ${tgt} 字），按大纲补写`)
      const t = await ask(meta, `fill-${k + 1}`, { system: sys, temperature: 0.7, maxTokens: Math.ceil(tgt * 2.4) + 500, user: `【全篇大纲】\n${rows.map((r, j) => rowText(r, j + 1)).join('\n')}\n\n【前一节结尾】${(secs[k - 1]?.text || '').slice(-600)}\n【后一节开头】${(secs[k + 1]?.text || '').slice(0, 400)}\n\n【本节残稿】\n${s.text || '（空）'}\n\n按大纲第 ${k + 1} 节写完整的一节，约 ${tgt} 字（非空白字符），残稿里能用的句子保留。只写大纲批准的情节点，与前后节衔接，不重复前后节已写的内容。${FORMAT_RULES(c)}只输出本节正文，不要节标记。` })
      secs[k].text = normalizeMarkers(t, c, 1).split('\n').filter((l) => !/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/.test(l.trim())).join('\n').trim()
      touched.add(k)
    }
    if (touched.size) { W(id, '正文.md', joinSections(secs)); g = gates(id); if (g.pass) break; secs = splitSections(R(id, '正文.md')) }
    const lenOff = g.chars < g.range[0] ? 'short' : g.chars > g.range[1] ? 'long' : ''
    if (lenOff) {
      // 按「实际/目标」偏离最大的节先改，一轮最多 3 节
      // 2026-10-04 实测：只改 3 节、贴着边界改，便宜模型每轮只缩 1%，三轮都不收敛。
      // 改为瞄准区间中点、把差额按偏离比例摊给所有偏离方向一致的节，并要求模型按「删掉第几段/哪几句」执行
      const mid = Math.round((g.range[0] + g.range[1]) / 2)
      const gap = Math.abs(g.chars - mid)
      const cand = secs.map((s, k) => ({ k, cur: visibleChars(s.text), tgt: rows[k]?.target || visibleChars(s.text) }))
        .filter((x) => !touched.has(x.k) && (lenOff === 'short' ? x.cur <= x.tgt * 1.05 : x.cur >= x.tgt * 0.95))
      const pool = cand.length ? cand : secs.map((s, k) => ({ k, cur: visibleChars(s.text), tgt: visibleChars(s.text) }))
      const weight = pool.reduce((s, x) => s + x.cur, 0)
      for (const { k, cur } of pool) {
        const delta = Math.min(Math.round(cur * 0.3), Math.ceil(gap * cur / weight))
        if (delta < 60) continue
        const want = lenOff === 'short' ? cur + delta : Math.max(300, cur - delta)
        onStep(`闸门：全文 ${g.chars} 字不在 ${g.range.join('-')}，${lenOff === 'short' ? '扩写' : '压缩'}第 ${k + 1} 节 ${cur}→${want} 字`)
        const t = await ask(meta, `len-${k + 1}`, { system: sys, temperature: 0.6, maxTokens: Math.ceil(want * 2.4) + 500, user: `【大纲】${rows[k] ? rowText(rows[k], k + 1) : ''}\n\n【前一节结尾】${(secs[k - 1]?.text || '').slice(-400)}\n【后一节开头】${(secs[k + 1]?.text || '').slice(0, 300)}\n\n【本节原文】\n${secs[k].text}\n\n本节现在 ${cur} 字，改到 ${want} 字（非空白字符，${lenOff === 'short' ? '要多写' : '要删掉'}约 ${Math.abs(want - cur)} 字）。${lenOff === 'short' ? '只扩写已有情节点的动作、后果、对话和情绪落点，不新增支线、人物或事件。' : '整段整句地删：先删复述前文的句子、重复的情绪解释、无功能的过场和环境，再删可有可无的旁人反应；不删关键证据、反转线索和结算。不要只改措辞。'}保持与前后节衔接。${FORMAT_RULES(c)}只输出本节正文，不要节标记。` })
        secs[k].text = normalizeMarkers(t, c, 1).split('\n').filter((l) => !/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/.test(l.trim())).join('\n').trim()
        touched.add(k)
      }
    }
    if (g.aiBlocking.length || g.degenBlocking.length) {
      // 命中行号 → 所在节；按节重写命中段
      const body = R(id, '正文.md').replace(/\r\n?/g, '\n').split('\n')
      const secOfLine = []; let k = -1
      body.forEach((l) => { if (/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/.test(l.trim())) k++; secOfLine.push(k) })
      const bySec = new Map()
      for (const f of [...g.aiBlocking, ...g.degenBlocking]) { const s = secOfLine[(f.line || 1) - 1]; if (s >= 0 && !touched.has(s)) bySec.set(s, [...(bySec.get(s) || []), f]) }
      for (const [s, fs_] of bySec) {
        onStep(`闸门：第 ${s + 1} 节有 ${fs_.length} 处 AI 腔/退化硬伤，定向去味`)
        const t = await ask(meta, `deslop-${s + 1}`, { system: `${sys}\n\n【去 AI 味规则】\n${REF('short-deslop.md')}`, temperature: 0.5, maxTokens: Math.ceil(visibleChars(secs[s].text) * 2.4) + 500, user: `【本节原文】\n${secs[s].text}\n\n【检测器命中（必须消除）】\n${fs_.map((f) => `- ${f.type}：${f.message || ''}｜原文：${f.excerpt || ''}`).join('\n')}\n\n只改命中的句子和它所在的段，其余逐字保留，字数基本不变。${FORMAT_RULES(c)}只输出本节正文，不要节标记。` })
        secs[s].text = normalizeMarkers(t, c, 1).split('\n').filter((l) => !/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/.test(l.trim())).join('\n').trim()
      }
    }
    W(id, '正文.md', joinSections(secs)); saveMeta(id, meta)
    g = gates(id)
  }
  meta.gates = g; meta.stage = g.pass ? 'gated' : 'gate-failed'; saveMeta(id, meta)
  return g
}

// ---------- ④b 一致性核对（2026-10-04 实测：闸门全过的稿里，第 1 节烧掉的是原件、后文又「翻出原件」，机器闸门抓不到） ----------
export async function consistency(id, onStep = () => {}) {
  const meta = readMeta(id); const c = channel(meta.channelId)
  onStep('一致性核对：查前后矛盾（物件、数字、时间、人物状态）')
  const body = R(id, '正文.md')
  const evidencePack = buildEvidencePack(meta.channelId)
  const j = await ask(meta, 'consistency', {
    role: JUDGE_ROLE, temperature: 0, json: true, maxTokens: 4000,
    system: '你是网文责编，专抓前后矛盾与现实逻辑硬伤：物件去向、数字金额、年份年龄、谁在场、谁知道什么。现实逻辑只报确定的法律、金钱、医疗、程序、常识问题。平台规则、品类、通过率、审核流程、改编、法务类说法只能引用【证据包】原文，格式platformClaims；写作问题必须引用稿件原句。',
    user: `【设定】\n${R(id, '设定.md').slice(0, 2500)}\n\n【全文】\n${body}\n\n【证据包】\n${evidencePack}\n\n只输出 JSON：{"issues":[{"from":"正文里逐字存在的一句","to":"改后的句子","why":"和哪句矛盾"}],"realism":[{"quote":"正文里逐字存在的一句","why":"现实逻辑问题","domain":"法律/金钱/医疗/程序/常识"}],"platformClaims":[{"claim":"平台说法","evidenceId":"证据包条目ID","quote":"证据包逐字原句"}]}。from和quote必须能在全文逐字找到；引不到原句的realism丢掉。`,
  })
  const checked = sanitizeClaims(j, evidencePack)
  const review = checked.value
  review.realism = (Array.isArray(review.realism) ? review.realism : []).filter((x) => x?.quote && body.includes(x.quote) && ['法律', '金钱', '医疗', '程序', '常识'].includes(x.domain))
  let applied = 0; let text = body
  for (const x of (review.issues || []).slice(0, 8)) {
    if (!x?.from || !x?.to || x.from === x.to) continue
    const at = text.indexOf(x.from)
    if (at < 0 || text.indexOf(x.from, at + 1) >= 0) continue // 找不到或不唯一就不动（铁律 8：只按唯一定位改）
    text = text.slice(0, at) + x.to + text.slice(at + x.from.length); applied++
  }
  if (applied) W(id, '正文.md', normalizeMarkers(text, c, 1))
  meta.consistency = { found: (review.issues || []).length, applied, unresolved: (review.issues || []).length - applied, issues: (review.issues || []).slice(0, 8), realism: review.realism, platformClaims: review.platformClaims || [], unverifiedClaims: checked.unverified.length, facts: contextCache(splitSections(text), outlineRows(id)).facts }
  saveMeta(id, meta)
  return meta.consistency
}

// ---------- ⑤ 编辑试读 ----------
export async function editorRead(id, onStep = () => {}) {
  const meta = readMeta(id); const c = channel(meta.channelId)
  const secs = splitSections(R(id, '正文.md'))
  const head = secs.slice(0, 2).map((s) => s.text).join('\n')
  onStep('编辑试读：按渠道口径判收不收')
  const evidencePack = buildEvidencePack(meta.channelId)
  const ask1 = (text) => ask(meta, 'editor', {
    role: JUDGE_ROLE, temperature: 0.2, json: true, maxTokens: 2500,
    system: `你是「${c.name}」的收稿编辑。基调：${c.tone}。你一天看几百篇，导语不行就不往下翻。严格，不客气，不鼓励。平台规则、品类、通过率、审核流程、改编、法务类说法，只能引用【证据包】原文，格式platformClaims:[{claim,evidenceId,quote}]；证据包未覆盖就写「证据包未覆盖」，不许凭记忆说。写作问题必须引用稿件原句。`,
    user: `【设定梗概】${(R(id, '设定.md').match(/### 一句话梗概\s*\n([^\n]+)/) || [, ''])[1]}\n\n【开头两节】\n${head.slice(0, 3500)}\n\n【证据包】\n${evidencePack}\n\n判断：只看导语（前 220 字）你会不会往下翻？看完两节会不会要全文？只输出 JSON：{"hookScore":1-10,"wantFull":true/false,"verdict":"收/再改/不收","biggest":["最致命的 1-3 个问题，要指到原句"],"leadRewriteHint":"导语该怎么改，一句"}`,
  })
  let v = sanitizeClaims(await ask1(head), evidencePack)
  meta.editor = [{ ...v.value, unverifiedClaims: v.unverified.length }]
  // 2026-10-04 实测：7 分「再改」的导语照样放行，第一句是回忆不是事件。门槛提到 8，或编辑没给「收」就重写
  let editorClaims = v.unverified
  v = v.value
  if ((Number(v.hookScore) || 0) < 8 || v.verdict !== '收') {
    onStep(`编辑试读：导语 ${v.hookScore} 分，按意见重写导语一次`)
    const sys = writerSystem(meta, c)
    const t = await ask(meta, 'lead-rewrite', { system: sys, temperature: 0.7, maxTokens: 6000, user: `【第 1 节原文】\n${secs[0].text}\n\n【编辑意见】${(v.biggest || []).join('；')}｜${v.leadRewriteHint || ''}\n\n按意见重写第 1 节开头的导语部分（约前 150-220 字），导语之后的内容尽量保留、只改衔接。第一句必须是事件/动作/信息炸弹，前 3 句零术语，钩子卡在导语最后半句。字数与原节相差不超过 10%。${FORMAT_RULES(c)}只输出第 1 节完整正文，不要节标记。` })
    secs[0].text = normalizeMarkers(t, c, 1).split('\n').filter((l) => !/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/.test(l.trim())).join('\n').trim()
    W(id, '正文.md', joinSections(secs))
    const checkedAgain = sanitizeClaims(await ask1(secs.slice(0, 2).map((s) => s.text).join('\n')), evidencePack)
    v = checkedAgain.value
    editorClaims = editorClaims.concat(checkedAgain.unverified)
    meta.editor.push({ ...v, unverifiedClaims: editorClaims.length })
  }
  meta.unverifiedClaims = (meta.unverifiedClaims || 0) + editorClaims.length
  saveMeta(id, meta)
  return v
}

// ---------- ⑥ 投稿包 ----------
export async function packageShort(id, onStep = () => {}) {
  const meta = readMeta(id); const c = channel(meta.channelId)
  onStep('投稿包：标题备选与梗概')
  const body = R(id, '正文.md')
  const evidencePack = buildEvidencePack(meta.channelId)
  const j0 = await ask(meta, 'package', {
    temperature: 0.7, json: true, maxTokens: 2500,
    system: `你是短篇网文的投稿包装编辑，给「${c.name}」投稿。标题公式：具体身份/关系 + 极端动作 + 具体数字，主语是人，已完成「压制」那半边，不用隐喻。平台规则、品类、通过率、审核流程、改编、法务类说法，只能引用【证据包】原文，格式platformClaims:[{claim,evidenceId,quote}]；未覆盖就写「证据包未覆盖」，不许凭记忆说。写作问题必须引用稿件原句。`,
    user: `【设定】\n${R(id, '设定.md').slice(0, 3000)}\n\n【正文开头】\n${body.slice(0, 1500)}\n\n【证据包】\n${evidencePack}\n\n只输出 JSON：{"titles":["5 个标题，≤25 字"],"synopsis":"给编辑的 200 字内全文梗概，含结局","pitch":"一句话卖点"}`,
  })
  const checkedPackage = sanitizeClaims(j0, evidencePack)
  const j = checkedPackage.value
  meta.unverifiedClaims = (meta.unverifiedClaims || 0) + checkedPackage.unverified.length
  const secs = splitSections(body)
  const lead = (secs[0]?.text || '').split('\n').reduce((acc, l) => (visibleChars(acc) < 200 ? acc + l + '\n' : acc), '')
  const g = meta.gates || gates(id); const ed = (meta.editor || []).slice(-1)[0] || {}
  const md = `# 投稿包：${meta.idea?.title || ''}

> 这是给真人修改的初稿。投稿前请通读改写，按你的实际情况填写 AI 申报。
> 渠道信息采集于 2026-10-04，价格、邮箱、活动期都可能变，投稿前先到官方页面核对一遍。

## 渠道
- 目标：${c.name}
- 价格参考：${c.price}${c.deadline ? `；截止 ${c.deadline}` : ''}
- 投稿入口：${c.contact}
- 独家/一稿多投：${c.exclusive ? '平台明文要求独家首发、禁止一稿多投。这篇投出去后不要再投别家。' : '未找到明文条款，以编辑说明为准。'}
- 证据等级：${c.evidence}。${c.note || ''}

## 标题备选
${(j.titles || []).map((t, i) => `${i + 1}. ${t}`).join('\n')}

## 一句话卖点
${j.pitch || ''}

## 梗概（给编辑）
${j.synopsis || ''}

## 导语（正文前约 200 字）
${lead.trim()}

## 机器检查
- 字数 ${g.chars}（渠道建议 ${c.sweet.join('-')}），${g.sections} 节；格式与字数闸门：${g.deliveryOk ? '通过' : '未通过'}
- AI 腔硬伤 ${g.aiBlocking.length} 处，提示项 ${g.aiAdvisory} 处；退化硬伤 ${g.degenBlocking.length} 处
- 开篇检查：${g.opening.length ? g.opening.join('；') : '无提示'}
- 模型编辑试读：导语 ${ed.hookScore ?? '-'} 分，结论「${ed.verdict || '-'}」。这是模型意见，不代表真人编辑会收。

## 投稿邮件模板
标题：【${meta.genre}】${(j.titles || [meta.idea?.title])[0]}｜${g.chars} 字｜全文
正文：
编辑您好，我是（笔名），投稿一篇${meta.genre}短篇《${(j.titles || [meta.idea?.title])[0]}》，全文 ${g.chars} 字，已完结。
一句话卖点：${j.pitch || ''}
梗概：${j.synopsis || ''}
全文见附件。联系方式：（QQ/微信/手机）。期待您的回复。
`
  W(id, '投稿包.md', md)
  meta.package = j; meta.stage = 'done'; saveMeta(id, meta)
  return { file: path.join(shortDir(id), '投稿包.md') }
}

// ---------- 一键全流程 ----------
export async function createShort({ idea = '', channelId, genre, emotion = '', pickIndex = 0, refineRounds = 2, refineBudget = 3, polishMode = 'rules' }, { onStep = () => {} } = {}) {
  channel(channelId); genrePack(genre)
  if (!Number.isInteger(refineRounds) || refineRounds < 1 || refineRounds > 20) throw new Error('invalid refineRounds')
  if (!Number.isFinite(refineBudget) || refineBudget <= 0 || refineBudget > 10) throw new Error('invalid refineBudget')
  if (!['rules', 'llm'].includes(polishMode)) throw new Error('invalid polishMode')
  const id = newId()
  const meta = { id, createdAt: new Date().toISOString(), channelId, genre, emotion, userIdea: idea, cost: 0, calls: 0, stage: 'ideas', role: ROLE }
  const c = channel(channelId)
  const genreText = String(c.genres || '')
  meta.genreWarning = genreText && !genreText.includes(genre) ? `题材「${genre}」不在${c.name}已列品类中（仅按字面匹配，未确定对应关系）` : ''
  fs.mkdirSync(shortDir(id), { recursive: true })
  const ideas = await proposeIdeas({ idea, channelId, genre, emotion }, meta, onStep)
  meta.ideas = ideas; meta.idea = ideas[Math.min(pickIndex, ideas.length - 1)]
  meta.refineRounds = refineRounds; meta.refineBudget = refineBudget; meta.polishMode = polishMode
  saveMeta(id, meta)
  return resumeShort(id, { onStep })
}

export async function finalRepair(id, onStep = () => {}, { repairStage = repair, refresh = refreshFinalEvidence, gateCheck = gates } = {}) {
  // gates may normalize punctuation; include that change in the section hash comparison.
  const before = R(id, '正文.md')
  try {
    const result = await repairStage(id, onStep, 2)
    await refresh(id, before, { onStep })
    return result
  } catch (e) {
    W(id, '正文.md', before)
    const meta = readMeta(id); meta.gates = gateCheck(id); saveMeta(id, meta)
    throw e
  }
}

/** 从已落盘的阶段接着跑（失败后不重付前面的钱） */
export async function resumeShort(id, { onStep = () => {}, refineRounds, refineBudget, polishMode, stages = {} } = {}) {
  let m = readMeta(id)
  if (!m.idea) throw new Error('这篇还没选定点子，只能重新开')
  const completed = { ...(m.completed || {}) }
  // Migrate earlier metadata without paying for completed legacy stages again.
  if (!m.completed) {
  if (m.phase2?.ok || ['designed', 'drafted', 'gated', 'gate-failed', 'done'].includes(m.stage)) completed.design = true
  if (['drafted', 'gated', 'gate-failed', 'done'].includes(m.stage)) completed.draft = true
  if (m.gates) completed.repair = true
  if (m.consistency) completed.consistency = true
  if (m.editor?.length) completed.editorRead = true
  if (m.refine) completed.refine = true
  if (m.polish?.completed) completed.polish = true
  if (m.quality) completed.quality = true
  if (m.package) completed.package = true
  }
  // 2026-10-06：旧版大纲解析多算节、正文节数多于大纲 → repair 之后的阶段都是在坏稿上做的，从 repair 起重跑（repair 会零成本截掉重复节）
  if (completed.repair && fs.existsSync(path.join(shortDir(id), '正文.md'))) {
    const rowsN = outlineRows(id).length, secsN = splitSections(R(id, '正文.md')).length
    if (rowsN && secsN > rowsN) {
      onStep(`检测到正文 ${secsN} 节多于大纲 ${rowsN} 节（旧版本问题），从闸门修补重新开始`)
      for (const k of ['repair', 'consistency', 'editorRead', 'polish', 'refine', 'finalRepair', 'quality', 'package']) delete completed[k]
    }
  }
  const plan = [
    ['design', () => design(id, onStep)], ['draft', () => draft(id, onStep)],
    ['repair', () => repair(id, onStep)], ['consistency', () => consistency(id, onStep)],
    ['editorRead', () => editorRead(id, onStep)],
    ['polish', () => polishShort(id, { mode: polishMode ?? m.polishMode ?? 'rules', onStep })],
    ['refine', () => refineShort(id, { rounds: refineRounds ?? m.refineRounds ?? 2, budget: refineBudget ?? m.refineBudget ?? 3, onStep })],
    ['finalRepair', () => finalRepair(id, onStep)], ['quality', () => qualityReport(id)],
    ['package', () => packageShort(id, onStep)],
  ]
  for (let i = 0; i < plan.length; i++) {
    const [name, run] = plan[i]
    if (completed[name]) continue
    // A newly executed stage invalidates all downstream checkpoints.
    for (const [later] of plan.slice(i + 1)) delete completed[later]
    m = readMeta(id); m.completed = { ...completed }; saveMeta(id, m)
    await (stages[name] || run)(id)
    completed[name] = true
    m = readMeta(id); m.completed = { ...completed }; saveMeta(id, m)
  }
  // Packaging is billed too; update the cost in the report without another model call.
  if (!stages.quality) qualityReport(id)
  return readMeta(id)
}

export { CHANNELS, GENRES }

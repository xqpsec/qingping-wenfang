// pipeline.mjs —— 都市脑洞长篇流水线 v0.1
// 开书：3 方案（写手模型）→ 用户选 → 设定集（写手模型）→ 前 10 章章纲（便宜模型）
// 写章：节拍（便宜）→ N 个候选并发（写手）→ 本地格式修正 → 机器指标对位爆款 → 成对评审择优（便宜，双向换序）
//       → 胜者评审报告（便宜）→ 定稿 → 摘要与伏笔更新（便宜）
// 每一步产物都落在 work/<章>/，中断后重跑会跳过已完成的步骤。
import fs from 'node:fs'
import path from 'node:path'
import { chat, abortCtl } from './llm.mjs'
const checkStopped = () => { if (abortCtl.signal?.aborted) throw Object.assign(new Error('已停止生成，已完成章节保留'), { aborted: true }) }
import * as P from './prompts.mjs'
import * as S from './store.mjs'
import { makeTracker, bibleCard as bibleCardOf } from './live.mjs'
import { computeMetrics, bandScore, stripMeta } from './metrics.mjs'
import { pairJudge, rubricJudge, VOICE_SEP } from './judge.mjs'
import { ROOT } from './llm.mjs'
import { resolveAgent } from './agents.mjs'
import { resolveStyle, styleRules, styleOfBook, styleById, DEFAULT_ID } from './styles.mjs'
import { pickMemes, memeBlock } from './memes.mjs'
import { voiceBlock, resolveVoice } from './voices.mjs'
import { scanTics, deticBlock, deticPrompt, applyDetic } from './tics.mjs'
import { stripAnnot, findAnnot } from './annot.mjs'

/** 风格 → 榜单分类（都市脑洞取那三个，其余取自己的分类名） */
const styleByIdCats = (id) => styleById(id)?.rankCats || [id]

// 本地知识库（榜单、爆款语料）。Linux 服务器上没有这份目录：缺失时功能降级（榜单参照为空），不报错
export const KNOWLEDGE = process.env.WORKSHOP_KNOWLEDGE || 'data\\knowledge'
const CORPUS = path.join(KNOWLEDGE, 'chapters')
/** 番茄书名硬限制：15 个字符以内，标点也算 */
export const TITLE_MAX = 15
export const titleLen = (t) => [...String(t || '')].length
const BASELINE = path.join(ROOT, 'workshop', 'data', 'baseline-262.json')
const bands = () => JSON.parse(fs.readFileSync(BASELINE, 'utf8')).bands

export const settingsFile = () => process.env.WORKSHOP_SANDBOX ? path.join(path.resolve(process.env.WORKSHOP_SANDBOX), 'settings.json') : path.join(ROOT, 'workshop', 'data', 'settings.json')
export const settings = () => {
  const f = settingsFile()
  // candidateRoles：每个候选用哪个模型写。默认 Claude Sonnet 4.6 + DeepSeek flash 各一版，风格互补，由成对评审择优
  // polish：人工润色器 off / rules / llm；autoPolish：写完每章自动润色出一版候选（不替换定稿，作者在章节页对比后采用）
  // 2026-10-07 主办方：润色默认打开 → 默认 llm + 自动出候选；detic（去 AI 腔定点改写）默认开
  const d = { candidates: 2, words: 2600, outlineBatch: 10, polish: 'llm', autoPolish: true, detic: true, penName: '', coverWidth: 600, coverHeight: 800 } // 封面尺寸默认对标番茄 600×800
  try { return { ...d, ...JSON.parse(fs.readFileSync(f, 'utf8')) } } catch { return d }
}

function log(id, msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`
  console.log(line)
  fs.appendFileSync(S.bookPath(id, 'progress.log'), line + '\n', 'utf8')
}

// ─────────── 开书 ───────────
/** 榜单书名。cats 不传时按都市脑洞那三个分类（旧行为）；传了风格 rankCats 就按它过滤 */
function hitTitles(cats) {
  const want = Array.isArray(cats) && cats.length ? cats : ['都市脑洞', '都市日常', '都市高武']
  const dir = path.join(KNOWLEDGE, 'rank')
  const name = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^now-\d{8}\.jsonl$/.test(x)).sort().at(-1) : ''
  if (!name) return []
  const f = path.join(dir, name)
  return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => want.includes(x.cat)).map((x) => x.title).slice(0, 30)
}

export { hitTitles }

export async function proposeConcepts(idea, styleSel, voice) {
  const st = resolveStyle(styleSel)
  const cats = styleByIdCats(st.id)
  const r = await chat({ task: 'concept', system: P.architectSystem(st.label), user: P.withVoiceConcept(P.conceptPrompt(idea, hitTitles(cats), st), voice), temperature: 0.9, maxTokens: 5000, tag: 'concept' })
  let list = r.content.split(/\n\s*={3,}\s*\n/).map((s) => s.trim()).filter((s) => /书名[:：]/.test(s))
  // 番茄书名上限 15 字（含标点）：超长方案直接剔除
  const okLen = (s) => titleLen(((s.match(/书名[:：]\s*《?([^》\n]+)》?/) || [])[1] || '').trim()) <= TITLE_MAX
  const kept = list.filter(okLen)
  if (list.length && !kept.length) throw new Error(`开书方案的书名全都超过 ${TITLE_MAX} 字（番茄上限，含标点），请重试`)
  list = kept
  return { list, raw: r.content, cost: r.cost }
}

export async function startBook(concept, idea = '', styleSel, opts = {}) {
  const st = resolveStyle(styleSel)
  const title = (concept.match(/书名[:：]\s*《?([^》\n]+)》?/) || [])[1]?.trim() || '未命名'
  // 文风/玩梗模式：开书时选的写进书里，之后在书页随时可改（不传 = 旧行为，book.json 不多字段）
  const extra = {}
  if (opts.voice && resolveVoice(opts.voice).id !== 'auto') extra.voice = resolveVoice(opts.voice).id
  if (opts.memeMode && ['off', 'light', 'heavy'].includes(opts.memeMode) && opts.memeMode !== 'light') extra.memeMode = opts.memeMode
  const book = S.createBook(title, { idea, stage: 'bible', genre: st.id, styleCustom: st.custom || '', style: /白描流/.test(concept.match(/风格[:：].*/)?.[0] || '') ? '白描流' : '吐槽流', ...extra })
  S.writeText(book.id, 'concept.md', concept)
  log(book.id, `开书《${title}》（${st.id === 'custom' ? st.custom.slice(0, 20) : st.label}）：生成设定集…`)
  // opts.onLive：实时看板回调（server 挂到 job.live）。不传 = 旧行为，不走流式
  const tracker = opts.onLive ? makeTracker(opts.onLive, { outlineTotal: settings().outlineBatch }) : null
  // 开书方案里本来就写了主角/金手指：第一帧就亮出来，不让用户对着空白等
  if (tracker) { const c0 = bibleCardOf(concept); delete c0.sections; tracker.setCard({ title, genre: st.id === 'custom' ? '自定义风格' : st.label, ...c0 }) }
  await ensureFoundation(book.id, tracker)
  tracker?.phase('done')
  return S.readBook(book.id)
}

/** 评审用的标签：题材 +（有指定时）文风，让评审按作者选的笔调打分；没选文风时就是题材名（与旧版相同） */
const judgeLabelOf = (id) => { const b = S.readBook(id); const v = resolveVoice(b.voice); return styleOfBook(b).label + (v.id !== 'auto' ? VOICE_SEP + v.label : '') }

/** 本书的主编人格（bible / outline / plan 共用） */
const architectOf = (id) => P.architectSystem(styleOfBook(S.readBook(id)).label)

export async function ensureFoundation(id, tracker = null) {
  const book = S.readBook(id)
  const concept = S.readText(id, 'concept.md')
  if (!S.readText(id, 'bible.md')) {
    tracker?.phase('bible')
    const r = await chat({ task: 'bible', system: architectOf(id), user: P.biblePromptV(concept, book.voice), temperature: 0.7, maxTokens: 7000, tag: 'bible', onDelta: tracker ? (d) => tracker.feed(d) : null })
    S.writeText(id, 'bible.md', concept + '\n\n' + r.content.trim()); S.addCost(id, r.cost)
    log(id, `设定集完成（¥${r.cost.toFixed(3)}）`)
    tracker?.setCard(bibleCardOf(r.content))
  }
  if (tracker) { tracker.live.switched = false; tracker.live.outlineFrom = outlineRows(id).length + 1; tracker.phase('outline') }
  await ensureOutline(id, 1, tracker)
  const b = S.readBook(id); b.stage = 'writing'; S.saveBook(b)
  return book
}

export function outlineRows(id) {
  // 只认 8 个字段齐全的行（模型输出被截断时最后一行常常不完整）
  return S.readText(id, 'outline.md').split('\n').map((l) => l.trim()).filter((l) => /^\d+\s*\|/.test(l) && l.split('|').length >= 8 && l.split('|')[7].trim().length > 4)
}

async function ensureOutline(id, need, tracker = null) {
  let rows = outlineRows(id)
  const batch = settings().outlineBatch
  while (rows.length < need) {
    const from = rows.length + 1; const to = from + batch - 1
    log(id, `生成第 ${from}–${to} 章章纲…`)
    const r = await chat({ task: 'outline', system: architectOf(id), user: P.outlinePrompt(S.readText(id, 'bible.md'), from, to, rows.slice(-3).join('\n')), temperature: 0.7, maxTokens: 12000, tag: 'outline', onDelta: tracker ? (d) => tracker.feed(d) : null })
    const got = r.content.split('\n').map((l) => l.trim().replace(/^第?(\d+)章?\s*[|｜]/, '$1|').replace(/｜/g, '|')).filter((l) => /^\d+\|/.test(l))
    if (!got.length) throw new Error('章纲生成失败：' + r.content.slice(0, 100))
    const fresh = got.filter((l) => Number(l.split('|')[0]) >= from && l.split('|').length >= 8 && l.split('|')[7].trim().length > 4)
    if (!fresh.length) throw new Error('章纲生成不完整，请重试')
    S.writeText(id, 'outline.md', [...rows, ...fresh].join('\n') + '\n')
    S.addCost(id, r.cost)
    rows = outlineRows(id)
  }
  return rows
}

// ─────────── 写章 ───────────
function anchorsFor(n, style, styleId = DEFAULT_ID) {
  // 从都市脑洞爆款里挑 2 段含对白的正文片段（约 450 字），按章号轮换，避免总学同一本
  // 服务器上没有爆款语料库时降级为「不带风格锚」继续写，不能让整条写章链路崩掉（2026-10-02 代理测试在无语料环境实测到 ENOENT）
  // 语料只有都市脑洞那批书：别的风格硬套会把语感带偏，所以只给都市脑洞用（其余返回空）
  if (styleId !== DEFAULT_ID) return []
  const files = fs.existsSync(CORPUS) ? fs.readdirSync(CORPUS).filter((f) => /^262-\d+-\d+\.txt$/.test(f)).sort() : []
  if (!files.length) return []
  const whiteList = ['7658515148906187800', '7623460631303179288', '7624202089656241177', '7666001085177285694', '7649016386907278361']
  const pool = files.filter((f) => (style === '白描流') === whiteList.some((w) => f.includes(w)))
  const use = pool.length >= 2 ? pool : files
  const out = []
  for (let k = 0; k < 2; k++) {
    const f = use[(n * 2 + k * 7) % use.length]
    const body = stripMeta(fs.readFileSync(path.join(CORPUS, f), 'utf8')).split(/\n+/).filter(Boolean)
    const start = Math.floor(body.length * 0.3)
    let s = ''; for (let i = start; i < body.length && s.length < 450; i++) s += body[i] + '\n'
    out.push(s.trim())
  }
  return out
}

/** 本地格式修正（可逆、不删正文字符）：半角标点→全角、去 Markdown、段间空行 */
export function tidy(text) {
  let t = String(text).replace(/\r/g, '')
  t = t.replace(/^```.*$/gm, '').replace(/^\s*[#>*-]+\s*/gm, '').replace(/\*\*/g, '')
  t = t.replace(/([\u4e00-\u9fa5”」])\s*,\s*/g, '$1，').replace(/,\s*([\u4e00-\u9fa5“「])/g, '，$1')
  t = t.replace(/([\u4e00-\u9fa5])\s*\?\s*/g, '$1？').replace(/([\u4e00-\u9fa5])\s*!\s*/g, '$1！').replace(/([\u4e00-\u9fa5])\s*:\s*(?=[“"\u4e00-\u9fa5])/g, '$1：').replace(/([\u4e00-\u9fa5]);/g, '$1；')
  let open = true; t = t.replace(/"/g, () => { const c = open ? '“' : '”'; open = !open; return c })
  const lines = t.split('\n').map((x) => x.trim()).filter(Boolean)
  return lines.join('\n\n') + '\n'
}

/**
 * 去掉写手混进正文的「工作说明」：章名行之前的一切（「我看了修改要求……主要改动：1. …」）、以及章末的「改动说明/修改说明」。
 * 2026-10-01 模拟作者实测：Claude 改写时把工序说明写在章名前面，旧逻辑把它当正文 → 定稿开头混入 AI 自述 + 重复章名，评审也没发现。
 */
export function stripWriterNotes(text) {
  let lines = String(text).replace(/\r/g, '').split('\n')
  const isTitle = (l) => /^\s*第\s*[0-9一二三四五六七八九十百]+\s*章/.test(l)
  const first = lines.findIndex(isTitle)
  if (first > 0) lines = lines.slice(first)
  // 章名重复出现（说明里先写一遍、正文再写一遍）：只留最后一个章名行之后的内容
  const titles = lines.map((l, i) => (isTitle(l) && l.trim().length <= 30 ? i : -1)).filter((i) => i >= 0)
  if (titles.length > 1 && titles.every((i) => i < 12)) lines = lines.slice(titles.at(-1))
  // 章末说明：从「改动说明/修改说明/主要改动/以上为」这类行开始截掉（只在最后 30 行里找，防误伤正文）
  const tail = lines.findIndex((l, i) => i > lines.length - 30 && /^\s*[（(【]?\s*(改动说明|修改说明|主要改动|本次改动|改写说明|以上(为|是)改写|注[:：])/.test(l))
  if (tail > 0) lines = lines.slice(0, tail)
  return lines.join('\n').replace(/\n*[-—*_]{3,}\s*$/, '')
}
/** 正文是否还残留写手自述（给评审报告的硬错误用） */
export const writerNoteRe = /我(看了|已经|先|将|会)?(修改要求|按要求|按照要求|开始(按|改写)|改写如下)|主要改动[:：]|改动说明|以下是(改写|修改)后/

export function splitTitle(text, n) {
  const lines = stripWriterNotes(text).trim().split('\n').filter((x) => x.trim())
  const m = lines[0].match(/^第\s*[0-9一二三四五六七八九十百]+\s*章\s*(.*)$/)
  let title = m ? m[1].trim() : ''
  // 写手偶尔把正文里的一句话（如系统提示「建议以非对抗方式推进收容进程」）当章名：章名原样出现在正文里或过长 → 视为无效，交给调用方用章纲标题
  if (title && (title.length > 15 || lines.slice(1).some((l) => l.includes(title)))) title = ''
  // 段与段之间必须空一行（单换行上传番茄会被压成一坨 = 官方拒签项「格式混乱」）
  const body = dedupeParas((m ? lines.slice(1) : lines).map((x) => x.trim())).join('\n\n')
  return { title, body }
}

/** 应用「原句=>改为」补丁：忽略空白与引号差异定位；「留空/删除」= 删掉该段 */
// 两段文字的相似度（字二元组 Jaccard）：用来认出「换了说法的重复段」
const bigramSim = (x, y) => {
  const g = (s) => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set }
  const A = g(x), B = g(y); if (!A.size || !B.size) return 0
  let inter = 0; for (const k of A) if (B.has(k)) inter++
  return inter / (A.size + B.size - inter)
}
export function applyPatches(text, fix) {
  let t = text; fix.applied = 0
  const norm = (s) => s.replace(/\\n/g, '').replace(/[\s“”"「」]/g, '')
  const deleted = [] // 已删掉的段：模型常把「同一件事的两种说法」都标成重复全删，导致这件事在正文里彻底消失（2026-10-02 豪门总裁实测：火场救人的背景两处都被删）
  for (const p of fix.patches) {
    const isDel = /^[（(]?\s*(留空|删除|删去|空)?\s*[）)]?$/.test(p.to.trim())
    // 2026-10-07 事故：模型把没问题的句子写成「改为：原句（无问题，保留）」，批注被当成修改写进定稿。先剥批注；剥完为空说明这条本来就是「不改」，跳过（绝不能当删除）
    const to = isDel ? '' : stripAnnot(p.to.replace(/\\n/g, '\n')).trim()
    if (!isDel && !to) { fix.annot = (fix.annot || 0) + 1; continue }
    if (!isDel && to !== p.to.trim()) fix.annot = (fix.annot || 0) + 1
    const key = norm(p.from); if (key.length < 4) continue
    if (to !== '' && norm(to) === key) continue // 改前改后相同：关思考后模型偶尔会把「没问题」的句子原样抄一遍，不算改动
    if (to === '') {
      // 删重复：同一段逐字出现 ≥2 次就删最后一次；只出现 1 次时（换了说法的重复），若和已删的某段相似，就保留这段，至少留一处
      const once = norm(t).split(key).length - 1 < 2
      // 阈值 0.2：实测换说法的两段火场描述 0.316，不相关句子 ≤0.016
      if (once && deleted.some((d) => bigramSim(d, key) >= 0.2)) { fix.kept = (fix.kept || 0) + 1; continue }
      deleted.push(key)
    }
    // 在原文上建立「去空白字符 → 原位置」映射，找到最后一次出现（重复内容通常删后面那次）
    const idx = []; let flat = ''
    for (let i = 0; i < t.length; i++) { if (!/[\s“”"「」]/.test(t[i])) { idx.push(i); flat += t[i] } }
    const pos = to === '' ? flat.lastIndexOf(key) : flat.indexOf(key)
    if (pos < 0) continue
    let a = idx[pos]; let b = idx[pos + key.length - 1] + 1
    while (a > 0 && /[“「"]/.test(t[a - 1])) a--
    while (b < t.length && /[”」"]/.test(t[b])) b++
    if (to === '') { const ls = t.lastIndexOf('\n', a); const le = t.indexOf('\n', b); const line = t.slice(ls + 1, le < 0 ? t.length : le); if (norm(line) === norm(t.slice(a, b))) { a = ls + 1; b = le < 0 ? t.length : le + 1 } }
    t = t.slice(0, a) + to + t.slice(b); fix.applied++
  }
  return t
}

/** 删除与前文逐字重复的长段落（≥12 字），番茄会以「大段落重复」拒稿 */
export function dedupeParas(paras) {
  const seen = new Set(); const out = []
  for (const p of paras) {
    const k = p.replace(/\s/g, '')
    if (k.length >= 12 && seen.has(k)) continue
    seen.add(k); out.push(p)
  }
  return out
}

/**
 * 导入的书第一次续写前：用便宜模型从原文摘录整理设定集 + 最近几章摘要（只做一次；失败就抛错，不带空设定硬写）
 * 摘录 = 开头约 2000 字 + 最后 3 章（每章最多 2500 字），约 1 万字输入
 */
export async function ensureImportedFoundation(id, onStep = () => {}) {
  const book = S.readBook(id)
  if (!book.imported || S.readText(id, 'bible.md')) return
  onStep('第一次续写：先读你的原稿，整理设定和前情（约 1 分钟）'); log(id, '导入的书：从原稿整理设定集与前情')
  const chs = book.chapters.filter((c) => c.imported).sort((a, b) => a.n - b.n)
  const body = (c) => S.readText(id, 'chapters', S.pad(c.n) + '.txt').split('\n').slice(1).join('\n').trim()
  const head = chs.length ? body(chs[0]).slice(0, 2000) : ''
  const last = chs.slice(-3)
  const tails = last.map((c) => `【第${c.n}章 ${c.title}】\n${body(c).slice(-2500)}`).join('\n\n')
  const user = `下面是作者已经写好的小说《${book.title}》（共 ${chs.length} 章）的摘录。请**只根据原文**整理，原文没交代的写「原文未交代」，不要编造。

【开头摘录】
${head}

【最近几章（每章取结尾部分）】
${tails}

请按下面格式输出：
## 核心设定
## 主角
## 主要配角
## 反派与阻力
## 世界与现实锚点
## 长线主线（根据已有剧情推断下一阶段可能的走向，标明是推断）
## 文风要求（叙述人称、句子长短、对白多少，各举原文一句）
## 各章摘要
${last.map((c) => `第${c.n}章摘要：（60 字内）`).join('\n')}
## 未回收悬念
（最后一章结束时还没解决的问题，一行一个）`
  const r = await chat({ task: 'bible', system: architectOf(id), user, temperature: 0.3, maxTokens: 7000, tag: 'import-bible' })
  const out = r.content.trim()
  if (!/##\s*主角/.test(out)) throw new Error('从原稿整理设定失败，请再点一次「写下一章」重试')
  S.writeText(id, 'bible.md', `（本书为作者导入的原稿，以下设定由 AI 从原文整理）\n\n${out}`); S.addCost(id, r.cost)
  const b = S.readBook(id)
  for (const c of last) {
    const m = out.match(new RegExp(`第${c.n}章摘要[:：]\\s*(.+)`))
    const row = b.chapters.find((x) => x.n === c.n); if (row && m) row.summary = m[1].trim().slice(0, 120)
  }
  const hooks = (out.split(/##\s*未回收悬念/)[1] || '').trim().split('\n').map((l) => l.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean).slice(0, 6).join('；')
  const lastRow = b.chapters.find((x) => x.n === last.at(-1)?.n); if (lastRow && hooks) lastRow.hooks = hooks
  S.saveBook(b)
  log(id, `原稿设定整理完成（¥${r.cost.toFixed(3)}）`)
}

function recapOf(id, n) {
  const book = S.readBook(id)
  const prev = book.chapters.filter((c) => c.n < n)
  const lines = prev.slice(-12).map((c) => `第${c.n}章 ${c.title}：${c.summary || ''}`)
  return lines.join('\n')
}
function openHooksOf(id, n) {
  const book = S.readBook(id); const c = book.chapters.filter((x) => x.n < n).slice(-4)
  return c.map((x) => x.hooks || '').filter(Boolean).join('；').slice(0, 600)
}

export async function writeChapter(id, n, { onStep = () => {} } = {}) {
  await ensureImportedFoundation(id, onStep)
  const book = S.readBook(id)
  const cfg = settings()
  const W = `work/${S.pad(n)}`
  const rows = await ensureOutline(id, n + 2)
  const outlineRow = rows.find((r) => Number(r.split('|')[0]) === n) || rows[n - 1]
  const bible = S.readText(id, 'bible.md')
  const characterCard = S.readCharacterCard(id)
  const prevText = n > 1 ? S.readText(id, 'chapters', S.pad(n - 1) + '.txt') : ''
  const prevTail = prevText ? prevText.trim().split('\n').filter(Boolean).slice(-6).join('\n') : ''
  const recap = recapOf(id, n)

  // ① 节拍
  let plan = S.readText(id, ...`${W}/plan.md`.split('/'))
  if (!plan) {
    onStep('拆分场景节拍'); log(id, `第${n}章：拆节拍`)
    const r = await chat({ task: 'plan', system: architectOf(id), user: P.planPrompt({ bible: bible + '\n\n【作者人物事实卡】\n' + P.characterCardText(characterCard), outlineRow, recap, prevTail, chapterNo: n, openHooks: openHooksOf(id, n) }), temperature: 0.6, maxTokens: 6000, tag: 'plan' })
    plan = r.content.trim(); S.writeText(id, `${W}/plan.md`, plan); S.addCost(id, r.cost)
  }

  // ② 候选（并发）
  const st = styleOfBook(book)
  const anchors = anchorsFor(n, book.style, st.id)
  const sys = P.writerSystem(styleRules(st), st.label)
  // 网络梗：用户反馈「AI 不会玩梗」（2026-10-02）。设置里 memes:false 可关；古言/年代等时代题材默认不给
  // 玩梗模式按书（book.memeMode：off/light/heavy），设置里 memes:false 仍是全局总开关
  const memeMode = cfg.memes === false ? 'off' : (book.memeMode || 'light')
  const memes = pickMemes(st, `${id}#${n}`, 6, memeMode)
  if (memes.length) { S.writeText(id, `${W}/memes.json`, JSON.stringify(memes.map((m) => m.meme))); log(id, `第${n}章：候选梗${memeMode === 'heavy' ? '（玩梗模式）' : ''} ${memes.map((m) => m.meme).join('、')}`) }
  const heatText = P.heatBlock(book.heat, n)
  if (heatText) log(id, `第${n}章：情绪浓度 ${P.HEAT_LEVELS[book.heat]?.label || book.heat}`)
  // 文风（笔调）：和题材独立；auto = 不注入
  const voiceText = voiceBlock(book.voice)
  if (voiceText) log(id, `第${n}章：文风 ${resolveVoice(book.voice).label}`)
  // 去 AI 腔（2026-10-04，tic-compare 实测依据见 lib/tics.mjs 文件头）。
  // 2026-10-07 主办方点头（"润色这些直接默认打开"）：默认开；设置 detic:false 才关
  const deticOn = cfg.detic !== false
  const user = P.writerPrompt({ bible, characterCard, plan, recap, prevTail, chapterNo: n, outlineRow, anchors, memeText: memeBlock(memes, memeMode), heatText, voiceText, deticText: deticOn ? deticBlock() : '' })
  onStep(`写手同时写 ${cfg.candidates} 个版本`); log(id, `第${n}章：写 ${cfg.candidates} 个候选`)
  await Promise.all(Array.from({ length: cfg.candidates }, async (_, k) => {
    const f = `${W}/cand-${k + 1}.txt`
    if (S.readText(id, ...f.split('/'))) return
    const task = `write${Math.min(4, k + 1)}`
    // 推理型模型（deepseek 等）思考会吃 token，额度给大；Claude 类给 8000 够用
    const isThinker = /deepseek|reason|r1|qwen|glm|kimi/i.test(resolveAgent({ task }).model)
    const r = await chat({ task, system: sys, user, temperature: 0.85 + k * 0.05, maxTokens: isThinker ? 16000 : 8000, tag: `write-c${k + 1}` })
    S.writeText(id, f, tidy(r.content)); S.addCost(id, r.cost)
    // 记下作者模型：评审公正性体检（judge-audit）要用它判断「评审是不是偏爱自家模型」
    S.writeText(id, f.replace(/\.txt$/, '.json'), JSON.stringify({ task, agent: r.agent, model: r.model, cost: r.cost, at: new Date().toISOString() }))
    log(id, `第${n}章：候选 ${k + 1} 完成（${computeMetrics(r.content).chars} 字，¥${r.cost.toFixed(3)}）`)
  }))
  const cands = Array.from({ length: cfg.candidates }, (_, k) => S.readText(id, ...`${W}/cand-${k + 1}.txt`.split('/'))).filter(Boolean)
  if (!cands.length) throw new Error('没有生成任何候选稿')

  // ③ 机器指标
  const b = bands()
  const mach = cands.map((t) => { const m = computeMetrics(t); return { m, ...bandScore(m, b) } })

  // ④ 成对择优（淘汰赛）
  onStep('评审员对比各版本'); log(id, `第${n}章：成对评审`)
  let judge = S.readJson(id, `${W}/judge.json`)
  if (!judge) {
    let best = 0; const bouts = []
    for (let k = 1; k < cands.length; k++) {
      const r = await pairJudge(cands[best], cands[k], { context: recap.slice(-800), styleLabel: judgeLabelOf(id) })
      S.addCost(id, r.cost)
      // 平局时用机器对位分决胜；字数不足 2000 的直接判负
      let w = r.winner
      const short = (i) => mach[i].m.chars < 2000
      if (short(best) !== short(k)) w = short(best) ? 1 : 0
      else if (w === -1) w = mach[k].score > mach[best].score ? 1 : 0
      bouts.push({ a: best + 1, b: k + 1, judge: r.winner, final: w, reasons: r.reasons })
      if (w === 1) best = k
    }
    judge = { winner: best + 1, bouts, machine: mach.map((x) => ({ score: x.score, hard: x.hard, chars: x.m.chars })) }
    S.writeText(id, `${W}/judge.json`, JSON.stringify(judge, null, 2))
  }
  // ④b 逻辑硬伤自检：便宜模型找矛盾，只输出「原句=>改句」，本地逐条替换（不整章重写，不花写手的钱）
  let winText = cands[judge.winner - 1]
  let fix = S.readJson(id, `${W}/fix.json`)
  if (!fix) {
    onStep('检查前后矛盾'); log(id, `第${n}章：逻辑自检`)
    fix = { patches: [], applied: 0 }
    try {
      const r = await chat({ task: 'fix', system: '你是网文责编，专抓硬伤。', user: P.fixPrompt({ bible, recap, prevTail, text: winText }), temperature: 0.1, maxTokens: 16000, tag: 'fix', thinking: false })
      S.addCost(id, r.cost)
      for (const line of r.content.split('\n')) {
        const m = line.match(/^\s*原句[:：](.+?)\s*=>\s*改为[:：](.*)$/)
        if (m && m[1].trim().length >= 4) fix.patches.push({ from: m[1].trim(), to: m[2].trim() })
      }
    } catch (e) { fix.error = e.message }
    fix.text = applyPatches(winText, fix)
    S.writeText(id, `${W}/fix.json`, JSON.stringify(fix, null, 2))
  }
  if (fix.text) winText = fix.text
  // ④c 去 AI 腔定点改写：本地标出口癖句，只把这些句子送便宜模型改，逐句替换（不整章重写）
  if (deticOn) {
    let dt = S.readJson(id, `${W}/detic.json`)
    if (!dt) {
      const before = scanTics(winText)
      dt = { before: { perK: before.perK, total: before.total, flagged: before.flagged.length }, patches: [], applied: 0 }
      if (before.flagged.length >= 3) {
        onStep(`去 AI 腔：改写 ${before.flagged.length} 句`); log(id, `第${n}章：去 AI 腔，标出 ${before.flagged.length} 句`)
        try {
          const r = await chat({ task: 'fix', system: '你是番茄小说的资深责编，专改 AI 腔，让文字像真人网文作者写的。', user: deticPrompt(winText, before.flagged, { bible }), temperature: 0.6, maxTokens: 8000, tag: 'detic', thinking: false })
          S.addCost(id, r.cost); dt.cost = r.cost
          for (const line of r.content.split('\n')) {
            const m = line.match(/^\s*(?:\d+[.、]\s*)?原句[:：](.+?)\s*=>\s*改为[:：](.*)$/)
            if (m && m[1].trim().length >= 4) dt.patches.push({ from: m[1].trim(), to: m[2].trim() })
          }
        } catch (e) { dt.error = e.message }
        const ap = applyDetic(winText, before.flagged, dt.patches); dt.applied = ap.applied; dt.rejected = ap.rejected
        const out = ap.text
        const after = scanTics(out)
        // 只在确实变好、且没把正文删短超过 3% 时采用
        const shrink = 1 - computeMetrics(out).chars / Math.max(1, computeMetrics(winText).chars)
        dt.after = { perK: after.perK, total: after.total, flagged: after.flagged.length }
        dt.used = after.total < before.total && shrink < 0.03
        if (dt.used) dt.text = out
      }
      S.writeText(id, `${W}/detic.json`, JSON.stringify(dt, null, 2))
    }
    if (dt.used && dt.text) { winText = dt.text; log(id, `第${n}章：AI 腔 ${dt.before.perK}→${dt.after.perK} 处/千字`) }
  }
  // 定稿前兜底：任何一步漏进来的审稿批注（「（无问题，保留）」「（注：…）」）一律剥掉并记日志
  const leak = findAnnot(winText)
  if (leak.length) { winText = stripAnnot(winText); log(id, `第${n}章：剥掉 ${leak.length} 处审稿批注（${leak[0].text}…）`) }
  const sp = splitTitle(winText, n)
  const body = sp.body
  const title = sp.title || (outlineRow.split('|')[1] || '').trim()

  // ⑤ 评审报告（给作者看，不参与择优）
  onStep('生成评审报告'); log(id, `第${n}章：评审报告`)
  let report = S.readJson(id, `${W}/report.json`)
  if (!report) {
    try { report = await rubricJudge(winText, { chapterNo: n, context: recap.slice(-800), styleLabel: judgeLabelOf(id) }); S.addCost(id, report.cost); delete report.raw } catch (e) { report = { error: e.message } }
    report.machine = mach[judge.winner - 1]; report.at = new Date().toISOString(); report.textHash = S.bodyHash(`第${n}章 ${title}\n\n${body.trim()}\n`)
    S.writeText(id, `${W}/report.json`, JSON.stringify(report, null, 2))
  }

  // ⑥ 摘要
  onStep('更新前情与伏笔'); log(id, `第${n}章：更新摘要`)
  let sum = S.readText(id, ...`${W}/summary.md`.split('/'))
  if (!sum) { const r = await chat({ task: 'summary', user: P.summaryPrompt(body, n), temperature: 0.2, maxTokens: 4000, tag: 'summary' }); sum = r.content.trim(); S.writeText(id, `${W}/summary.md`, sum); S.addCost(id, r.cost) }
  const pick = (k) => (sum.match(new RegExp(`${k}[:：]\\s*([\\s\\S]*?)(?=\\n[^\\n]{2,6}[:：]|$)`)) || [])[1]?.trim() || ''

  checkStopped()
  S.commitChapter(id, n, `第${n}章 ${title}\n\n${body.trim()}\n`, {
    title: title || (outlineRow.split('|')[1] || ''), chars: computeMetrics(body).chars, summary: pick('摘要'), hooks: pick('未回收悬念').replace(/\n/g, '；'),
    hookType: pick('章末钩子类型'), payoffType: pick('爽点类型'), score: report.total ?? null, readNext: report.readNext ?? null, machineScore: mach[judge.winner - 1].score, winner: judge.winner, candidates: cands.length,
  })
  log(id, `第${n}章定稿：《${title}》评分 ${report.total ?? '—'}，追读意愿 ${report.readNext ?? '—'}%`)
  // ⑦ 可选：人工润色器出一版候选（失败不影响定稿）
  if (cfg.autoPolish && cfg.polish && cfg.polish !== 'off' && !S.readText(id, ...`${W}/polished.txt`.split('/'))) {
    onStep('人工润色器出一版候选')
    try { const { polishChapter } = await import('./polish.mjs'); const r = await polishChapter(id, n, cfg.polish); log(id, `第${n}章：润色候选完成（${r.note}）`) } catch (e) { log(id, `第${n}章：润色失败 —— ${String(e.message).split('\n')[0].slice(0, 120)}`) }
  }
  return S.readBook(id).chapters.find((c) => c.n === n)
}

export async function writeNext(id, count = 1, opts = {}) {
  const out = []
  for (let i = 0; i < count; i++) {
    checkStopped()
    const n = (S.readBook(id).chapters.at(-1)?.n || 0) + 1
    out.push(await writeChapter(id, n, opts))
  }
  return out
}

/**
 * 按作者意见改写某章（v1.2：改写稿只是「候选」，不直接替换定稿）
 * 流程：写手改写 → 存 work/NNNN/revision.json → 同一个评审、同一时刻、同一份前情，给「改前 / 改后」两版同时重新打分
 *       + 成对比较（双向换序）→ 界面并排显示，作者点「采用」才替换定稿，点「放弃」定稿保持不变。
 * 为什么：v1.1 改写后直接覆盖定稿再单独打分，改前分数是旧时间、旧状态下打的，两个分数不可比；
 *        而且改坏了只能去旧版本里翻（旧版本还不带分数）。
 */
export async function reviseChapter(id, n, instruction, { onStep = () => {} } = {}) {
  const cur = S.readText(id, 'chapters', S.pad(n) + '.txt')
  if (!cur) throw new Error(`第${n}章还没有定稿`)
  const book = S.readBook(id)
  const report = S.readJson(id, `work/${S.pad(n)}/report.json`, {})
  const characterCard = S.readCharacterCard(id)
  const ins = instruction || [report.worst, ...(report.fixes || [])].filter(Boolean).join('\n')
  if (!ins.trim()) throw new Error('没有改写意见：请填写意见，或先生成评审报告再按建议改写')
  const W = `work/${S.pad(n)}`
  const prev = S.readJson(id, `${W}/revision.json`)
  if (prev) archiveRevision(id, n, prev, 'superseded') // 上一版没决定的改写稿归档，不丢
  onStep('写手按意见改写中（约 1–2 分钟）')
  const st = styleOfBook(book)
  const r = await chat({ task: 'revise', system: P.writerSystem(styleRules(st), st.label), user: `【全书设定】\n${S.readText(id, 'bible.md')}\n\n【人物事实卡】\n${P.characterCardText(characterCard)}\n\n【人物一致性硬规则】\n人物行动必须符合事实卡；如需改变立场，写出触发事件和过程，不得突然转弯。\n\n【当前第${n}章正文】\n${cur}\n\n【修改要求】\n${ins}\n\n${voiceBlock(S.readBook(id).voice)}${P.heatBlock(S.readBook(id).heat, n)}请按修改要求改写本章，保留原有情节走向和章末钩子，只改需要改的地方，其余尽量保持原句。输出完整的新版本正文（第一行“第${n}章 章名”），2400–2900 字。`, temperature: 0.7, maxTokens: 8000, tag: 'revise' })
  S.addCost(id, r.cost)
  const old = book.chapters.find((c) => c.n === n) || {}
  const { title: t0, body } = splitTitle(tidy(r.content), n)
  const outlineTitle = (outlineRows(id).find((x) => Number(x.split('|')[0]) === n) || '').split('|')[1]?.trim() || ''
  // 旧章名本身就是坏的（被正文句子顶替过）时，改用章纲标题
  const oldOk = old.title && old.title.length <= 15 && !cur.split('\n').slice(1).some((l) => l.includes(old.title))
  const title = t0 || (oldOk ? old.title : outlineTitle || old.title)
  const text = `第${n}章 ${title}\n\n${body.trim()}\n`
  // 改写稿先落盘（花了写手的钱，后面评审失败也不能丢）
  const rev = { at: new Date().toISOString(), instruction: ins, cost: +r.cost.toFixed(4), baseHash: hash(cur), text, title, chars: computeMetrics(body).chars }
  S.writeText(id, `${W}/revision.json`, JSON.stringify(rev, null, 2))
  log(id, `第${n}章：改写稿完成（¥${r.cost.toFixed(3)}），等待对比评审`)
  await compareRevision(id, n, { onStep })
  return S.readJson(id, `${W}/revision.json`)
}

/**
 * 评审误差：取最近一次 judge-audit 里「评审报告」所用 agent 的重测极差（同一章连打 3 次的最高-最低）。
 * 没有体检数据时默认 8 分（2026-10-01 实测：deepseek-flash 极差 6，deepseek-v4-pro 极差 14）。
 */
export function judgeNoise() {
  try {
    const dir = path.join(ROOT, 'workshop', 'data', 'judge-audit')
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort().pop()
    const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    // 取「重测极差」和「旧分→重打漂移」中较大的：只重测 3 次会低估波动（模拟用户实测看到同一版差 9 分）
    const c = a.checks?.[resolveAgent({ task: 'rubric' }).id]
    const r = Math.max(c?.retest?.range ?? -1, c?.drift?.maxAbs ?? -1)
    if (r >= 0) return Math.max(5, r)
  } catch { /* 无体检数据 */ }
  return 8
}

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(16) }

/**
 * 公平对比：改前、改后两版在同一时刻、同一评审 agent、同一前情提要下各打一次分，再做双向换序的成对比较。
 * 打分只用于对比，不写入定稿的分数（采用后才写入）。可单独重跑（评审失败时）。
 */
export async function compareRevision(id, n, { onStep = () => {} } = {}) {
  const W = `work/${S.pad(n)}`
  const rev = S.readJson(id, `${W}/revision.json`)
  if (!rev) throw new Error('没有待对比的改写稿')
  const cur = S.readText(id, 'chapters', S.pad(n) + '.txt')
  if (hash(cur) !== rev.baseHash) rev.stale = '改写之后定稿又被改过（手改/回滚/采用别的版本），对比的「改前」是当前定稿'
  const ctx = recapOf(id, n).slice(-800)
  const st = styleOfBook(S.readBook(id))
  onStep('同一个评审同时给改前、改后打分（约 1 分钟）')
  const [a, b, p] = await Promise.all([
    rubricJudge(cur, { chapterNo: n, context: ctx, styleLabel: judgeLabelOf(id) }).catch((e) => ({ error: e.message })),
    rubricJudge(rev.text, { chapterNo: n, context: ctx, styleLabel: judgeLabelOf(id) }).catch((e) => ({ error: e.message })),
    pairJudge(cur, rev.text, { context: ctx, styleLabel: judgeLabelOf(id) }).catch((e) => ({ error: e.message })),
  ])
  for (const x of [a, b, p]) { if (x.cost) S.addCost(id, x.cost); delete x.raw }
  const mb = bands()
  a.machine = bandScore(computeMetrics(cur), mb); b.machine = bandScore(computeMetrics(rev.text), mb)
  // pair.winner：0=改前 1=改后 -1=两次换序结论不一致（差不多）
  const verdict = p.error ? '对比失败' : p.winner === 1 ? '改后更好' : p.winner === 0 ? '改前更好' : '差不多（两次换序结论不一致）'
  // 一句话建议：总分差、追读差、成对比较三个信号合并。评审重测本身有几分波动（judge-audit 实测），差距小于 NOISE 视为「没差别」
  const NOISE = judgeNoise()
  // 改动幅度：按段落比，多少段原样保留 / 改了 / 新增 / 删除（让作者知道写手到底改了多少，模拟用户曾以为「改写没生效」）
  const paras = (t) => t.split('\n').slice(1).map((x) => x.trim()).filter(Boolean)
  const pa = paras(cur), pb = paras(rev.text), setA = new Set(pa), setB = new Set(pb)
  rev.diff = { kept: pb.filter((x) => setA.has(x)).length, added: pb.filter((x) => !setA.has(x)).length, removed: pa.filter((x) => !setB.has(x)).length, before: pa.length, after: pb.length }
  // 逐段列出改动位置（模拟用户实测：只给「12 段被删或改」不给位置，作者无法核对写手是否越权改了别处）
  rev.diff.changes = paraChanges(pa, pb).slice(0, 60)
  const dTotal = a.total != null && b.total != null ? b.total - a.total : null
  const dRead = a.readNext != null && b.readNext != null ? b.readNext - a.readNext : null
  const advice = revisionAdvice({ dTotal, dRead, pairWinner: p.error ? null : p.winner, noise: NOISE })
  rev.checks = instructionChecks(rev.instruction, rev.diff.changes, rev.text)
  Object.assign(rev, { compare: { at: new Date().toISOString(), before: a, after: b, pair: p, verdict, advice, dTotal, dRead, noise: NOISE, sameJudge: true } })
  S.writeText(id, `${W}/revision.json`, JSON.stringify(rev, null, 2))
  log(id, `第${n}章：改前 ${a.total ?? '失败'} 分 / 改后 ${b.total ?? '失败'} 分，成对比较：${verdict}`)
  return rev
}

/**
 * 段落级 diff（LCS），返回改动块：{ at: 原稿第几段(1起), del: [原稿段], add: [改后段] }。
 * del 与 add 都有 = 这里的段被改写；只有 del = 删掉；只有 add = 新写。
 */
export function paraChanges(pa, pb) {
  const m = pa.length, k = pb.length
  if (m * k > 4e6) return [{ at: 1, del: ['（段落太多，未逐段比较）'], add: [] }]
  const L = Array.from({ length: m + 1 }, () => new Int32Array(k + 1))
  for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) L[i][j] = pa[i] === pb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out = []; let i = 0, j = 0, blk = null
  const flush = () => { if (blk) { out.push(blk); blk = null } }
  while (i < m || j < k) {
    if (i < m && j < k && pa[i] === pb[j]) { flush(); i++; j++ }
    else if (j < k && (i >= m || L[i][j + 1] >= L[i + 1][j])) { (blk ||= { at: i + 1, del: [], add: [] }).add.push(pb[j]); j++ }
    else { (blk ||= { at: i + 1, del: [], add: [] }).del.push(pa[i]); i++ }
  }
  flush(); return out
}

/**
 * 改前改后的一句话建议（纯函数，test.mjs 覆盖）。三个信号：总分差、追读差（按一半计）、成对比较（1=改后 0=改前 -1=平）。
 * 差距小于 noise 视为没差别；弱信号（总分、追读都在误差内但同向）与成对比较相反时判为矛盾，不替作者下结论。
 */
export function revisionAdvice({ dTotal, dRead, pairWinner, noise }) {
  // 边界：|分差| === noise 仍算「在误差内」（页面写的是「以内」，不是「超过」）。旧写法用 >=，分差恰好 -8 会被说成「超过 ±8」。
  const sig = (d) => (d == null ? 0 : d > noise ? 1 : d < -noise ? -1 : 0)
  const votes = [sig(dTotal), sig(dRead == null ? null : dRead / 2), pairWinner === 1 ? 1 : pairWinner === 0 ? -1 : 0]
  const weak = Math.sign(dTotal ?? 0) + Math.sign(dRead ?? 0)
  const onEdge = (dTotal != null && Math.abs(dTotal) === noise) || (dRead != null && Math.abs(dRead) === noise * 2)
  if ((!votes[0] && !votes[1] && votes[2] && Math.abs(weak) === 2 && Math.sign(weak) !== votes[2]) || (onEdge && votes[2] && Math.sign(dTotal ?? 0) && Math.sign(dTotal) !== votes[2])) votes.push(-votes[2])
  const pos = votes.filter((v) => v > 0).length, neg = votes.filter((v) => v < 0).length
  // 只有分数信号、二选一判不出（平）时，降一级说法，避免「结论：改后更好」与「二选一：差不多」并排出现
  if (pos && !neg && pairWinner !== 1) return { level: 'better', text: '改后分数明显更高，倾向采用；但把两版放一起二选一时评审没分出高下，建议你读一下改写稿再定' }
  return pos && !neg ? { level: 'better', text: '改后更好：建议采用' }
    : neg && !pos ? { level: 'worse', text: '改后更差：建议放弃，保留原稿' }
      : pos && neg ? { level: 'mixed', text: '几个信号互相矛盾（见下方明细），评审判不准，请你自己读一下两版再决定' }
        : { level: 'same', text: `两版差别在评审误差范围内（±${noise} 分），采用与否看你自己的喜好` }
}

/** 把作者写在改写意见里的逐条要求，和段落 diff 对一下：删了哪句、正文里还在不在。纯函数。 */
export function instructionChecks(instruction, changes, afterText) {
  const lines = String(instruction || '').split(/[\n；;]+/).map((s) => s.replace(/^\s*(?:\d+[.、．)]\s*|[-*]\s*)/, '').trim()).filter(Boolean)
  const del = (changes || []).flatMap((c) => c.del || [])
  const add = (changes || []).flatMap((c) => c.add || [])
  const body = String(afterText || '')
  const seen = new Set()
  const out = []
  for (const line of lines) {
    const matches = [...line.matchAll(/「([^」]+)」|『([^』]+)』|“([^”]+)”|"([^"]+)"/g)]
    const bits = matches.map((m) => m.slice(1).find(Boolean))
    const preserve = /(?:保留|保持|不改|不动|不要删|不能删|原样)/.test(line)
    if (!bits.length) {
      out.push({ quote: '', state: 'both', text: `待人工验收：${line}（结构、位置和语义未自动判定）` })
      continue
    }
    if (preserve) {
      for (const q of bits) out.push({ quote: q, state: 'both', text: `要求保留的「${q}」${String(body).normalize('NFKC').replace(/[\s\p{P}]+/gu, '').includes(String(q).normalize('NFKC').replace(/[\s\p{P}]+/gu, '')) ? '仍可找到（忽略空白与标点差异）' : '未找到'}；请核对上下文是否保持原意` })
      continue
    }
    const insertion = /(?:新增|添加|加入|加上|补充|补上|插入)/.test(line) && !/(?:不要|不用|无需|禁止|不必)\s*(?:新增|添加|加入|加上|补充|补上|插入)/.test(line)
    for (const [qi, quoted] of bits.entries()) {
    const prefix = line.slice(0, matches[qi].index)
    const suffix = line.slice(matches[qi].index + matches[qi][0].length)
    const target = /(?:改成|改为|替换为|合并成|补一句|加一句|补上|新增|添加)[^「『“"\n]*$/.test(prefix)
    const anchor = /^(?:那行|这行|那句|这句|旁边|附近)/.test(suffix) && !/(?:删|去掉|移除|替换|改掉|挪|移动)/.test(prefix)
    const normalized = s => String(s).normalize('NFKC').replace(/[\s\p{P}]+/gu, '')
    const paragraphs = body.split(/\n+/).filter(s => s.trim())
    const positions = paragraphs.map((p, i) => normalized(p).includes(normalized(quoted)) ? i + 1 : 0).filter(Boolean)
    const location = positions.length ? `（改写稿非空行 ${positions.join('、')}）` : '（完整引文字面未匹配；可在全文中搜索短片段）'
    if (anchor) { out.push({ quote: quoted, state: 'both', text: `定位用引文「${quoted}」${positions.length ? '可找到' : '未完整匹配'}${location}；不判定新增或删除` }); continue }
    if (target && !insertion) { out.push({ quote: quoted, state: 'both', text: `目标新句「${quoted}」${positions.length ? '可找到' : '未完整匹配'}${location}；位置和语义待人工验收` }); continue }
    if (seen.has(line + quoted)) continue
    seen.add(line + quoted)
    const removed = del.some((d) => d.includes(quoted))
    const still = positions.length > 0
    if (insertion) {
      out.push({ quote: quoted, state: 'both', text: still
        ? `要求新增的「${quoted}」在改写稿里可找到${location}；仅核对文字出现，请自行确认位置和语义`
        : `要求新增的「${quoted}」完整引文字面未匹配${location}；短词出现与完整句匹配是不同检查，措辞变化请人工核对` })
      continue
    }
    if (!/(?:删|去掉|移除|替换|改掉|改为|改成|挪|移动)/.test(line)) {
      out.push({ quote: quoted, state: 'both', text: `待人工验收：${line}（引文${still ? '可找到' : '未找到'}，未推断删改意图）` })
      continue
    }
    if (still && /(?:第二次|第[二三四五六七八九十\d]+处|重复|多余)/.test(line) && removed) {
      const count = list => list.reduce((sum, p) => sum + normalized(p).split(normalized(quoted)).length - 1, 0)
      const reduction = count(del) - count(add)
      if (reduction > 0) { out.push({ quote: quoted, state: 'both', text: `重复引文「${quoted}」在差异中减少 ${reduction} 处，改写稿仍可找到${location}；请核对删掉的是否为指定那次，不要求全部删除` }); continue }
    }
    out.push(still ? { quote: quoted, state: 'still', text: `待删改引文「${quoted}」仍可找到${location}；段落有改动不代表这句已删除，请核对` }
      : removed ? { quote: quoted, state: 'gone', text: `意见里的「${quoted}」已从原稿删掉，改写稿里没有${location}` }
        : { quote: quoted, state: 'both', text: `待删改引文「${quoted}」完整引文字面未匹配${location}；未确认原稿包含该完整句，不推断已删除` })
    }
  }
  return out
}

/** 采用改写稿：旧定稿（连同分数、评审报告）进旧版本，改写稿成为定稿，分数取对比时的「改后」分 */
export function adoptRevision(id, n) {
  const W = `work/${S.pad(n)}`
  const rev = S.readJson(id, `${W}/revision.json`); if (!rev) throw new Error('没有待采用的改写稿')
  const old = S.readBook(id).chapters.find((c) => c.n === n) || {}
  const after = rev.compare?.after
  const ok = after && !after.error
  const prevScore = rev.compare?.before?.total != null ? `${rev.compare.before.total}分` : '未评分'
const nextScore = ok && after.total != null ? `${after.total}分` : '未评分'
S.commitChapter(id, n, rev.text, { ...old, title: rev.title, chars: rev.chars, score: ok ? after.total : null, readNext: ok ? after.readNext : null, machineScore: after?.machine?.score ?? old.machineScore, revised: (old.revised || 0) + 1, adoptedFrom: 'revision', adoptedAt: new Date().toISOString() }, { reason: `采用改写稿（对比时改前${prevScore}→改后${nextScore}）` })
  if (ok) { const rep = { ...after, at: rev.compare.at, from: 'revision', textHash: S.bodyHash(rev.text) }; S.writeText(id, `${W}/report.json`, JSON.stringify(rep, null, 2)) }
  else fs.rmSync(S.bookPath(id, 'work', S.pad(n), 'report.json'), { force: true })
  archiveRevision(id, n, rev, 'adopted')
  log(id, `第${n}章：采用改写稿${ok ? `（${after.total} 分）` : '（未评分，请重做评审报告）'}`)
}

/** 放弃改写稿：定稿不动，改写稿归档（以后还能在 work 目录找到） */
export function discardRevision(id, n) {
  const rev = S.readJson(id, `work/${S.pad(n)}/revision.json`); if (!rev) throw new Error('没有待放弃的改写稿')
  archiveRevision(id, n, rev, 'discarded'); log(id, `第${n}章：放弃改写稿，定稿不变`)
}
function archiveRevision(id, n, rev, how) {
  const W = `work/${S.pad(n)}`
  S.writeText(id, `${W}/revisions/${Date.now()}-${how}.json`, JSON.stringify({ ...rev, outcome: how }, null, 2))
  fs.rmSync(S.bookPath(id, 'work', S.pad(n), 'revision.json'), { force: true })
}

/** 只重跑某章的评审报告（不动正文）。评审失败时报告里记下错误，界面上可以换 agent 后再点重试 */
export async function rerunReport(id, n) {
  const text = S.readText(id, 'chapters', S.pad(n) + '.txt')
  if (!text) throw new Error(`第${n}章还没有定稿`)
  const rep = await rubricJudge(text, { chapterNo: n, context: recapOf(id, n).slice(-800), styleLabel: judgeLabelOf(id) }).catch((e) => ({ error: e.message }))
  if (rep.cost) S.addCost(id, rep.cost)
  delete rep.raw
  rep.machine = bandScore(computeMetrics(text), bands())
  rep.at = new Date().toISOString(); rep.textHash = S.bodyHash(text)
  S.writeText(id, `work/${S.pad(n)}/report.json`, JSON.stringify(rep, null, 2))
  const book = S.readBook(id); const c = book.chapters.find((x) => x.n === n)
  if (c) { Object.assign(c, { score: rep.total ?? null, readNext: rep.readNext ?? null, machineScore: rep.machine.score, scoreStale: false }); S.saveBook(book) }
  log(id, rep.error ? `第${n}章：评审报告失败 —— ${rep.error.split('\n')[0]}` : `第${n}章：评审报告 ${rep.total} 分`)
  return rep
}

/** 导出整本 txt（番茄上传格式：章与章之间空两行，段间空行） */
export function exportBook(id) {
  const book = S.readBook(id)
  if (!book.chapters.length) throw new Error('还没有章节，先写正文再导出')
  const parts = book.chapters.map((c) => S.readText(id, 'chapters', S.pad(c.n) + '.txt').trim())
  const f = S.bookPath(id, `${book.title.replace(/[\\/:*?"<>|]/g, '')}.txt`)
  fs.writeFileSync(f, parts.join('\n\n\n') + '\n', 'utf8')
  return f
}

/** 番茄后台要填的作品信息（书名/简介/标签/封面提示词），单独一个文件，方便复制粘贴 */
export function exportInfo(id) {
  const book = S.readBook(id); const p = book.package || {}
  const cp = p.coverPrompt || {}
  const intro = p.intro || (S.readText(id, 'concept.md').match(/简介[:：]\s*([\s\S]*?)(?=\n(?:风格|书名)[:：]|$)/) || [])[1]?.trim() || ''
  const words = book.chapters.reduce((a, c) => a + (c.chars || 0), 0)
  const st = settings()
  const warn = [titleLen(book.title) > TITLE_MAX ? `⚠ 书名 ${titleLen(book.title)} 字，超过番茄 ${TITLE_MAX} 字上限（标点也算），上传前必须缩短` : '', p.cover?.noPen ? '⚠ 这张封面生成时没有笔名：填好你自己的笔名后，在「书名·简介·封面」点「只重新压书名/笔名」（不花钱）' : ''].filter(Boolean)
  return `${warn.length ? warn.join('\n') + '\n\n' : ''}书名：${book.title}（${titleLen(book.title)} 字）\n笔名：${st.penName || '（未设置：请填你自己在番茄使用的笔名，这里不会替你起）'}\n封面：${p.cover?.file ? p.cover.file + '（' + p.cover.size + '）' : '（未生成）'}\n\n简介（${intro.length} 字）：\n${intro || '（还没有，先在书页「包装」里生成）'}\n\n${p.meta ? `目标读者：${p.meta.audience === 'female' ? '女频' : '男频'}　签约模式：${p.meta.signMode === 'complete' ? '完本模式' : '连载模式'}\n阅读标签：主分类 ${p.meta.read?.main || '（未选）'}｜主题 ${(p.meta.read?.theme || []).join('、') || '无'}｜角色 ${(p.meta.read?.role || []).join('、') || '无'}｜情节 ${(p.meta.read?.plot || []).join('、') || '无'}\n内容标签：情节 ${(p.meta.content?.plot || []).join('、') || '无'}｜人设 ${(p.meta.content?.persona || []).join('、') || '无'}｜情感 ${(p.meta.content?.emotion || []).join('、') || '无'}｜世界观 ${(p.meta.content?.world || []).join('、') || '无'}\n主角名：${(p.meta.heroes || []).join('、') || '（未填）'}` : `标签：${(p.tags || []).join('、') || '（未设置）'}`}\n\n` +
    `封面提示词（中文）：\n${cp.zh || '（未生成）'}\n\n封面提示词（英文）：\n${cp.en || '（未生成）'}\n\n负面提示词：\n${cp.negative || ''}\n\n` +
    `章节：${book.chapters.length} 章 · ${words} 字\n${book.chapters.map((c) => `第${c.n}章 ${c.title}（${c.chars} 字${c.score != null ? `，评分 ${c.score}` : ''}）`).join('\n')}\n\n` +
    `上传番茄提示：段间已空一行；正文 AI 申报请按实际情况由你自己填写。\n`
}

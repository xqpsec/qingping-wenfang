// Reproducible proxy evaluation, not a claim of real reader retention.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chat, CALL_LOG } from '../lib/llm.mjs'
import { resolveAgent } from '../lib/agents.mjs'
import { scanTics } from '../lib/tics.mjs'
import * as P from './pipeline.mjs'
import { channel } from './channels.mjs'
import { pickWriterRole, appendLearning, contextCache, buildRewriteContext, buildRewritePrompt, quoteInText, assertRewriteSize } from './learning.mjs'
export { pickWriterRole, buildRewriteContext, buildRewritePrompt, contextCache, assertRewriteSize } from './learning.mjs'

export function locateRealism(secs, realism = []) {
  const out = []
  for (const x of realism) {
    if (!x?.quote || !['法律', '金钱', '医疗', '程序', '常识'].includes(x.domain)) continue
    const sections = secs.flatMap((s, k) => quoteInText(s.text, x.quote) ? [k + 1] : [])
    if (sections.length) out.push({ ...x, sections })
  }
  return out
}

export function locateContradictions(secs, contradictions = [], limit = 4) {
  const bySection = new Map(); let unlocated = 0
  for (const x of contradictions) {
    const a = secs.flatMap((s, k) => quoteInText(s.text, x.a) ? [k] : [])
    const b = secs.flatMap((s, k) => quoteInText(s.text, x.b) ? [k] : [])
    if (!a.length || !b.length) unlocated++
    for (const k of new Set([...a, ...b])) {
      if (!bySection.has(k)) bySection.set(k, new Map())
      bySection.get(k).set(JSON.stringify([x.a, x.b]), x)
    }
  }
  return { unlocated, fixes: [...bySection].map(([k, values]) => ({ section: k + 1, count: values.size, contradictions: [...values.values()] }))
    .sort((a, b) => b.count - a.count || a.section - b.section).slice(0, limit) }
}
export function retentionRewriteTargets(secs, review, rewritten = new Set()) {
  return (review.curve || []).filter((x) => x.section < secs.length && !rewritten.has(x.section))
    .sort((a, b) => a.probability - b.probability || a.section - b.section).slice(0, 2).map((x) => x.section - 1)
}
export async function rewriteRoundSections(secs, review, rewrite, record) {
  const located = locateContradictions(secs, review.contradictions)
  const realism = locateRealism(secs, review.realism)
  record.unlocated = located.unlocated; record.realism = realism; record.contradictionFix = []
  const rewritten = new Set(), candidate = secs.map((s) => ({ ...s }))
  const combined = new Map(located.fixes.map((x) => [x.section, { ...x, realism: [] }]))
  for (const x of realism) for (const section of x.sections) {
    if (!combined.has(section)) combined.set(section, { section, count: 0, contradictions: [], realism: [] })
    combined.get(section).realism.push(x)
  }
  for (const fix of [...combined.values()].sort((a, b) => b.count - a.count || a.section - b.section).slice(0, 4)) {
    const result = { section: fix.section, count: fix.count, ok: false }
    record.contradictionFix.push(result)
    try {
      candidate[fix.section - 1].text = await rewrite(secs, fix.section - 1, { ...review, contradictions: fix.contradictions, realism: fix.realism || [] }, fix.contradictions.length ? 'contradiction' : 'realism')
      result.ok = true; rewritten.add(fix.section)
    } catch (e) { result.error = String(e.message).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]'); if (e instanceof BudgetStop) throw e }
  }
  const weak = retentionRewriteTargets(secs, review, rewritten)
  for (const k of weak) candidate[k].text = await rewrite(secs, k, review, 'retention')
  return { candidate, weak, changed: [...new Set([...rewritten].map((n) => n - 1).concat(weak))] }
}

// 矛盾修复是「对齐事实」的机械活，走便宜写手；留存重写拼文笔，走学习选出的写手。
// writerAB 等直接传真实角色名（cheap/writer）时原样使用。
export function rewriteRole(kind, selected = 'writer') {
  if (kind === 'contradiction' || kind === 'realism') return 'cheap'
  if (kind === 'retention') return selected
  return kind
}
// 重写缓存：同一节原文+同一指令+同一写手只付一次钱；熔断后重跑同一轮可免费复用已修好的节。
export const rewriteCacheKey = (text, kind, role, user) => createHash('sha256').update([text, kind, role, user].join('\u0000')).digest('hex')
export function readRewriteCache(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'versions', 'rewrite-cache.json'), 'utf8')) || {} } catch { return {} }
}
export function writeRewriteCache(dir, key, text) {
  try { const all = readRewriteCache(dir); all[key] = text; fs.mkdirSync(path.join(dir, 'versions'), { recursive: true }); fs.writeFileSync(path.join(dir, 'versions', 'rewrite-cache.json'), JSON.stringify(all), 'utf8') } catch {}
}

// round-人味与书名-20261004.md: hit median 1.47 per 1000 Han characters.
export const TIC_LIMIT = 1.6
export class BudgetStop extends Error {}
export class Budget {
  constructor(limit = 6, spent = 0) {
    if (!Number.isFinite(limit) || limit <= 0 || limit > 10) throw new BudgetStop('budget must be >0 and <=10')
    this.limit = limit; this.spent = spent
  }
  check(reserve = 0) { if (this.spent + reserve >= this.limit) throw new BudgetStop(`预算熔断: ${this.spent.toFixed(5)} + ${reserve.toFixed(5)} >= ${this.limit}`) }
  add(cost) { this.spent = +(this.spent + cost).toFixed(5); if (this.spent >= this.limit) throw new BudgetStop('预算已用完') }
}
export function aggregateBlind(ab, ba) {
  if (ab === 'A' && ba === 'B') return 'left'
  if (ab === 'B' && ba === 'A') return 'right'
  return 'tie'
}
export const adoptCandidate = (gate, verdict) => gate.pass === true && verdict === 'right'
export const hash = (s) => createHash('sha256').update(s).digest('hex')
export function positionBias(comparisons = []) {
  const votes = comparisons.flatMap((x) => [x.ab?.winner, x.ba?.winner]).filter((x) => ['A', 'B', 'tie'].includes(x))
  const firstWinRate = votes.length ? votes.filter((x) => x === 'A').length / votes.length : 0
  return { positionBiased: comparisons.length >= 3 && firstWinRate >= 0.8, firstWinRate, samples: comparisons.length }
}
export async function pairedBlind(left, right, tag, ask, batch = []) {
  const one = async (a, b, suffix) => {
    const raw = await ask(tag + suffix, { maxTokens: 650, system: '你是短篇读者。只按事件吸引力、情绪兑现、逻辑可信、节奏衔接比较，不按长度或位置偏好。平台规则、品类、通过率、审核流程、改编、法务类说法只能引用证据包原文；写作问题必须引用稿件原句。', user: `哪段更想往下读？只输出JSON {"winner":"A/B/tie","why":"具体理由"}。\n【A】\n${a}\n【B】\n${b}` })
    const j = P.looseJson(raw)
    return { winner: ['A', 'B', 'tie'].includes(j.winner) ? j.winner : 'tie', why: j.why }
  }
  const ab = await one(left, right, '-ab'), ba = await one(right, left, '-ba')
  const result = { ab, ba, verdict: aggregateBlind(ab.winner, ba.winner), leftHash: hash(left), rightHash: hash(right) }
  batch.push(result)
  const stats = positionBias(batch)
  for (const x of batch) Object.assign(x, stats)
  return result
}
export const SCORE_DIMENSIONS = ['event', 'emotion', 'logic', 'pace']
export function parseIndependentScore(raw) {
  const j = P.looseJson(raw)
  if (!SCORE_DIMENSIONS.every((k) => typeof j[k] === 'number' && Number.isFinite(j[k]) && j[k] >= 1 && j[k] <= 10) ||
      typeof j.total !== 'number' || !Number.isFinite(j.total) || j.total < 1 || j.total > 10) throw new Error('独立评分无效')
  const total = SCORE_DIMENSIONS.reduce((n, k) => n + j[k], 0) / 4
  if (Math.abs(j.total - total) > 0.011) throw new Error('独立评分总分不等于四维均值')
  return { ...Object.fromEntries(SCORE_DIMENSIONS.map((k) => [k, j[k]])), total }
}
export function createIndependentJudge({ ask, model, anchorFile, cache = new Map(), evidencePack = '' }) {
  let persisted = {}
  if (anchorFile && fs.existsSync(anchorFile)) { try { persisted = JSON.parse(fs.readFileSync(anchorFile, 'utf8')) } catch { /* rebuild corrupt cache */ } }
  const score = async (text, tag, anchor = false) => {
    const key = `${hash(text)}:${model}`
    if (cache.has(key)) return cache.get(key)
    if (anchor && persisted[key]) {
      try { const s = parseIndependentScore(JSON.stringify(persisted[key])); cache.set(key, s); return s } catch { /* rescore invalid entry */ }
    }
    const raw = await ask(tag, { maxTokens: 300, system: '你是严厉的短篇评审，使用固定绝对量表，单独评价文本，不与其他版本比较。平台规则、品类、通过率、审核流程、改编、法务类说法只能引用证据包原文；写作问题必须引用稿件原句。', user: `按1-10分固定量表独立打分：1-2严重失败，3-4薄弱，5-6合格，7-8出色，9-10极佳。四维等权：事件吸引力event、情绪兑现emotion、逻辑可信logic、节奏衔接pace。总分total为四维算术平均（1-10）。只输出JSON {"event":7,"emotion":7,"logic":7,"pace":7,"total":7}。\n【唯一待评文本】\n${text}${evidencePack ? `\n【证据包】\n${evidencePack}` : ''}` })
    const s = parseIndependentScore(raw); cache.set(key, s)
    if (anchor && anchorFile) { persisted[key] = s; fs.mkdirSync(path.dirname(anchorFile), { recursive: true }); fs.writeFileSync(anchorFile, JSON.stringify(persisted, null, 2), 'utf8') }
    return s
  }
  const compare = async (left, right, tag, rightAnchor = false) => {
    const l = await score(left, tag + '-left'), r = await score(right, tag + '-right', rightAnchor)
    const delta = +(l.total - r.total).toFixed(6)
    return { mode: 'independent', model, left: l, right: r, delta, verdict: Math.abs(delta) < 1 ? 'tie' : delta > 0 ? 'left' : 'right', leftHash: hash(left), rightHash: hash(right) }
  }
  const anchorScore = async (text, anchors, tag) => {
    const list = Array.isArray(anchors) ? anchors : []
    if (!list.length) return { mode: 'independent', model, winRate: null, comparisons: [], anchorCount: 0 }
    const comparisons = []
    for (let k = 0; k < list.length; k++) comparisons.push(await compare(text, list[k].text, `${tag}-${k}`, true))
    return { mode: 'independent', model, winRate: comparisons.filter((x) => x.verdict === 'left').length / list.length, comparisons, anchorCount: list.length }
  }
  return { score, compare, anchorScore, clear: () => cache.clear() }
}
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8')
const put = (dir, name, s) => fs.writeFileSync(path.join(dir, name), s, 'utf8')
export function parseRetention(raw, secs) {
  let j
  try { j = P.looseJson(raw) } catch { return { valid: false, error: 'invalid-json', curve: [], average: null, minimum: null } }
  const curve = secs.map((s, k) => {
    const x = (Array.isArray(j.sections) ? j.sections : []).find((v) => Number(v.section) === k + 1)
    const probability = Number(x?.probability)
    const valid = x && x.probability !== null && x.probability !== '' && Number.isFinite(probability) && probability >= 0 && probability <= 100
    const skipped = (Array.isArray(x?.skip) ? x.skip : []).filter((q) => typeof q === 'string' && q.length > 0 && s.text.includes(q)).slice(0, 3)
    return { section: k + 1, probability: valid ? probability : null, skip: skipped }
  })
  const body = secs.map((s) => s.text).join('\n')
  const contradictions = (Array.isArray(j.contradictions) ? j.contradictions : []).filter((x) => x?.a && x?.b && body.includes(x.a) && body.includes(x.b))
  const complete = curve.length > 0 && curve.every((x) => x.probability !== null)
  const cumulative = complete && curve.length >= 6 && curve.every((x, k) => k === 0 || x.probability <= curve[k - 1].probability) && curve[0].probability - curve.at(-1).probability >= 40
  const valid = complete && !cumulative
  const weakest = valid ? curve.slice(0, -1).sort((a, b) => a.probability - b.probability || a.section - b.section) : []
  const unlocated = (Array.isArray(j.contradictions) ? j.contradictions : []).filter((x) => x?.a && x?.b && !(body.includes(x.a) && body.includes(x.b))).length
  return { valid, error: cumulative ? 'cumulative-retention' : complete ? null : 'missing-sections', curve, contradictions, unlocated, average: valid ? +(curve.reduce((s, x) => s + x.probability, 0) / curve.length).toFixed(2) : null, minimum: valid ? Math.min(...curve.map((x) => x.probability)) : null, lowestSection: weakest[0]?.section ?? null, weakest: weakest.slice(0, 2) }
}
export async function evaluateRetention(body, tag, ask, { indices, retry = true, evidencePack = '' } = {}) {
  const all = P.splitSections(body)
  const selected = indices ? [...new Set(indices)].sort((a, b) => a - b) : all.map((_, k) => k)
  const secs = selected.map((k) => all[k])
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    const raw = await ask(tag + (attempt ? '-retry' : ''), { maxTokens: 1800,
      system: '你是严厉的短篇读者。概率是模拟条件判断，不是真实留存。平台规则、品类、通过率、审核流程、改编、法务类说法只能引用证据包原文；写作问题必须引用稿件原句。现实逻辑问题须列realism并标注法律/金钱/医疗/程序/常识。',
      user: `每节独立判断：假设读者已读到本节开头，读完本节后继续读下一节的概率0-100。不是累计留存，不要随节号递减。全文末节改问读完是否满意/会推荐的概率。${attempt ? '纠正：上次评分无效，禁止给出累计漏斗；重新独立判断各节。' : ''}只评下面提供的节，响应section使用下面的评估编号。指出想跳过的逐字原句；确定矛盾引用两句原文；现实逻辑问题引用逐字原句并标domain。只输出JSON {"sections":[{"section":1,"probability":80,"skip":[]}],"contradictions":[{"a":"原句","b":"原句","why":"原因"}],"realism":[{"quote":"稿件原句","why":"现实逻辑问题","domain":"法律"}]}。\n${selected.map((k, i) => `【评估编号${i + 1}，原第${k + 1}节${k === all.length - 1 ? '，全文末节，评满意/推荐' : ''}】\n${all[k].text}`).join('\n')}${evidencePack ? `\n【证据包】\n${evidencePack}` : ''}` })
    const result = parseRetention(raw, secs)
    if (result.valid) return { ...result, curve: result.curve.map((x, i) => ({ ...x, section: selected[i] + 1 })), weakest: result.weakest.map((x) => ({ ...x, section: selected[x.section - 1] + 1 })) }
  }
  throw new Error('留存解析失败（已重问一次），保留原稿')
}
export async function refreshFinalEvidence(id, before, { ask: askStub, model, anchors, onStep = () => {} } = {}) {
  const dir = P.shortDir(id), body = read(dir, '正文.md')
  if (body === before) return { changed: [] }
  const oldSecs = P.splitSections(before), secs = P.splitSections(body)
  const changed = secs.flatMap((s, k) => hash(s.text) !== hash(oldSecs[k]?.text || '') ? [k] : [])
  const records = (fs.existsSync(path.join(dir, 'refine-log.jsonl')) ? read(dir, 'refine-log.jsonl') : '').split('\n').flatMap((s) => { try { return [JSON.parse(s)] } catch { return [] } })
  const previous = [...records].reverse().find((x) => x.retention?.valid && x.anchor && x.bodyHash === hash(before))
  // 2026-10-06：精修没拿到有效评分时，不再让整篇失败（旧逻辑会让「继续生成」永远卡在这里）。
  // 修补后的正文照常保留；质量报告会按 bodyHash 不匹配标「评分不是最终正文版本」。
  if (!previous || secs.length !== oldSecs.length) {
    onStep('最终修补：没有可复用的原版评分，跳过局部重评（质量报告会标注）')
    return { changed: changed.map((k) => k + 1), skipped: 'no-evidence' }
  }
  const meta = P.readMeta(id)
  const judgeAgent = askStub && model ? { id: 'stub', model } : resolveAgent({ role: 'gpt' })
  const judgeModel = model || judgeAgent.model
  const ask = askStub || (async (tag, opts) => {
    const r = await chat({ ...opts, role: 'gpt', json: true, temperature: 0, thinking: false, _retry: 1, tag: `refine:${id}:${tag}` })
    meta.cost = +((meta.cost || 0) + (r.cost || 0)).toFixed(5); meta.calls = (meta.calls || 0) + 1
    put(dir, 'meta.json', JSON.stringify(meta, null, 2))
    put(dir, `versions/${tag}-${Date.now()}.json`, JSON.stringify({ model: r.model, cost: r.cost, content: r.content }, null, 2))
    if (r.agent !== judgeAgent.id || r.model !== judgeModel) throw new Error('最终评审路由不匹配')
    return r.content
  })
  const indices = [...new Set(changed.flatMap((k) => k > 0 ? [k - 1, k] : [k]))].sort((a, b) => a - b)
  onStep(`最终修补重评：第${indices.map((k) => k + 1).join('、')}节`)
  const local = indices.length ? await evaluateRetention(body, 'final-retention', ask, { indices, retry: false }) : { curve: [], contradictions: [] }
  const curve = previous.retention.curve.map((x) => local.curve.find((v) => v.section === x.section) || x)
  // Preserve old contradictions unless one quoted sentence ceased to exist; local review can add new ones.
  const contradictions = [...(previous.retention.contradictions || []).filter((x) => body.includes(x.a) && body.includes(x.b)), ...local.contradictions]
  const retention = parseRetention(JSON.stringify({ sections: curve, contradictions }), secs)
  if (!retention.valid) throw new Error('最终局部评分无效，保留原稿')
  const judge = createIndependentJudge({ ask, model: judgeModel, anchorFile: path.join(dir, 'anchor-scores.json') })
  const anchor = changed.includes(0) ? await judge.anchorScore(lead(secs[0].text), anchors || loadAnchors(), 'final-anchor') : previous.anchor
  const record = { ...previous, at: new Date().toISOString(), stage: 'finalRepair', changed: changed.map((k) => k + 1), reevaluated: indices.map((k) => k + 1), retention, anchor, bodyHash: hash(body), sectionHashes: secs.map((s) => hash(s.text)) }
  fs.appendFileSync(path.join(dir, 'refine-log.jsonl'), JSON.stringify(record) + '\n', 'utf8')
  return record
}
export function loadAnchors(file = process.env.WORKSHOP_SHORT_ANCHORS || 'data\\knowledge\\shortstory\\爆款短篇样本-20260925.md') {
  if (!fs.existsSync(file)) return [] // 锚点样本是可选数据，缺失时只做无锚点评分
  const text = fs.readFileSync(file, 'utf8')
  // Only the four quoted Fanqie leads. The fifth row explicitly has no verbatim lead.
  const rows = text.split('\n').filter((l) => /^\| [1-4] \|/.test(l) && l.includes('「'))
  const anchors = rows.map((l) => { const cells = l.split('|'); const q = cells[4].trim(); return { title: cells[2].trim(), text: q.slice(q.indexOf('「') + 1, q.lastIndexOf('」')), source: 'C: wangwen666.com/post/65.html; quoted excerpts, market performance unverified' } })
  if (anchors.length !== 4) throw new Error('expected four verbatim Fanqie anchors')
  return anchors
}
const lead = (s) => {
  const head = s.slice(0, 340)
  const ends = [...head.matchAll(/[。！？](?:["」”])?/g)].map((m) => m.index + m[0].length)
  const end = ends.filter((n) => n <= 320).pop()
  return s.slice(0, end && end >= 180 ? end : 300)
}
function totalTagged(prefix) {
  if (!fs.existsSync(CALL_LOG)) return 0
  return fs.readFileSync(CALL_LOG, 'utf8').split('\n').reduce((n, l) => { try { const j = JSON.parse(l); return n + (j.tag?.startsWith(prefix) ? Number(j.cost) || 0 : 0) } catch { return n } }, 0)
}
export async function refineShort(id, { rounds = 3, budget = 6, onStep = () => {} } = {}) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('invalid rounds')
  const dir = P.shortDir(id); const meta = P.readMeta(id); meta.id = id
  const prefix = `refine:${id}:`; const purse = new Budget(budget, totalTagged(prefix))
  const c = channel(meta.channelId); const evidencePack = P.buildEvidencePack(meta.channelId); const anchors = loadAnchors(); const rows = P.outlineRows(id)
  const versions = path.join(dir, 'versions'); fs.mkdirSync(versions, { recursive: true })
  const log = (x) => fs.appendFileSync(path.join(dir, 'refine-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...x }) + '\n', 'utf8')
  let calls = 0
  const ask = async (tag, { role = 'gpt', system = '', user, maxTokens = 1600, temperature = 0, json = true }) => {
    const a = resolveAgent({ role })
    // 事前预留：输入按 1.8 token/字符（实测 1.77）；输出按 maxTokens×1.5（实测 out≈0.3–0.4×maxTokens，1.5 倍覆盖一次空响应重试）。
    // 2026-10-04 旧公式 ×2/×3 把单次 ¥0.4 的重写预留成 ¥1.4，提前熔断导致已付的 3 次重写作废。事后检查不变。
    const reserve = ((system.length + user.length) * 1.8 * a.priceIn + maxTokens * 1.5 * a.priceOut) / 1e6
    purse.check(reserve)
    const before = totalTagged(prefix)
    let r
    try { r = await chat({ role, system, user, maxTokens, temperature, json, thinking: false, _retry: 2, tag: prefix + tag, onDelta: () => {} }) }
    finally { const delta = totalTagged(prefix) - before; purse.add(Math.max(0, delta)); calls++; meta.cost = +((meta.cost || 0) + Math.max(0, delta)).toFixed(5); meta.calls = (meta.calls || 0) + 1; put(dir, 'meta.json', JSON.stringify(meta, null, 2)) }
    put(dir, `versions/call-${String(calls).padStart(3, '0')}-${tag}.json`, JSON.stringify({ role, model: r.model, cost: r.cost, content: r.content }, null, 2))
    // 2026-10-06：内测档位模式下 resolveAgent 忽略 role，agent id 是档位名（如 fast）；按解析出的 id/模型比，不按 role 名比
    if (r.agent !== a.id || r.model !== a.model) throw new Error('评审/作者路由发生降级，结果作废')
    callDetails.set(tag, { model: r.model, cost: r.cost || 0 })
    return r.content
  }
  const retain = (body, tag) => evaluateRetention(body, tag, ask, { evidencePack })
  const judge = createIndependentJudge({ ask, model: resolveAgent({ role: 'gpt' }).model, anchorFile: path.join(dir, 'anchor-scores.json'), evidencePack })
  const blind = judge.compare
  const anchorScore = (text, tag) => judge.anchorScore(text, anchors, tag)
  const clean = (txt) => P.normalizeMarkers(txt, c).split('\n').filter((l) => !/^(###\s*(第\d+章|\d+\.)|\d+\.)\s*$/.test(l.trim())).join('\n').trim()
  let cache
  const callDetails = new Map()
  const rewriteSelection = { role: 'writer' }
  const rewrite = async (secs, k, review, role, tag, temperature = 0.7) => {
    const system = `你是投给${c.name}的短篇作者。具体动作、对白推进情绪，不总结、不复述、不用沉默/秒数套话。平台规则、品类、通过率、审核流程、改编、法务类说法只能引用证据包原文；写作问题必须引用稿件原句。`
    const kind = role === 'contradiction' ? '矛盾修复' : '留存重写'
    const prompt = buildRewritePrompt({ system, secs, k, rows, setting: read(dir, '设定.md'), cache, review,
      instruction: `${kind}第${k + 1}节。处理本节矛盾与现实逻辑问题：${(review.realism || []).map((x) => `${x.domain}:${x.quote}（${x.why}）`).join('；') || '无'}。保留事实、人物、伏笔；修成单一事实链，以先出现的事实为准，除非后文是故事必需的反转。字数${P.visibleChars(secs[k].text)} ±10%。${P.FORMAT_RULES(c)}只输出本节正文，不要节标记。` })
    const realRole = rewriteRole(role, rewriteSelection.role)
    const key = rewriteCacheKey(secs[k].text, role, realRole, prompt.user)
    const hit = readRewriteCache(dir)[key]
    if (typeof hit === 'string' && hit.trim()) { callDetails.set(tag, { cached: true, cost: 0, role: realRole }); return hit }
    const before = purse.spent
    const text = clean(await ask(tag, { role: realRole, json: false, temperature, maxTokens: Math.ceil(P.visibleChars(secs[k].text) * 1.8) + 400, system: prompt.system, user: prompt.user }))
    callDetails.set(tag, { ...callDetails.get(tag), role: realRole, cost: +(purse.spent - before).toFixed(5), estimatedTokens: prompt.estimatedTokens, degradation: prompt.degradation })
    writeRewriteCache(dir, key, text)
    return text
  }
  const hard = () => { const g = P.gates(id); const tic = scanTics(read(dir, '正文.md')); return { ...g, tics: tic, pass: g.pass && tic.perK <= TIC_LIMIT } }
  const results = []
  const initial = read(dir, '正文.md'); if (!fs.existsSync(path.join(versions, 'r0.md'))) put(versions, 'r0.md', initial)
  for (let round = 1; round <= rounds; round++) {
    const before = purse.spent; const original = read(dir, '正文.md'); let record = { round, accepted: false }
    onStep(`好看度第${round}轮；累计 ¥${purse.spent}`)
    try {
      judge.clear()
      const retention = await retain(original, `r${round}-retention-before`); record.retentionBefore = retention
      const secs = P.splitSections(original); let candidate = secs.map((s) => ({ ...s }))
      cache = contextCache(secs, rows, meta.consistency)
      const selection = pickWriterRole(meta.genre, { defaultRole: 'writer' }); rewriteSelection.role = selection.role
      meta.writerSelections = [...(meta.writerSelections || []), { at: new Date().toISOString(), stage: 'rewrite', round, ...selection }]
      const rewriteResult = await rewriteRoundSections(secs, retention, async (source, k, scoped, kind) => rewrite(source, k, scoped, kind, `r${round}-${kind}-${k + 1}`), record)
      candidate = rewriteResult.candidate
      const weak = rewriteResult.weak
      if (round === 1 && weak.length) {
        const k = weak[0]
        const selectedTag = `r${round}-retention-${k + 1}`
        const cheap = selection.role === 'cheap' ? candidate[k].text : await rewrite(secs, k, retention, 'cheap', 'writerAB-cheap')
        const writer = selection.role === 'writer' ? candidate[k].text : await rewrite(secs, k, retention, 'writer', 'writerAB-writer')
        record.writerAB = { section: k + 1, cheapHash: hash(cheap), writerHash: hash(writer), comparison: await blind(cheap, writer, 'writerAB') }
        const cd = callDetails.get(selection.role === 'cheap' ? selectedTag : 'writerAB-cheap')
        const wd = callDetails.get(selection.role === 'writer' ? selectedTag : 'writerAB-writer')
        appendLearning({ channel: meta.channelId, genre: meta.genre, section: k + 1, cheapModel: cd.model, writerModel: wd.model, mode: 'independent', comparison: record.writerAB.comparison, verdict: record.writerAB.comparison.verdict, cheapCost: cd.cost, writerCost: wd.cost })
        const variants = [lead(secs[0].text)]
        for (const [i, role, temperature] of [[1, selection.role, 0.5], [2, selection.role, 0.95], [3, 'cheap', 0.8]]) {
          const system = '写短篇导语，事实不变。只输出正文，不加标题。'
          const prompt = buildRewritePrompt({ system, secs, k: 0, rows, setting: read(dir, '设定.md'), cache, review: retention,
            instruction: `只改导语，字数等长，第一句事件，保持后文衔接。\n【待改导语】${lead(candidate[0].text)}` })
          variants.push(clean(await ask(`lead-${i}`, { role, json: false, temperature, maxTokens: 600, system: prompt.system, user: prompt.user })))
        }
        const scores = []
        for (let i = 0; i < variants.length; i++) scores.push(await anchorScore(variants[i], `lead-score-${i}`))
        const best = scores.reduce((a, x, i) => x.winRate > scores[a].winRate ? i : a, 0)
        record.leads = { scores, best, variants }
        // Replace the exact prefix, leaving all following text intact; full tournament protects the seam.
        candidate[0].text = variants[best] + '\n' + candidate[0].text.slice(lead(candidate[0].text).length).trimStart()
      }
      record.lengthPass = weak.every((k) => { const ratio = P.visibleChars(candidate[k].text) / P.visibleChars(secs[k].text); return ratio >= 0.9 && ratio <= 1.1 })
      put(dir, '正文.md', P.joinSections(candidate))
      let gate = hard()
      if (!gate.pass) {
        await P.repair(id, onStep, 0, async (_meta, tag, opts) => { const raw = await ask(`r${round}-repair-${tag}`, { ...opts, role: 'cheap', json: false }); return opts.json ? P.looseJson(raw) : raw })
        gate = hard()
      }
      record.gates = gate
      const proposed = read(dir, '正文.md'); put(versions, `r${round}-candidate.md`, proposed)
      record.tournament = await blind(original, proposed, `r${round}-tournament`)
      record.accepted = record.lengthPass && gate.pass && adoptCandidate(gate, record.tournament.verdict)
      if (!record.accepted) put(dir, '正文.md', original)
      const current = read(dir, '正文.md')
      record.retention = record.accepted ? await retain(current, `r${round}-retention-after`) : retention
      record.anchor = await anchorScore(lead(P.splitSections(current)[0].text), `r${round}-anchor`)
      put(versions, `r${round}.md`, current)
      record.bodyHash = hash(read(dir, '正文.md'))
      record.cost = +(purse.spent - before).toFixed(5); record.totalCost = purse.spent; log(record); results.push(record)
      if (record.retention.minimum >= 70 && record.anchor.winRate >= 0.4) break
    } catch (e) {
      put(dir, '正文.md', original); put(versions, `r${round}.md`, original)
      record.error = e instanceof BudgetStop ? e.message : '模型或评测失败: ' + String(e.message).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
      record.bodyHash = hash(read(dir, '正文.md'))
      record.cost = +(purse.spent - before).toFixed(5); record.totalCost = purse.spent; log(record); results.push(record)
      break
    }
  }
  meta.refine = { rounds: results.length, cost: purse.spent, budget, resultsFile: 'refine-log.jsonl' }; put(dir, 'meta.json', JSON.stringify(meta, null, 2))
  return { id, cost: purse.spent, results }
}

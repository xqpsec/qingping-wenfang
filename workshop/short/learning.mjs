import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MVP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const LEARNING_FILE = process.env.WORKSHOP_SANDBOX
  ? path.join(path.resolve(process.env.WORKSHOP_SANDBOX), 'short-learning.ndjson')
  : path.join(MVP, 'workshop/data/short-learning.ndjson')
export function readLearning(file = LEARNING_FILE) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}
export function pickWriterRole(genre, { records = readLearning(), defaultRole = 'cheap' } = {}) {
  const valid = records.filter((x) => x.genre === genre && !x.positionBiased && !x.comparison?.positionBiased &&
    ((x.mode === 'independent' && x.comparison?.mode === 'independent' && Math.abs(x.comparison.delta) >= 1 && x.verdict === x.comparison.verdict && ['left', 'right'].includes(x.verdict)) ||
     (x.ab?.winner === 'A' && x.ba?.winner === 'B' && x.verdict === 'left') ||
     (x.ab?.winner === 'B' && x.ba?.winner === 'A' && x.verdict === 'right')))
  const wins = valid.filter((x) => x.verdict === 'left').length
  const winRate = valid.length ? wins / valid.length : null
  return { role: valid.length >= 4 ? (winRate >= 0.5 ? 'cheap' : 'writer') : defaultRole,
    genre, valid: valid.length, cheapWins: wins, winRate,
    reason: valid.length >= 4 ? '同题材至少4条有效独立评分或无偏双顺序盲比，按cheap胜率0.5阈值选择' : '有效判定不足4条，保持原默认' }
}
export function appendLearning(record, file = LEARNING_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8')
}

const cut = (s, n) => [...String(s)].slice(0, n).join('')
export function sectionSummary(text) {
  const sentences = String(text).match(/[^。！？\n]+[。！？]?/g) || [String(text)]
  return cut(sentences[0], 75) + (sentences.length > 1 ? cut(sentences.at(-1), 75) : '')
}
export function contextCache(secs, rows, consistency = {}) {
  const summaries = secs.map((s) => sectionSummary(s.text))
  const reused = consistency.facts || consistency.factChain
  // Verbatim excerpts, not inferred facts. Include outline objects even without numeric mentions.
  const extracted = secs.flatMap((s, k) => {
    const object = rows[k]?.cells?.[8]
    return (s.text.match(/[^。！？\n]+[。！？]?/g) || [])
      .filter((line) => /[0-9零一二三四五六七八九十百千万亿]+(?:元|万|岁|年|月|日|点|份|张|号)|原件|复印|烧|藏|转账|欠条|遗嘱|证据/.test(line) || (object && line.includes(object)))
      .map((line) => `第${k + 1}节：${line}`)
  })
  return { summaries, facts: reused ? (typeof reused === 'string' ? reused : JSON.stringify(reused)) : [...new Set(extracted)].join('\n'), source: reused ? 'consistency' : 'verbatim-excerpts' }
}
export function buildRewriteContext({ secs, k, rows, setting, cache = contextCache(secs, rows), summaryLimit = 45, settingLimit = 1200, factsLimit = 1200 }) {
  return `【设定】${cut(setting, settingLimit)}\n【大纲该行】${JSON.stringify(rows[k] || {})}\n【前一节结尾】${cut((secs[k - 1]?.text || '无').slice(-500), 500)}\n【后一节开头】${cut(secs[k + 1]?.text || '无', 500)}\n【其余节摘要】\n${cache.summaries.map((s, i) => i !== k && i !== k - 1 && i !== k + 1 ? `第${i + 1}节：${cut(s, summaryLimit)}` : '').filter(Boolean).join('\n')}\n【事实摘录】\n${cut(cache.facts, factsLimit)}\n【本节原文】${cut(secs[k].text, 2500)}`
}
export const quoteInText = (text, quote) => typeof quote === 'string' && quote.replace(/\s/g, '').length > 0 && String(text).replace(/\s/g, '').includes(quote.replace(/\s/g, ''))
export function sectionReview(secs, k, review = {}) {
  const row = review.curve?.find((x) => x.section === k + 1)
  return { probability: row?.probability ?? null, skip: (row?.skip || []).filter((s) => quoteInText(secs[k].text, s)),
    contradictions: (review.contradictions || []).filter((x) => quoteInText(secs[k].text, x.a) || quoteInText(secs[k].text, x.b)) }
}
// 1.8 token/字符：2026-10-04 实测 gpt-6.1-sol 留存调用 13.3k 字符 → in=23540（≈1.77），取略保守值
export const estimateRewriteTokens = (system, user) => Math.ceil([...String(system), ...String(user)].length * 1.8)
export function assertRewriteSize(system, user) {
  const estimatedTokens = estimateRewriteTokens(system, user)
  if (estimatedTokens > 12000) throw new Error(`重写上下文超限：保守估算${estimatedTokens} token >12000；保留原稿`)
  return estimatedTokens
}
export function buildRewritePrompt({ system, instruction, suffix = '', review, ...context }) {
  const limits = { summaryLimit: 45, settingLimit: 1200, factsLimit: 1200 }, degradation = []
  const render = () => `${instruction}\n${buildRewriteContext({ ...context, ...limits })}\n【本节评审】${JSON.stringify(sectionReview(context.secs, context.k, review))}${suffix}`
  let user = render()
  for (const [key, value, step] of [['summaryLimit', 25, '其余节摘要45→25'], ['settingLimit', 600, '设定1200→600'], ['factsLimit', 600, '事实摘录1200→600']]) {
    if (estimateRewriteTokens(system, user) <= 12000) break
    limits[key] = value; user = render()
    degradation.push({ step, estimatedTokens: estimateRewriteTokens(system, user) })
  }
  try { return { system, user, estimatedTokens: assertRewriteSize(system, user), degradation } }
  catch (error) { error.degradation = degradation; throw error }
}

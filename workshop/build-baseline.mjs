// build-baseline.mjs —— 用本地爆款首章生成「对位基线」，并做区分度自检（零 token）
// 用法：node workshop/build-baseline.mjs [--cats=262] [--neg=<目录>...]
//  正样本：data/knowledge/chapters/<cat>-*.txt（榜单书首章语料，需自备）
//  负样本：我方已写、签约被拒/数据差的章节（默认：高武旧书、K-07）
// 产物：workshop/data/baseline-<cats>.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeMetrics, buildBands, bandScore } from './lib/metrics.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d }
const CORPUS = 'data\\knowledge\\chapters'
const cats = arg('cats', '262').split(',')
const negDirs = (arg('neg', '') || ['data\\novels\\高武：我的面板能读心', 'data\\novels\\收容物编号：K-07'].join(',')).split(',')

const pos = []
for (const f of fs.readdirSync(CORPUS)) {
  if (!f.endsWith('.txt')) continue
  if (!cats.includes(f.split('-')[0])) continue
  const raw = fs.readFileSync(path.join(CORPUS, f), 'utf8')
  const name = (raw.match(/^书名: (.*)$/m) || [])[1] || f
  const m = computeMetrics(raw)
  if (m.chars < 800) continue
  pos.push({ file: f, name, m })
}
const bands = buildBands(pos.map((x) => x.m))

// 留一法：每本爆款用「其余爆款」建的基线打分，避免自己给自己打分
const posScores = pos.map((x, i) => bandScore(x.m, buildBands(pos.filter((_, j) => j !== i).map((y) => y.m))).score)

const neg = []
for (const d of negDirs) {
  if (!fs.existsSync(d)) continue
  const files = fs.readdirSync(d).filter((f) => /^ch\d{4}\.txt$/.test(f)).sort().slice(0, 20)
  for (const f of files) {
    const m = computeMetrics(fs.readFileSync(path.join(d, f), 'utf8'))
    if (m.chars < 800) continue
    neg.push({ file: path.basename(d) + '/' + f, m, score: bandScore(m, bands).score })
  }
}
const negScores = neg.map((x) => x.score)

// Cliff's delta：P(pos>neg) − P(pos<neg)
let gt = 0; let lt = 0
for (const a of posScores) for (const b of negScores) { if (a > b) gt++; else if (a < b) lt++ }
const delta = negScores.length ? (gt - lt) / (posScores.length * negScores.length) : null
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

const out = {
  builtAt: new Date().toISOString(), cats, positives: pos.length, negatives: neg.length, bands,
  selfCheck: { posMedian: med(posScores), negMedian: med(negScores), cliffDelta: delta && +delta.toFixed(3) },
  samples: pos.map((x, i) => ({ name: x.name, score: posScores[i] })),
}
fs.mkdirSync(path.join(HERE, 'data'), { recursive: true })
const outFile = path.join(HERE, 'data', `baseline-${cats.join('_')}.json`)
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8')

console.log(`正样本（爆款首章）${pos.length} 篇 · 负样本（我方旧稿）${neg.length} 章`)
console.log('关键指标（爆款 P10 / P50 / P90）：')
for (const k of ['chars', 'parasPerK', 'paraMean', 'dialogRatio', 'sentMean', 'sentSd', 'exclaimPerK', 'questionPerK', 'firstQuotePos', 'rep4', 'clichePerK']) {
  const b = bands[k]; console.log(`  ${k.padEnd(14)} ${b.p10} / ${b.p50} / ${b.p90}`)
}
console.log(`\n区分度自检：爆款中位分 ${out.selfCheck.posMedian}（留一法） vs 我方中位分 ${out.selfCheck.negMedian}；Cliff's δ = ${out.selfCheck.cliffDelta}`)
console.log(`→ ${outFile}`)

// ab-detic.mjs —— 去 AI 腔定点改写的盲评 A/B：原章 vs 改后章，换序双判（不同厂商评审），并报告口癖密度变化
// 用法：WORKSHOP_SANDBOX=<空目录> WORKSHOP_BUDGET=1 node workshop/ab-detic.mjs <章文件>... [--judges=triage,cheap] [--out=结果.json]
// 改写走 task=fix（便宜模型）；评审用 role 指定，避免「自己写自己评」
import fs from 'node:fs'
import path from 'node:path'
import { chat } from './lib/llm.mjs'
import { scanTics, deticPrompt, applyDetic } from './lib/tics.mjs'
import { pairJudge, setPairRole } from './lib/judge.mjs'
import { computeMetrics } from './lib/metrics.mjs'

const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d }
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const judges = arg('judges', 'triage,cheap').split(',')
const outFile = arg('out', '')
const rows = []
let cost = 0
for (const f of files) {
  const orig = fs.readFileSync(f, 'utf8')
  const b = scanTics(orig)
  const dt = { patches: [] }
  const r = await chat({ task: 'fix', system: '你是番茄小说的资深责编，专改 AI 腔，让文字像真人网文作者写的。', user: deticPrompt(orig, b.flagged), temperature: 0.6, maxTokens: 8000, tag: 'ab-detic', thinking: false })
  cost += r.cost
  for (const line of r.content.split('\n')) { const m = line.match(/^\s*(?:\d+[.、]\s*)?原句[:：](.+?)\s*=>\s*改为[:：](.*)$/); if (m && m[1].trim().length >= 4) dt.patches.push({ from: m[1].trim(), to: m[2].trim() }) }
  const ap = applyDetic(orig, b.flagged, dt.patches); dt.applied = ap.applied
  const neu = ap.text
  const a = scanTics(neu)
  fs.writeFileSync(f.replace(/\.txt$/, '') + '.detic.txt', neu, 'utf8')
  const row = { file: path.basename(f), chars: [computeMetrics(orig).chars, computeMetrics(neu).chars], tic: [b.perK, a.perK], flagged: [b.flagged.length, a.flagged.length], patches: dt.patches.length, applied: dt.applied, verdict: {} }
  for (const j of judges) {
    setPairRole(j)
    const pj = await pairJudge(orig, neu, { styleLabel: '都市脑洞' })
    cost += pj.cost
    row.verdict[j] = { winner: pj.winner === 1 ? 'detic' : pj.winner === 0 ? 'orig' : 'tie', raw: pj.raw }
  }
  rows.push(row)
  console.log(`${row.file} 字数 ${row.chars.join('→')} 口癖/千字 ${row.tic.join('→')} 补丁 ${row.applied}/${row.patches} 评审 ${judges.map((j) => j + ':' + row.verdict[j].winner).join(' ')}`)
}
const tally = Object.fromEntries(judges.map((j) => [j, rows.reduce((t, r) => { t[r.verdict[j].winner]++; return t }, { detic: 0, orig: 0, tie: 0 })]))
console.log('汇总', JSON.stringify(tally), `花费 ¥${cost.toFixed(4)}`)
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), judges, rows, tally, cost }, null, 1), 'utf8')

// ab-write.mjs —— 写作阶段 A/B：同一章同一节拍，A=现行写手 prompt，B=加「去 AI 腔」段；成对盲评（换序双判）+ 口癖与情绪指标
// 用法：WORKSHOP_SANDBOX=<空目录> WORKSHOP_BUDGET=1 node workshop/ab-write.mjs <书目录> <章号>... [--judge=cheap] [--out=x.json]
// 只读书目录（取设定集、节拍、上一章结尾、前情摘要），产物写到 --dir（默认 data/ab-write-<日期>/）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chat } from './lib/llm.mjs'
import * as P from './lib/prompts.mjs'
import { styleRules, resolveStyle } from './lib/styles.mjs'
import { tidy } from './lib/pipeline.mjs'
import { scanTics, deticBlock } from './lib/tics.mjs'
import { pairJudge, setPairRole } from './lib/judge.mjs'
import { computeMetrics } from './lib/metrics.mjs'

const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d }
const [bookDir, ...ns] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const judge = arg('judge', 'cheap')
const outDir = arg('dir', path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'ab-write-20261004'))
fs.mkdirSync(outDir, { recursive: true })
const rd = (...p) => { try { return fs.readFileSync(path.join(bookDir, ...p), 'utf8') } catch { return '' } }
const pad = (n) => String(n).padStart(4, '0')
const book = JSON.parse(rd('book.json'))
const bible = rd('bible.md')
const st = resolveStyle({ id: book.genre })
const sys = P.writerSystem(styleRules(st), st.label)
const rows = []; let cost = 0
for (const nStr of ns) {
  const n = Number(nStr)
  const plan = rd('work', pad(n), 'plan.md')
  if (!plan) { console.log(`第${n}章没有节拍，跳过`); continue }
  const prevTail = rd('chapters', pad(n - 1) + '.txt').trim().split('\n').filter(Boolean).slice(-6).join('\n')
  const recap = book.chapters.filter((c) => c.n < n).slice(-12).map((c) => `第${c.n}章 ${c.title}：${c.summary || ''}`).join('\n')
  const outlineRow = `${n}|${book.chapters.find((c) => c.n === n)?.title || ''}`
  const base = { bible, characterCard: null, plan, recap, prevTail, chapterNo: n, outlineRow, anchors: [] }
  const texts = {}
  for (const [k, extra] of [['A', ''], ['B', deticBlock()]]) {
    const f = path.join(outDir, `${path.basename(bookDir).slice(0, 6)}-${pad(n)}-${k}.txt`)
    if (fs.existsSync(f)) { texts[k] = fs.readFileSync(f, 'utf8'); continue }
    const r = await chat({ task: 'write1', system: sys, user: P.writerPrompt({ ...base, deticText: extra }), temperature: 0.85, maxTokens: 16000, tag: `ab-write-${k}` })
    cost += r.cost; texts[k] = tidy(r.content); fs.writeFileSync(f, texts[k], 'utf8')
  }
  setPairRole(judge)
  const pj = await pairJudge(texts.A, texts.B, { context: recap.slice(-800), styleLabel: st.label })
  cost += pj.cost
  const sa = scanTics(texts.A), sb = scanTics(texts.B)
  const row = { n, chars: [computeMetrics(texts.A).chars, computeMetrics(texts.B).chars], ticPerK: [sa.perK, sb.perK], exclaimPerK: [sa.exclaimPerK, sb.exclaimPerK], particlesPerK: [sa.particlesPerK, sb.particlesPerK], winner: pj.winner === 1 ? 'B' : pj.winner === 0 ? 'A' : 'tie', raw: pj.raw, reasons: pj.reasons }
  rows.push(row)
  console.log(`第${n}章 字数 ${row.chars.join('/')} 口癖/千字 A ${sa.perK} B ${sb.perK} 感叹号 ${row.exclaimPerK.join('/')} 语气词 ${row.particlesPerK.join('/')} 评审 ${row.winner}`)
}
const tally = rows.reduce((t, r) => { t[r.winner]++; return t }, { A: 0, B: 0, tie: 0 })
console.log('汇总', JSON.stringify(tally), `花费 ¥${cost.toFixed(4)}`)
fs.writeFileSync(path.join(outDir, `result-${path.basename(bookDir).slice(0, 6)}.json`), JSON.stringify({ at: new Date().toISOString(), judge, rows, tally, cost }, null, 1), 'utf8')

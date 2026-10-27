// bench-vs-hits.mjs —— 验收尺子：拿我们的章节和番茄都市脑洞爆款首章「二选一」（双向换序，两次一致才算胜）
// 这是校准过的评审方式（爆款 vs 我方旧稿，爆款胜率 76%）。我方胜率越接近/超过 50%，说明越接近爆款水平。
// 用法：node workshop/bench-vs-hits.mjs <文件或目录> [--hits=8]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pairJudge, setPairRole } from './lib/judge.mjs'

const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d }
const HITS = Number(arg('hits', '8'))
const ROLE = arg('judge', 'cheap') // cheap=deepseek-flash（已校准） / gpt=交叉验证
setPairRole(ROLE)
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const CORPUS = 'data\\knowledge\\chapters'
const all = fs.readdirSync(CORPUS).filter((f) => /^262-\d+-\d+\.txt$/.test(f)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]) || a.localeCompare(b))
const hits = Array.from({ length: HITS }, (_, i) => all[Math.floor(i * all.length / HITS)])

const files = []
for (const t of targets) {
  if (fs.statSync(t).isDirectory()) for (const f of fs.readdirSync(t).filter((x) => /\.(txt|md)$/.test(x)).sort()) files.push(path.join(t, f))
  else files.push(t)
}
let cost = 0; const rows = []
for (const f of files) {
  const ours = fs.readFileSync(f, 'utf8')
  let w = 0; let tie = 0; let l = 0; const why = []
  await Promise.all(hits.map(async (h) => {
    try {
      const r = await pairJudge(ours, fs.readFileSync(path.join(CORPUS, h), 'utf8'), { sameBook: false }); cost += r.cost
      if (r.winner === 0) w++; else if (r.winner === 1) { l++; why.push(r.reasons[0]) } else tie++
    } catch (e) { console.log('  ✗', e.message.slice(0, 60)) }
  }))
  const rate = (w + tie * 0.5) / Math.max(1, w + tie + l)
  rows.push({ file: path.basename(f), w, tie, l, rate })
  console.log(`${path.basename(f).padEnd(28)} 胜 ${w} 平 ${tie} 负 ${l} → 对爆款胜率 ${(rate * 100).toFixed(0)}%`)
  if (why.length) console.log(`   输的主要原因：${why[0].slice(0, 110)}`)
}
const avg = rows.reduce((a, r) => a + r.rate, 0) / Math.max(1, rows.length)
console.log(`\n平均对爆款胜率 ${(avg * 100).toFixed(0)}%（参考：我方旧稿约 24%，爆款互比 ≈50%）；花费 ¥${cost.toFixed(3)}`)
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'bench-vs-hits.ndjson')
fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), judge: ROLE, hits, rows, avg }) + '\n', 'utf8')

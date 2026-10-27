// calibrate-judge.mjs —— 验证「LLM 评审」能不能区分爆款与我方旧稿
// 用法：node workshop/calibrate-judge.mjs [--n=8] [--role=cheap|pro] [--mode=rubric|pair|both]
// 通过标准（RESEARCH-v01-小说评判体系 §3.2）：
//   rubric：爆款中位 − 我方中位 ≥ 5（百分制）且 Cliff's δ ≥ 0.33
//   pair  ：爆款 vs 我方 跨书对比，爆款胜率（平局记 0.5）≥ 70%
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rubricJudge, pairJudge, setPairRole } from './lib/judge.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d }
const N = Number(arg('n', '8'))
const ROLE = arg('role', 'cheap')
const MODE = arg('mode', 'both')
setPairRole(ROLE)
const CORPUS = 'data\\knowledge\\chapters'

// 爆款：按排名均匀取 N 本（新书榜+在读榜混合）
const all = fs.readdirSync(CORPUS).filter((f) => /^262-\d+-\d+\.txt$/.test(f)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]) || a.localeCompare(b))
const step = all.length / N
const pos = Array.from({ length: N }, (_, i) => all[Math.floor(i * step)]).map((f) => ({ id: f, text: fs.readFileSync(path.join(CORPUS, f), 'utf8'), kind: 'hit' }))

// 我方：历史上被拒签 / 数据差 / 主办方判"太文学"的第 1 章
const neg = []
const NOV = 'data\\novels'
for (const d of ['高武：我的面板能读心', '收容物编号：K-07', '我丈夫七年不给我买菜钱', '我妈替我签了二十九万', '我的葬礼上，债主来了']) {
  const p = path.join(NOV, d, 'ch0001.txt'); if (fs.existsSync(p)) neg.push({ id: d, text: fs.readFileSync(p, 'utf8'), kind: 'ours' })
}
for (const b of fs.readdirSync(path.join(HERE, '..', 'projects', 'books'))) {
  const cd = path.join(HERE, '..', 'projects', 'books', b, 'chapters')
  const f = fs.existsSync(cd) && fs.readdirSync(cd).find((x) => /^0001_.*\.md$/.test(x) && !/humanized|bak/.test(x))
  if (f) neg.push({ id: b + '/ch1', text: fs.readFileSync(path.join(cd, f), 'utf8'), kind: 'ours' })
}
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
let cost = 0
const report = { at: new Date().toISOString(), role: ROLE, n: N }

if (MODE !== 'pair') {
  const items = [...pos, ...neg]
  console.log(`[rubric/${ROLE}] 评审 ${pos.length} 篇爆款 + ${neg.length} 篇我方`)
  const res = []
  await Promise.all(items.map(async (it) => {
    for (let t = 0; t < 2; t++) {
      try { const j = await rubricJudge(it.text, { role: ROLE }); cost += j.cost; res.push({ id: it.id, kind: it.kind, score: j.total, avg: j.avg, readNext: j.readNext }); return } catch (e) { if (t) console.log('  ✗', it.id, e.message.slice(0, 80)) }
    }
  }))
  const P = res.filter((x) => x.kind === 'hit').map((x) => x.score); const Q = res.filter((x) => x.kind === 'ours').map((x) => x.score)
  let gt = 0; let lt = 0; for (const a of P) for (const b of Q) { if (a > b) gt++; else if (a < b) lt++ }
  const delta = (gt - lt) / Math.max(1, P.length * Q.length)
  for (const r of res.sort((a, b) => b.score - a.score)) console.log(`  ${r.kind === 'hit' ? '爆款' : '我方'} ${String(r.score).padStart(3)} (均${r.avg} 追读${r.readNext}) ${r.id.slice(0, 36)}`)
  const pass = med(P) - med(Q) >= 5 && delta >= 0.33
  console.log(`  → 爆款中位 ${med(P)} vs 我方中位 ${med(Q)}；δ=${delta.toFixed(3)} ${pass ? '✅' : '❌'}\n`)
  report.rubric = { posMedian: med(P), negMedian: med(Q), delta, pass, res }
}

if (MODE !== 'rubric') {
  // 跨书成对：每篇我方 vs 若干爆款（轮转配对），双向换序
  const pairs = []
  neg.forEach((q, i) => { for (let j = 0; j < Math.min(3, pos.length); j++) pairs.push([pos[(i * 3 + j) % pos.length], q]) })
  console.log(`[pair/${ROLE}] ${pairs.length} 组跨书对比（每组双向换序 = ${pairs.length * 2} 次调用）`)
  let win = 0; let tie = 0; let lose = 0
  await Promise.all(pairs.map(async ([p, q]) => {
    try {
      const r = await pairJudge(p.text, q.text, { sameBook: false }); cost += r.cost
      if (r.winner === 0) win++; else if (r.winner === 1) { lose++; console.log(`  我方胜：${q.id} > ${p.id.slice(0, 20)}｜${r.reasons[0].slice(0, 60)}`) } else tie++
    } catch (e) { console.log('  ✗', e.message.slice(0, 80)) }
  }))
  const rate = (win + tie * 0.5) / Math.max(1, win + tie + lose)
  const pass = rate >= 0.7
  console.log(`  → 爆款胜 ${win} / 平 ${tie} / 负 ${lose}，胜率 ${(rate * 100).toFixed(0)}% ${pass ? '✅' : '❌'}\n`)
  report.pair = { win, tie, lose, rate, pass }
}
report.cost = cost
console.log(`花费约 ¥${cost.toFixed(3)}`)
fs.mkdirSync(path.join(HERE, 'data'), { recursive: true })
fs.writeFileSync(path.join(HERE, 'data', `judge-calibration-${ROLE}.json`), JSON.stringify(report, null, 2), 'utf8')

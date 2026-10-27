// judge-audit.mjs —— 评审 agent 公正性体检：评审的分数到底能不能信？
// 用法：node workshop/judge-audit.mjs [--judges=cheap,gpt] [--n=4] [--book=<书目录名>]
// 只读：不改任何书、不改配置；结果写 workshop/data/judge-audit/<时间>.json + .md
//
// 五项检查（每项都给出「通过线」，不通过说明那个评审在这件事上不可靠）：
//  ① 重测稳定性：同一章、同一评审连打 3 次，分数极差。>8 分 = 「改后高 5 分」这种差距没有意义
//  ② 分数漂移：书里存的旧分数 vs 现在同一正文重打的分数。差距大 = 改前改后不能拿「旧分 vs 新分」比（v1.1 的问题）
//  ③ 位置偏好：成对比较里「先出场的版本」赢的比例。远离 50% = 结论受出场顺序影响（本工坊已双向换序，此项看换序有没有必要/够不够）
//  ④ 换序一致率：两次换序结论一致的比例。太低 = 成对比较大多数时候在掷硬币
//  ⑤ 评审间一致率 + 自家偏好：不同评审对同一对稿子的结论是否一致；若候选稿记录了作者模型，统计各评审是否偏爱自家模型写的稿
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rubricJudge, pairJudge, setPairRole } from './lib/judge.mjs'
import { loadConfig } from './lib/agents.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d }
const cfg = loadConfig()
const JUDGES = arg('judges', 'cheap,gpt').split(',').filter((j) => cfg.agents[j])
const N = Number(arg('n', '4'))
const BOOKS = path.resolve(HERE, '..', 'projects', 'workshop-books')
const book = arg('book', fs.readdirSync(BOOKS).find((d) => fs.existsSync(path.join(BOOKS, d, 'book.json'))))
const B = (...p) => path.join(BOOKS, book, ...p)
const rd = (...p) => { const f = B(...p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }
const pad = (n) => String(n).padStart(4, '0')
const meta = JSON.parse(rd('book.json'))
const CORPUS = 'data\\knowledge\\chapters'

let cost = 0
const add = (r) => { cost += r?.cost || 0; return r }
const range = (v) => v.length ? Math.max(...v) - Math.min(...v) : null
const out = { at: new Date().toISOString(), book, judges: JUDGES.map((j) => ({ id: j, model: cfg.agents[j].model })), checks: {} }
const R = (judge) => (text, n) => rubricJudge(text, { chapterNo: n, role: judge }).then(add).catch((e) => ({ error: e.message.slice(0, 160) }))

// 样本：书里的定稿章 + 候选稿对；爆款库取 N 篇做跨书对
const chs = meta.chapters.slice(0, N)
const pairs = []
for (const c of chs) {
  const a = rd('work', pad(c.n), 'cand-1.txt'), b = rd('work', pad(c.n), 'cand-2.txt')
  const am = JSON.parse(rd('work', pad(c.n), 'cand-1.json') || 'null'), bm = JSON.parse(rd('work', pad(c.n), 'cand-2.json') || 'null')
  if (a && b) pairs.push({ id: `第${c.n}章 候选1 vs 候选2`, a, b, authors: [am?.model || '未记录', bm?.model || '未记录'], labels: [`候选1(${am?.model || '作者未记录'})`, `候选2(${bm?.model || '作者未记录'})`] })
}
if (fs.existsSync(CORPUS)) {
  const hits = fs.readdirSync(CORPUS).filter((f) => /^262-\d+-\d+\.txt$/.test(f)).sort()
  for (let i = 0; i < Math.min(N, chs.length); i++) {
    const h = hits[Math.floor((i + 0.5) * hits.length / N)]
    pairs.push({ id: `爆款 ${h.slice(0, 14)} vs 本书第${chs[i].n}章`, a: fs.readFileSync(path.join(CORPUS, h), 'utf8'), b: rd('chapters', pad(chs[i].n) + '.txt'), authors: ['爆款(人写)', '本书定稿'], labels: ['爆款(人写)', '本书定稿'], cross: true })
  }
}
console.log(`书《${book}》 评审：${JUDGES.join(', ')}  章节 ${chs.length}  成对样本 ${pairs.length}`)

for (const J of JUDGES) {
  const rub = R(J)
  // ① 重测稳定性（第 1 章连打 3 次） + ② 漂移（每章重打 1 次 vs 存的旧分）
  const c1 = rd('chapters', pad(chs[0].n) + '.txt')
  const [r1, r2, r3, ...rest] = await Promise.all([rub(c1, chs[0].n), rub(c1, chs[0].n), rub(c1, chs[0].n), ...chs.slice(1).map((c) => rub(rd('chapters', pad(c.n) + '.txt'), c.n))])
  const rescored = [r1, ...rest]
  const reps = [r1, r2, r3].map((x) => x.total).filter((x) => x != null)
  const drift = chs.map((c, i) => ({ n: c.n, stored: c.score ?? null, now: rescored[i]?.total ?? null })).filter((x) => x.stored != null && x.now != null).map((x) => ({ ...x, diff: x.now - x.stored }))
  // ③④⑤ 成对
  setPairRole(J)
  const pr = await Promise.all(pairs.map((p) => pairJudge(p.a, p.b, { sameBook: !p.cross }).then(add).catch((e) => ({ error: e.message.slice(0, 160) }))))
  setPairRole('')
  const ok = pr.filter((x) => x.raw)
  // raw[0] = 甲=a 时的胜者；raw[1] = 甲=b 时的胜者（已映射回原编号）。「先出场者赢」：raw[0]===0 或 raw[1]===1
  const firstWins = ok.reduce((s, x) => s + (x.raw[0] === 0 ? 1 : 0) + (x.raw[1] === 1 ? 1 : 0), 0)
  out.checks[J] = {
    model: cfg.agents[J].model,
    retest: { scores: reps, range: range(reps), pass: range(reps) != null && range(reps) <= 8 },
    drift: { rows: drift, maxAbs: drift.length ? Math.max(...drift.map((x) => Math.abs(x.diff))) : null },
    positionFirstWinRate: ok.length ? +(firstWins / (ok.length * 2)).toFixed(2) : null,
    swapConsistency: ok.length ? +(ok.filter((x) => x.winner !== -1).length / ok.length).toFixed(2) : null,
    pairs: pairs.map((p, i) => ({ id: p.id, authors: p.authors, winner: pr[i].error ? '失败' : pr[i].winner === -1 ? '平' : p.authors[pr[i].winner], label: pr[i].error ? '失败' : pr[i].winner === -1 ? '平（两次换序结论相反）' : p.labels[pr[i].winner], labels: p.labels, raw: pr[i].raw || null, error: pr[i].error })),
  }
  const c = out.checks[J]
  console.log(`[${J} / ${c.model}] 重测 ${reps.join('/')}（极差 ${c.retest.range}） 漂移最大 ${c.drift.maxAbs} 先出场胜率 ${c.positionFirstWinRate} 换序一致 ${c.swapConsistency}`)
}

// ⑤ 评审间一致率
if (JUDGES.length >= 2) {
  const [x, y] = JUDGES; let same = 0, both = 0
  pairs.forEach((_, i) => { const a = out.checks[x].pairs[i].winner, b = out.checks[y].pairs[i].winner; if (a !== '失败' && b !== '失败') { both++; if (a === b) same++ } })
  out.checks.interJudge = { judges: [x, y], agree: both ? +(same / both).toFixed(2) : null, n: both }
}
// 自家偏好：评审模型 == 作者模型 的那一方赢的比例
for (const J of JUDGES) {
  const m = cfg.agents[J].model; let own = 0, tot = 0
  for (const p of out.checks[J].pairs) if (p.authors.includes(m) && p.authors.some((a) => a !== m && a !== '未记录') && p.winner !== '失败' && p.winner !== '平') { tot++; if (p.winner === m) own++ }
  out.checks[J].selfPreference = tot ? { ownWinRate: +(own / tot).toFixed(2), n: tot } : { note: '没有「一方是评审自家模型写的」样本（旧候选稿未记录作者，v1.2 起新写的章会记录）' }
}
out.cost = +cost.toFixed(4)

// 结论（规则写死，不让模型自己解释自己）
const lines = [`# 评审公正性体检（${new Date().toLocaleString('zh-CN')}）`, '', `书：《${book}》；花费 ¥${out.cost}`, '', '| 评审 | 重测极差（≤8 通过） | 旧分→重打 最大漂移 | 先出场胜率（0.35–0.65 正常） | 换序一致率（≥0.6 可用） | 自家偏好 |', '|---|---|---|---|---|---|']
for (const J of JUDGES) {
  const c = out.checks[J]
  lines.push(`| ${J}（${c.model}） | ${c.retest.scores.join('/')} → ${c.retest.range}${c.retest.pass ? ' ✓' : ' ✗'} | ${c.drift.rows.map((r) => `${r.stored}→${r.now}`).join('，') || '—'}（最大 ${c.drift.maxAbs ?? '—'}） | ${c.positionFirstWinRate ?? '—'} | ${c.swapConsistency ?? '—'} | ${c.selfPreference.ownWinRate != null ? `自家赢 ${c.selfPreference.ownWinRate}（n=${c.selfPreference.n}）` : '无样本'} |`)
}
if (out.checks.interJudge) lines.push('', `评审间一致率（${out.checks.interJudge.judges.join(' vs ')}）：${out.checks.interJudge.agree}（n=${out.checks.interJudge.n}）`)
lines.push('', '## 怎么读', '- 重测极差大于两版的分差时，「改后高 X 分」不能说明改好了，要看成对比较。', '- 旧分→重打漂移大，说明不同时间打的分不能直接比；v1.2 改写对比已改为同一时刻同时打分。', '- 先出场胜率偏离 0.5 越多，越说明双向换序是必要的；换序一致率低说明成对比较多数是「差不多」。', '- 评审间一致率低时，换一个评审模型结论就变，此时任何单一评审的择优都要打折看。', '', '## 成对明细')
for (const J of JUDGES) for (const p of out.checks[J].pairs) lines.push(`- [${J}] ${p.id}：${p.label}${p.raw ? `（甲乙顺序各判一次，分别选了：${p.raw.map((w) => p.labels[w]).join(' / ')}）` : ''}${p.error ? ' 错误：' + p.error : ''}`)
const dir = path.join(HERE, 'data', 'judge-audit'); fs.mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
fs.writeFileSync(path.join(dir, stamp + '.json'), JSON.stringify(out, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, stamp + '.md'), lines.join('\n') + '\n', 'utf8')
console.log('\n' + lines.slice(4, 6 + JUDGES.length + 2).join('\n'))
console.log(`\n报告：${path.join(dir, stamp + '.md')}`)

// reconcile.mjs —— 对账：各用户 calls.ndjson → 消耗与建议应收。用法：
//   node reconcile.mjs [--factor 1.3] [--csv out.csv]
import fs from 'node:fs'
import path from 'node:path'
import { loadUsers, userDir } from './ulib.mjs'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const factor = Number(opt('factor', 1.3))

const db = loadUsers()
const rows = Object.entries(db.users).map(([name, u]) => {
  const f = path.join(userDir(db, name), 'calls.ndjson')
  let calls = 0, ok = 0, cost = 0
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
    try { const x = JSON.parse(l); calls++; if (x.ok) { ok++; cost += x.cost || 0 } } catch { /* 坏行 */ }
  }
  cost = +cost.toFixed(5)
  return { 用户: name, 调用: calls, 成功: ok, 估算成本: cost, 建议应收: +(cost * factor).toFixed(5) }
})
console.log(`对账系数 ${factor}（建议应收 = 成本 × 系数；成本按本地 usage×单价估算，与上游实扣可能有小差异）\n`)
console.table(rows)
const csv = ['用户,调用,成功,估算成本,建议应收', ...rows.map((r) => `${r.用户},${r.调用},${r.成功},${r.估算成本},${r.建议应收}`)].join('\n')
const out = opt('csv', '')
if (out) { fs.writeFileSync(out, csv, 'utf8'); console.log(`CSV 已写 ${out}`) }
console.log(`合计：成本 ¥${rows.reduce((a, r) => a + r.估算成本, 0).toFixed(5)}，建议应收 ¥${rows.reduce((a, r) => a + r.建议应收, 0).toFixed(5)}`)

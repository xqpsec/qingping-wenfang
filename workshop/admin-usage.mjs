// admin-usage.mjs —— 管理员用量汇总（2026-10-02）。用法：
//   node admin-usage.mjs <沙箱目录1> [目录2 ...] [--factor 1.3]
// 汇总各用户 calls.ndjson：调用数 / 成功花费 / 建议应收（成本×系数）。表格输出，不回显任何密钥。
import fs from 'node:fs'
import path from 'node:path'
import { priceFactor } from './lib/tiers.mjs'

const args = process.argv.slice(2)
let factor = priceFactor()
const dirs = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--factor') { factor = Number(args[++i]) || factor; continue }
  dirs.push(args[i])
}
if (!dirs.length) { console.log('用法：node admin-usage.mjs <沙箱目录...> [--factor 1.3]'); process.exit(1) }

const rows = dirs.map((dir) => {
  const f = path.join(dir, 'calls.ndjson')
  const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []
  let calls = 0, ok = 0, cost = 0
  for (const l of lines) {
    try { const x = JSON.parse(l); calls++; if (x.ok) { ok++; cost += x.cost || 0 } } catch { /* 坏行跳过 */ }
  }
  cost = +cost.toFixed(5)
  return { 用户: path.basename(dir) || dir, 调用: calls, 成功: ok, 估算成本: cost, 建议应收: +(cost * factor).toFixed(5) }
})
console.log(`对账系数：${factor}（建议应收 = 估算成本 × 系数）\n`)
console.table(rows)
console.log(`合计：成本 ¥${rows.reduce((a, r) => a + r.估算成本, 0).toFixed(5)}，建议应收 ¥${rows.reduce((a, r) => a + r.建议应收, 0).toFixed(5)}`)

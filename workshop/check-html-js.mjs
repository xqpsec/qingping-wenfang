// check-html-js.mjs —— 零成本：把页面里的 <script> 抽出来做语法检查（不执行）。用法：node check-html-js.mjs ui/customer-lab.html ui/admin.html
import fs from 'node:fs'
let bad = 0
for (const f of process.argv.slice(2)) {
  const html = fs.readFileSync(f, 'utf8')
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  scripts.forEach((s, i) => { try { new Function(s); console.log(`ok   ${f} #${i}`) } catch (e) { bad++; console.log(`FAIL ${f} #${i}: ${e.message}`) } })
}
process.exit(bad ? 1 : 0)

// leak-scan.mjs —— 内测脱敏回归闸门（2026-10-02）。用法：
//   node leak-scan.mjs http://127.0.0.1:4601 [bookId]
// 抓首页 HTML + 所有 GET 接口响应，用 lib/tiers.mjs 的词表扫描（单一事实源）。
// 命中即 exit 4 并打印命中词与出处；全干净 exit 0。可以反复跑，接进部署后的回归。
import * as TG from './lib/tiers.mjs'

const BASE = (process.argv[2] || 'http://127.0.0.1:4601').replace(/\/+$/, '')
const BOOK = process.argv[3] || ''
const GETS = ['/api/status', '/api/books', '/api/calls', '/api/agents', '/api/tier',
  ...(BOOK ? [`/api/book?id=${encodeURIComponent(BOOK)}`] : []),
  '/api/book?id=__no_such_book__', '/api/hits', '/no-such-page']

const leaks = []
function scan(label, text) {
  const s = String(text ?? '')
  for (const w of TG.LEAK_WORDS) {
    const re = new RegExp(w, 'gi')
    let m, n = 0
    while ((m = re.exec(s)) && n < 3) { leaks.push({ label, word: w, ctx: s.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ') }); n++ }
  }
  for (const re of [/https?:\/\/[^\s"'）)】]+/gi, /\b(?:sk|key|token)[-_ ][A-Za-z0-9]{6,}/gi]) {
    const m = s.match(re)
    if (m) leaks.push({ label, word: 'URL/密钥样式', ctx: m[0].slice(0, 60) })
  }
}

const html = await fetch(BASE + '/').then((r) => r.text()).catch((e) => 'FETCH_FAIL ' + e.message)
scan('HTML /', html)
for (const p of GETS) {
  const t = await fetch(BASE + p).then((r) => r.text()).catch((e) => 'FETCH_FAIL ' + e.message)
  scan('GET ' + p, t)
}
if (leaks.length) {
  console.log(`❌ 脱敏扫描命中 ${leaks.length} 处（${BASE}）：`)
  for (const l of leaks.slice(0, 30)) console.log(` - [${l.label}] 「${l.word}」 上下文：…${l.ctx}…`)
  process.exit(4)
}
console.log(`✅ 脱敏扫描 0 命中（${BASE}，${GETS.length + 1} 个页面/接口）`)

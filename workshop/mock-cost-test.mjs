// mock-cost-test.mjs —— 用本地假上游验证档位计费机制（零成本）：
// 用量→费用换算、calls.ndjson 记录、额度扣减。用法：node mock-cost-test.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(HERE, '..', 'projects', 'customer-test', 'mock-sandbox')
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true })

// 本地假上游：固定返回 100 输入 / 50 输出 token
const mock = http.createServer((req, res) => {
  let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '收到' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }))
  })
})
await new Promise((r) => mock.listen(4699, r))

// 档位：价格 In=2 / Out=4 元每百万 token → 一次调用应计费 (100*2+50*4)/1e6 = 0.0004 元
fs.writeFileSync(path.join(TMP, 'cfg.json'), JSON.stringify({
  tiers: { fast: { label: '快写档', model: 'mock-model', baseUrl: 'http://127.0.0.1:4699/v1', keyEnv: 'MOCKKEY', priceIn: 2, priceOut: 4, enabled: true } },
}, null, 2), 'utf8')

process.env.WORKSHOP_MODE = 'customer'
process.env.WORKSHOP_ADMIN_CONFIG = path.join(TMP, 'cfg.json')
process.env.WORKSHOP_SANDBOX = TMP
process.env.WORKSHOP_BUDGET = '0.0008'
process.env.MOCKKEY = 'sk-mock-123456'
const { chat, spentTotal, precheck } = await import('./lib/llm.mjs')

let pass = 0, fail = 0
const ok = (c, n, x = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${x}`) } }

const r = await chat({ role: 'smoke', user: 'hi', maxTokens: 100, tag: 'mock' })
ok(r.content === '收到', '调用成功')
ok(Math.abs(r.cost - 0.0004) < 1e-9, '费用换算 = (100×2+50×4)/1e6 = ¥0.0004', `got ${r.cost}`)
const log = JSON.parse(fs.readFileSync(path.join(TMP, 'calls.ndjson'), 'utf8').trim().split('\n').at(-1))
ok(log.ok === true && log.cost === 0.0004 && log.in === 100 && log.out === 50, 'calls.ndjson 记录用量与费用', JSON.stringify(log))
ok(Math.abs(spentTotal() - 0.0004) < 1e-9, '累计花费已扣减')

// 额度耗尽：预算 0.0008，两发后 0.0008 → precheck 应拒绝
await chat({ role: 'smoke', user: 'hi', maxTokens: 100, tag: 'mock2' })
let blocked = false
try { precheck() } catch (e) { blocked = e.message.includes('体验额度已用完') }
ok(spentTotal() >= 0.0008 && blocked, '超额后 precheck 用人话拒绝', `spent=${spentTotal()} blocked=${blocked}`)

// 不 close mock：process.exit 会带走它；close 与 exit 竞争会触发 libuv 断言、污染退出码
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

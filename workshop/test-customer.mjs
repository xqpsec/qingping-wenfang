// test-customer.mjs —— 内测用户模式验收（2026-10-02）。用法：node test-customer.mjs
// 本机起 2 个 customer 实例（假档位、假密钥、本地假上游，零成本），断言：
//   1) /api/agents* 对用户 403，映射只有管理员能改
//   2) 两个用户的书互相不可见
//   3) 顶栏档位可切换、大师档默认关闭
//   4) 超额后调模型动作被拒（人话），查看/导出仍可用
//   5) 到期后同理
//   6) 所有接口响应与页面 HTML 脱敏 0 命中（含被污染的 calls 记录）
// 全过 exit 0；任一失败打印断言并 exit 1。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(HERE, '..', 'projects', 'customer-test')
const LEAKS = ['deepseek', 'gpt', 'claude', 'kimi', 'glm', 'qwen', 'minimax', 'grok', 'astra', 'sonnet', 'opus', 'kiro', 'lingsuan', 'vendorx', 'hetune', 'openai', 'anthropic']
let pass = 0, fail = 0
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${extra}`) } }

fs.rmSync(TMP, { recursive: true, force: true })
for (const d of ['sandboxA', 'sandboxB']) fs.mkdirSync(path.join(TMP, d, 'books'), { recursive: true })
// 管理员配置：三个档位，大师关闭；指向本地假上游（本测试不真正调用，密钥也是假的）
fs.writeFileSync(path.join(TMP, 'cfg.json'), JSON.stringify({
  priceFactor: 1.3,
  tiers: {
    fast: { label: '快写档', model: 'test-fast-model', baseUrl: 'http://127.0.0.1:4699/v1', keyEnv: 'TESTKEY_A', priceIn: 1, priceOut: 2, enabled: true },
    refine: { label: '精修档', model: 'test-refine-model', baseUrl: 'http://127.0.0.1:4699/v1', keyEnv: 'TESTKEY_B', priceIn: 21, priceOut: 105, enabled: true },
    master: { label: '大师档', model: 'test-master-model', baseUrl: 'http://127.0.0.1:4699/v1', keyEnv: 'TESTKEY_B', priceIn: 21, priceOut: 105, enabled: false },
  },
}, null, 2), 'utf8')
// 各造一本书（形状同 store.mjs createBook 的最小字段）
for (const [sb, id] of [['sandboxA', 'book-a'], ['sandboxB', 'book-b']]) {
  fs.mkdirSync(path.join(TMP, sb, 'books', id, 'chapters'), { recursive: true })
  // 每本书造一章正文：导出功能要有正文才可用（验证「超额后导出仍可用」用的是真导出）
  fs.writeFileSync(path.join(TMP, sb, 'books', id, 'chapters', '0001.txt'), `第1章 测试\n\n这是${id}的测试正文，足够长以通过导出。${'内容'.repeat(50)}`, 'utf8')
  fs.writeFileSync(path.join(TMP, sb, 'books', id, 'book.json'), JSON.stringify({ id, title: `测试书 ${id}`, genre: 'urban-naodong', platform: 'tomato', stage: 'new', chapters: [{ n: 1, title: '第1章 测试', chars: 300, score: 70 }], createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', cost: 0 }, null, 2), 'utf8')
}
// A 的调用日志：故意带一条脏记录（模型名 + URL + 密钥样式），验证 /api/calls 出口被清洗；并预置超额
fs.writeFileSync(path.join(TMP, 'sandboxA', 'calls.ndjson'), [
  JSON.stringify({ at: '2026-10-02T00:00:00Z', task: 'write1', agent: 'fast', agentName: '快写档', model: 'test-fast-model', ok: true, cost: 9.9, ms: 100 }),
  JSON.stringify({ at: '2026-10-02T00:00:01Z', task: 'rubric', agent: 'fast', agentName: '快写档', model: 'test-fast-model', ok: false, err: '上游 https://api.example.com/v1 报错 sk-abcdef123456 deepseek', ms: 50 }),
].join('\n') + '\n', 'utf8')

const kids = []
function startInstance(port, sandbox, extra = {}) {
  const env = { ...process.env, WORKSHOP_MODE: 'customer', WORKSHOP_ADMIN_CONFIG: path.join(TMP, 'cfg.json'), WORKSHOP_SANDBOX: path.join(TMP, sandbox), WORKSHOP_PORT: String(port), WORKSHOP_BUDGET: '3', WORKSHOP_EXPIRES: '2026-12-31T00:00:00Z', TESTKEY_A: 'sk-test-fixture-aaaa', TESTKEY_B: 'sk-test-fixture-bbbb', ...extra }
  const kid = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env, cwd: HERE, stdio: 'ignore', detached: false })
  kids.push(kid)
  return kid
}
const wait = (ms) => new Promise((s) => setTimeout(s, ms))
const J = async (port, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  return { status: r.status, text: await r.text() }
}
const scanLeaks = (label, text) => LEAKS.filter((w) => new RegExp(w, 'i').test(String(text))).map((w) => `${label}:${w}`)

startInstance(4601, 'sandboxA', { WORKSHOP_BUDGET: '3' })
startInstance(4602, 'sandboxB', { WORKSHOP_BUDGET: '3', WORKSHOP_EXPIRES: '2026-10-01T00:00:00Z' }) // B 已过期
await wait(1500)

console.log('— 1) 模型入口对用户关闭 —')
ok((await J(4601, '/api/agents')).status === 403, 'GET /api/agents → 403')
ok((await J(4601, '/api/agents', { agents: {} })).status === 403, 'POST /api/agents → 403（用户改不了映射）')
ok((await J(4601, '/api/agents/ping', { id: 'x' })).status === 403, 'POST /api/agents/ping → 403')

console.log('— 2) 用户互相隔离 —')
const booksA = JSON.parse((await J(4601, '/api/books')).text)
const booksB = JSON.parse((await J(4602, '/api/books')).text)
ok(booksA.length === 1 && booksA[0].id === 'book-a', 'A 只看到自己的书', JSON.stringify(booksA.map((b) => b.id)))
ok(booksB.length === 1 && booksB[0].id === 'book-b', 'B 只看到自己的书', JSON.stringify(booksB.map((b) => b.id)))
ok((await J(4601, '/api/book?id=book-b')).status === 400, 'A 打不开 B 的书')

console.log('— 3) 档位：只露档位名、可切换、大师关闭 —')
const stA = JSON.parse((await J(4601, '/api/status')).text)
ok(stA.customer === true && Array.isArray(stA.agents.tiers), 'status 标记 customer 且返回档位')
ok(stA.agents.tiers.map((t) => t.label).join() === '快写档,精修档,大师档', '档位名正确', JSON.stringify(stA.agents.tiers))
ok(stA.agents.tier === 'fast', '默认档位=快写')
const setR = await J(4601, '/api/tier', { tier: 'refine' })
ok(setR.status === 200 && JSON.parse((await J(4601, '/api/status')).text).agents.tier === 'refine', '切换到精修生效')
ok((await J(4601, '/api/tier', { tier: 'master' })).status === 400, '大师档（关闭）选不上')
await J(4601, '/api/tier', { tier: 'fast' })

console.log('— 4) 超额：调模型拒绝，查看/导出可用 —')
const w = await J(4601, '/api/write', { id: 'book-a', count: 1 })
ok(w.status === 400 && w.text.includes('体验额度已用完'), '超额写章被人话拒绝', w.text.slice(0, 80))
ok((await J(4601, '/api/book?id=book-a')).status === 200, '超额后仍可查看书')
const dl = await J(4601, '/download?id=book-a')
ok(dl.status === 200, '超额后仍可导出', `status=${dl.status}`)

console.log('— 5) 到期：同理 —')
const w2 = await J(4602, '/api/write', { id: 'book-b', count: 1 })
ok(w2.status === 400 && w2.text.includes('体验期已结束'), '到期写章被人话拒绝', w2.text.slice(0, 80))
ok((await J(4602, '/api/book?id=book-b')).status === 200, '到期后仍可查看书')

console.log('— 6) 脱敏：HTML 与全部接口 0 命中 —')
const surfaces = { html: (await J(4601, '/')).text, status: (await J(4601, '/api/status')).text, books: (await J(4601, '/api/books')).text, book: (await J(4601, '/api/book?id=book-a')).text, calls: (await J(4601, '/api/calls')).text, err: w.text }
const hit = Object.entries(surfaces).flatMap(([k, v]) => scanLeaks(k, v))
ok(hit.length === 0, '用户可见面 0 命中', hit.join('；'))
ok(!/test-(fast|refine|master)-model/.test(Object.values(surfaces).join('')), '真实模型名不出现在任何用户输出')
ok(surfaces.html.includes('清平文坊'), '用户界面带着产品名')
const calls = JSON.parse(surfaces.calls)
ok(calls.length === 2 && calls.every((c) => c.model === '快写档'), '/api/calls 模型字段=档位名', JSON.stringify(calls.map((c) => c.model)))
ok(!calls.some((c) => String(c.err).includes('example.com') || String(c.err).includes('sk-')), '脏错误信息被清洗')

for (const k of kids) k.kill()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

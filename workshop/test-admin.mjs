// test-admin.mjs —— 管理后台（档位 ↔ 模型 / Base URL / API Key / 兼容协议）零成本测试
// 本机起假模型服务（OpenAI 兼容 + Anthropic 兼容各一个），不调真实 API。用法：node test-admin.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`) }

// ── 假模型：记录收到的路径、头和请求体 ──
const hits = []
const fakeOpenAI = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    hits.push({ srv: 'openai', path: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '收到-openai' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }))
  })
})
const fakeAnth = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = JSON.parse(b || '{}')
    hits.push({ srv: 'anthropic', path: req.url, xkey: req.headers['x-api-key'], ver: req.headers['anthropic-version'], body: j })
    if (req.headers['x-api-key'] !== 'sk-test-fixture-1234') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad key"}') }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ content: [{ type: 'text', text: '收到-anthropic' }], usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 10 } }))
  })
})
await new Promise((r) => fakeOpenAI.listen(4731, '127.0.0.1', r))
await new Promise((r) => fakeAnth.listen(4732, '127.0.0.1', r))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-admin-'))
const cfgFile = path.join(tmp, 'admin-tiers.json')
// 起始配置：一个新写法档位 + 一个旧写法档位（模型直接写在档位里）
fs.writeFileSync(cfgFile, JSON.stringify({
  priceFactor: 1.3, _说明: '保留字段',
  models: { flash: { model: 'flash-model', baseUrl: 'http://127.0.0.1:4731/v1', keyEnv: 'QP_TEST_KEY', priceIn: 1, priceOut: 2 } },
  tiers: {
    master: { label: '大师档', enabled: true, estPerChapter: 90, desc: '顶级', use: 'flash', tasks: { write1: 'flash' } },
    fast: { label: '快写档', enabled: true, estPerChapter: 15, model: 'legacy-model', baseUrl: 'http://127.0.0.1:4731/v1', keyEnv: 'QP_TEST_KEY', priceIn: 1, priceOut: 2 },
  },
}, null, 2))

const ADMIN_PORT = 4733, CUST_PORT = 4734
const base = { ...process.env, WORKSHOP_ADMIN_CONFIG: cfgFile, QP_TEST_KEY: 'sk-test-fixture-9999' }
delete base.WORKSHOP_SUPERVISED
const start = (env) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env, cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; p.stdout.on('data', (d) => { out += d; if (out.includes('已启动')) resolve(p) }); p.stderr.on('data', (d) => (out += d))
  p.on('exit', (c) => reject(new Error('服务退出 ' + c + '\n' + out)))
  setTimeout(() => reject(new Error('启动超时\n' + out)), 15000)
})
const usersDir = path.join(tmp, 'users'); fs.mkdirSync(path.join(usersDir, '_admin'), { recursive: true }); fs.mkdirSync(path.join(usersDir, 'u1'), { recursive: true })
const admin = await start({ ...base, WORKSHOP_MODE: 'admin', WORKSHOP_PORT: String(ADMIN_PORT), WORKSHOP_SANDBOX: path.join(usersDir, '_admin') })
const A = (p, body) => fetch(`http://127.0.0.1:${ADMIN_PORT}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${ADMIN_PORT}` }, body: JSON.stringify(body) } : {}).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null), r }))

try {
  // 1. 页面与读取
  const page = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin`).then((r) => r.text())
  ok(page.includes('档位 → 模型') && page.includes('兼容协议'), '管理员实例 /admin 打开新版管理后台')
  const v = await A('/api/admin/tiers')
  ok(v.status === 200 && v.j.models.flash && v.j.tiers.master.use === 'flash', '读取配置：模型清单 + 档位', JSON.stringify(Object.keys(v.j.models)))
  ok(v.j.models.flash.keyMask === '••••9999' && v.j.models.flash.keySource.includes('QP_TEST_KEY'), 'Key 只露末 4 位并说明来源', v.j.models.flash.keyMask)
  ok(v.j.tiers.fast.use && v.j.models[v.j.tiers.fast.use]?.model === 'legacy-model', '旧写法档位自动显示成独立模型', v.j.tiers.fast.use)
  ok(Array.isArray(v.j.tasks) && v.j.tasks.some((t) => t.id === 'write1'), '返回可单独指定的环节清单', String(v.j.tasks.length))
  ok(!JSON.stringify(v.j).includes('sk-test-fixture-9999'), '读取接口不回显完整 Key')

  // 2. 新增 Anthropic 协议模型 + 直接填 Key + 档位改映射
  const body = structuredClone(v.j); delete body.tasks
  body.models.opus = { name: '主笔', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:4732/v1/messages', model: 'claude-test', apiKey: 'sk-test-fixture-1234', priceIn: 30, priceOut: 150 }
  body.models.flash.apiKey = '••••9999' // 界面回传的打码值：必须保留原 Key 来源
  body.tiers.master.tasks = { write1: 'opus', revise: 'opus', plan: '' }
  const s = await A('/api/admin/tiers', body)
  ok(s.status === 200 && s.j.ok, '保存成功', s.j?.error || '')
  const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  ok(saved.models.opus.apiKey === 'sk-test-fixture-1234' && saved.models.opus.protocol === 'anthropic', '直接填的 Key 与协议存进管理员配置')
  ok(saved.models.opus.baseUrl === 'http://127.0.0.1:4732/v1', '贴了完整接口地址也会自动去掉 /messages', saved.models.opus.baseUrl)
  ok(!saved.models.flash.apiKey && saved.models.flash.keyEnv === 'QP_TEST_KEY', '回传打码值不会覆盖原 Key')
  ok(saved.tiers.master.tasks.write1 === 'opus' && !('plan' in saved.tiers.master.tasks), '环节映射保存；空选项 = 跟随基础模型')
  ok(saved._说明 === '保留字段' && saved.priceFactor === 1.3, '配置里其他字段原样保留')
  ok(!saved.tiers.fast.model && saved.models[saved.tiers.fast.use]?.model === 'legacy-model', '旧写法档位保存后转成新写法')
  ok(fs.existsSync(cfgFile + '.prev'), '保存前留了一份 .prev 备份')
  ok(s.j.models.opus.keyMask === '••••1234' && !JSON.stringify(s.j).includes('sk-test-fixture-1234'), '保存后返回的 Key 仍打码')

  // 3. 校验：坏输入一律拒绝，文件不变
  const before = fs.readFileSync(cfgFile, 'utf8')
  const bad = async (mut, name) => { const b = structuredClone(body); mut(b); const r = await A('/api/admin/tiers', b); ok(r.status === 400 && fs.readFileSync(cfgFile, 'utf8') === before, name, r.j?.error || '') }
  await bad((b) => { b.models.opus.baseUrl = 'ftp://x' }, '拒绝非 http(s) 的 Base URL')
  await bad((b) => { b.models.opus.model = '' }, '拒绝空模型名')
  await bad((b) => { b.models.opus.protocol = 'grpc' }, '拒绝未知协议')
  await bad((b) => { b.tiers.master.use = 'nope' }, '拒绝不存在的基础模型')
  await bad((b) => { b.tiers.master.tasks = { write1: 'nope' } }, '拒绝环节指向不存在的模型')
  await bad((b) => { b.tiers.master.tasks = { hack: 'opus' } }, '拒绝未知环节')
  await bad((b) => { Object.values(b.tiers).forEach((t) => (t.enabled = false)) }, '拒绝把所有档位都关掉')
  await bad((b) => { b.models.x = { protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' } }, '拒绝没有任何 Key 来源的模型')
  const xs = await fetch(`http://127.0.0.1:${ADMIN_PORT}/api/admin/tiers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(body) })
  ok(xs.status === 403, '拒绝跨站提交')

  // 4. 测试连接：两种协议都走对路径、对头
  hits.length = 0
  const t1 = await A('/api/admin/test', { id: 'opus', model: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:4732', model: 'claude-test', apiKey: '' } })
  const h1 = hits.at(-1)
  ok(t1.j.ok && t1.j.reply === '收到-anthropic', 'Anthropic 协议测试通过（Key 留空用已保存的）', t1.j.error || '')
  ok(h1?.path === '/v1/messages' && h1.ver === '2023-06-01' && h1.body.messages?.[0]?.role === 'user', '走 /v1/messages 并带 anthropic-version', h1?.path)
  const t2 = await A('/api/admin/test', { id: 'flash', model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:4731/v1', model: 'flash-model' } })
  ok(t2.j.ok && hits.at(-1).path === '/v1/chat/completions' && hits.at(-1).auth === 'Bearer sk-test-fixture-9999', 'OpenAI 协议测试走 /chat/completions，Key 取自环境变量')
  const t3 = await A('/api/admin/test', { id: 'opus', model: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:4732', model: 'claude-test', apiKey: 'sk-wrong' } })
  ok(!t3.j.ok && /401|Key/.test(t3.j.error), '错误 Key 给出人话报错', (t3.j.error || '').slice(0, 40))

  // 5. 客户实例：用新映射真实写作调用；不暴露任何管理接口
  const cust = await start({ ...base, WORKSHOP_MODE: 'customer', WORKSHOP_PORT: String(CUST_PORT), WORKSHOP_SANDBOX: path.join(usersDir, 'u1'), WORKSHOP_BUDGET: '3', WORKSHOP_TIER: 'master' })
  try {
    const C = (p, init) => fetch(`http://127.0.0.1:${CUST_PORT}${p}`, init).then(async (r) => ({ status: r.status, text: await r.text() }))
    const c1 = await C('/api/admin/tiers'); ok(c1.status === 404, '客户实例没有 /api/admin/tiers', String(c1.status))
    const c2 = await C('/api/admin/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); ok(c2.status === 404, '客户实例没有 /api/admin/test', String(c2.status))
    const c3 = await C('/admin'); ok(c3.status === 404 || !c3.text.includes('档位 → 模型'), '客户实例打不开管理后台', String(c3.status))
    const st = await C('/api/status'); ok(!/sk-direct|4732|claude-test|anthropic/i.test(st.text), '客户状态接口不含 Key / 地址 / 模型名')
  } finally { cust.kill() }

  // 6. 进程内：llm.chat 按映射走 Anthropic 协议并按单价计费；失败退回基础模型
  Object.assign(process.env, { WORKSHOP_MODE: 'customer', WORKSHOP_ADMIN_CONFIG: cfgFile, QP_TEST_KEY: 'sk-test-fixture-9999', WORKSHOP_SANDBOX: path.join(usersDir, 'u1'), WORKSHOP_BUDGET: '3', WORKSHOP_TIER: 'master' })
  const { chat } = await import('./lib/llm.mjs')
  hits.length = 0
  const r = await chat({ task: 'write1', user: '写', system: '你是写手' })
  const h = hits.at(-1)
  ok(r.content === '收到-anthropic' && h.srv === 'anthropic' && h.xkey === 'sk-test-fixture-1234', '写正文：走 Anthropic 协议 + 直接填的 Key')
  ok(typeof h.body.system === 'string' && h.body.system.includes('你是写手') && !h.body.messages.some((m) => m.role === 'system'), 'system 放在顶层字段，不混进 messages')
  ok(Math.abs(r.cost - (210 * 30 + 80 * 150) / 1e6) < 1e-9, '按 Anthropic 用量（含缓存读）× 单价计费', String(r.cost))
  hits.length = 0
  const r2 = await chat({ task: 'plan', user: 'x' })
  ok(r2.content === '收到-openai' && hits.at(-1).body.model === 'flash-model', '没单独指定的环节走基础模型（OpenAI 协议）')
  // Key 改坏 → 写正文失败 → 自动退回基础模型
  const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); c.models.opus.apiKey = 'sk-broken'; fs.writeFileSync(cfgFile, JSON.stringify(c))
  hits.length = 0
  const r3 = await chat({ task: 'write1', user: 'x' })
  ok(r3.content === '收到-openai' && hits.some((x) => x.srv === 'anthropic') && hits.at(-1).srv === 'openai', '分路模型 401 → 自动退回基础模型，用户不卡住', hits.map((x) => x.srv).join('→'))
} finally {
  admin.kill(); fakeOpenAI.close(); fakeAnth.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

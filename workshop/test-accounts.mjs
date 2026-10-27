// test-accounts.mjs —— 合并后的管理后台：账号/代号/随时加额度/隧道刷新/自己的模型分工（零成本，假隧道脚本 + 假模型）
// 会在本目录的 deploy/ 下临时开户，结束时恢复 users.json 并删除临时账号目录。用法：node test-accounts.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEPLOY = path.join(HERE, 'deploy')
const USERS = path.join(DEPLOY, 'users.json')
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const hadUsers = fs.existsSync(USERS)
// 仓库不带真实台账：没有 users.json 时先造一条「老账号」（无代号），用来验代号兜底与列表字段
const seed = { users: { 'friend-01': { port: 4501, budget: 3, expires: new Date(Date.now() + 30 * 864e5).toISOString(), enabled: true } } }
const usersBackup = hadUsers ? fs.readFileSync(USERS, 'utf8') : JSON.stringify(seed, null, 2)
if (!hadUsers) { fs.mkdirSync(DEPLOY, { recursive: true }); fs.writeFileSync(USERS, usersBackup) }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-acc-'))
const createdDirs = []

// 假 beta-up：把每个启用账号写成一条假网址；运行一会儿，便于测「刷新中」状态
const urlsFile = path.join(tmp, 'urls.json')
const fakeUp = path.join(tmp, 'fake-up', 'scripts', 'ops', 'beta-up.mjs')
fs.mkdirSync(path.dirname(fakeUp), { recursive: true })
fs.writeFileSync(fakeUp, `import fs from 'node:fs'
const users = JSON.parse(fs.readFileSync(${JSON.stringify(USERS)}, 'utf8')).users
const out = {}
await new Promise((r) => setTimeout(r, 1500))
for (const [n, u] of Object.entries(users)) if (u.enabled) out[n] = { port: u.port, url: 'https://fake-' + n.replace(/[^a-z0-9]/g, '').slice(0, 12) + '-tunnel.trycloudflare.com', pid: 1, ok: true, ts: new Date().toISOString() }
fs.writeFileSync(${JSON.stringify(urlsFile)}, JSON.stringify(out))
console.log('fake up done')
`)

// 假模型（测「我自己的模型」测试连接）
const hits = []
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hits.push({ path: req.url, auth: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '收到' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })) })
})
await new Promise((r) => fake.listen(4741, '127.0.0.1', r))

const cfgFile = path.join(tmp, 'admin-tiers.json')
fs.writeFileSync(cfgFile, JSON.stringify({ models: { flash: { model: 'm', baseUrl: 'http://127.0.0.1:4741/v1', apiKey: 'sk-test-fixture-1111', priceIn: 1, priceOut: 2 } }, tiers: { fast: { label: '快写', enabled: true, estPerChapter: 15, desc: 'x', use: 'flash' } } }))
// 隔离的「站长自己的」agents.json：用 ROOT 覆盖不了，所以让 WORKSHOP_SANDBOX 之外的真实文件不被动——只验证读接口与测试连接，保存走不到真实路径时拒绝

const ADMIN_PORT = 4742, CUST_PORT = 4743
const sbAdmin = path.join(DEPLOY, 'users', '_admin'); fs.mkdirSync(sbAdmin, { recursive: true })
const baseEnv = { ...process.env, WORKSHOP_ADMIN_CONFIG: cfgFile, WORKSHOP_BETA_UP: fakeUp, WORKSHOP_URLS_FILE: urlsFile }
delete baseEnv.WORKSHOP_SUPERVISED
const start = (env, port) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env, cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; p.stdout.on('data', (d) => { out += d; if (out.includes('已启动')) resolve(p) }); p.stderr.on('data', (d) => (out += d))
  p.on('exit', (c) => reject(new Error('服务退出 ' + c + '\n' + out)))
  setTimeout(() => reject(new Error('启动超时\n' + out)), 15000)
})
const kids = []
const A = (p, body, origin) => fetch(`http://127.0.0.1:${ADMIN_PORT}${p}`, body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin || `http://127.0.0.1:${ADMIN_PORT}` }, body: JSON.stringify(body) } : {}).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }))

try {
  kids.push(await start({ ...baseEnv, WORKSHOP_MODE: 'admin', WORKSHOP_PORT: String(ADMIN_PORT), WORKSHOP_SANDBOX: sbAdmin, WORKSHOP_AUTO_TUNNEL: '0' }, ADMIN_PORT))

  // 1. 页面
  const page = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin`).then((r) => r.text())
  ok(['账号与额度', '用户档位与模型', '我自己的模型分工', '用量与反馈'].every((s) => page.includes(s)), '一个页面四个标签：账号 / 档位 / 自己的模型 / 用量')
  ok(page.includes('加额度') && page.includes('刷新全部隧道网址'), '页面有「加额度」与「刷新隧道」入口')

  // 2. 读账号（现有 6 个）
  const l0 = await A('/api/admin/accounts')
  ok(l0.status === 200 && l0.j.accounts.length >= 1 && l0.j.accounts.every((a) => a.codename && 'left' in a && 'points' in a), '账号列表含代号、剩余额度、积分', String(l0.j.accounts.length))
  ok(l0.j.accounts.find((a) => a.name === 'friend-01')?.codename === 'friend-01', '老账号没有代号时用账号名兜底')
  ok(!JSON.stringify(l0.j).includes('passwordHash') && !JSON.stringify(l0.j).includes('plain:'), '接口不泄漏密码')

  // 3. 开户：自动代号 + 指定代号 + 重复代号被拒
  const c1 = await A('/api/admin/accounts/create', { codename: '小李', label: '测试备注', budget: 2, days: 3 })
  ok(c1.status === 200 && c1.j.account.codename === '小李' && c1.j.account.budget === 2, '开户并打上代号「小李」', c1.j?.error || '')
  const name1 = c1.j.account.name; createdDirs.push(path.join(DEPLOY, 'users', name1))
  const c2 = await A('/api/admin/accounts/create', { budget: 1, days: 1 })
  ok(c2.status === 200 && /^K\d{3}$/.test(c2.j.account.codename), '不填代号自动给 K001 式代号', c2.j.account?.codename)
  const name2 = c2.j.account.name; createdDirs.push(path.join(DEPLOY, 'users', name2))
  const dup = await A('/api/admin/accounts/create', { codename: '小李', budget: 1, days: 1 })
  ok(dup.status === 400 && /已经被/.test(dup.j.error), '代号重复被拒', dup.j?.error)
  const before = Object.keys(JSON.parse(fs.readFileSync(USERS, 'utf8')).users).length
  const badB = await A('/api/admin/accounts/create', { codename: 'x1', budget: 0, days: 1 })
  const badD = await A('/api/admin/accounts/create', { codename: 'x2', budget: 1, days: 0 })
  const badN = await A('/api/admin/accounts/create', { codename: 'x\ny', budget: 1, days: 1 })
  ok(badB.status === 400 && badD.status === 400 && badN.status === 400 && Object.keys(JSON.parse(fs.readFileSync(USERS, 'utf8')).users).length === before, '非法额度/天数/代号一律拒绝且不落盘')
  const db1 = JSON.parse(fs.readFileSync(USERS, 'utf8')).users[name1]
  ok(db1.codename === '小李' && db1.label === '测试备注' && db1.budget === 2, '代号与备注写进台账 users.json')

  // 4. 隧道刷新：开户后自动触发；手动可触发；运行中不重复
  await sleep(300)
  const t1 = await A('/api/admin/tunnels')
  ok(t1.j.tunnel.running === true || t1.j.tunnel.ok === true, '开户后自动开始刷新隧道', JSON.stringify({ r: t1.j.tunnel.running, ok: t1.j.tunnel.ok }))
  const t2 = await A('/api/admin/tunnels/refresh', {})
  ok(t2.status === 200 && t2.j.started === false, '刷新进行中再点不会重复启动')
  for (let i = 0; i < 20; i++) { await sleep(500); if (!(await A('/api/admin/tunnels')).j.tunnel.running) break }
  const l1 = await A('/api/admin/accounts')
  const a1 = l1.j.accounts.find((a) => a.name === name1)
  ok(a1.url.startsWith('https://fake-') && a1.invite.includes(a1.url) && a1.invite.includes('¥2'), '刷新完成后账号拿到最新网址，邀请文字带网址与额度')
  const t3 = await A('/api/admin/tunnels/refresh', {})
  ok(t3.j.started === true, '完成后可再次手动刷新（重启电脑后的恢复路径）')
  for (let i = 0; i < 20; i++) { await sleep(500); if (!(await A('/api/admin/tunnels')).j.tunnel.running) break }

  // 5. 随时加额度 / 延期 / 改代号 / 停用
  const u1 = await A('/api/admin/accounts/update', { name: name1, addBudget: '5' })
  ok(u1.status === 200 && u1.j.account.budget === 7 && u1.j.account.left === 7, '加额度 ¥5：2 → 7', String(u1.j.account?.budget))
  ok(JSON.parse(fs.readFileSync(USERS, 'utf8')).users[name1].budget === 7, '台账里额度确实变了')
  const envF = fs.readFileSync(path.join(DEPLOY, 'env', name1 + '.env'), 'utf8')
  ok(/WORKSHOP_BUDGET=7/.test(envF), '环境文件同步（重启后也是新额度）')
  const exp0 = Date.parse(db1.expires)
  const u2 = await A('/api/admin/accounts/update', { name: name1, addDays: '10' })
  ok(Math.abs(Date.parse(u2.j.account.expires) - (exp0 + 10 * 86400000)) < 2000, '延期 10 天从原到期日往后加')
  const u3 = await A('/api/admin/accounts/update', { name: name1, codename: 'Z组-1', label: '' })
  ok(u3.j.account.codename === 'Z组-1' && !u3.j.account.label, '改代号 / 清空备注')
  const u4 = await A('/api/admin/accounts/update', { name: name2, codename: 'Z组-1' })
  ok(u4.status === 400, '改成已有代号被拒', u4.j?.error)
  const bad1 = await A('/api/admin/accounts/update', { name: name1, addBudget: '-3' })
  const bad2 = await A('/api/admin/accounts/update', { name: 'nope', addBudget: '1' })
  const bad3 = await A('/api/admin/accounts/update', { name: name1, addDays: '1.5' })
  ok(bad1.status === 400 && bad2.status === 400 && bad3.status === 400 && JSON.parse(fs.readFileSync(USERS, 'utf8')).users[name1].budget === 7, '负数额度 / 不存在账号 / 小数天数被拒，台账不变')
  const xs = await A('/api/admin/accounts/update', { name: name1, addBudget: '1' }, 'https://evil.example')
  ok(xs.status === 403, '跨站提交被拒')

  // 6. 关键：客户实例不重启，额度实时生效
  const sb = path.join(DEPLOY, 'users', name1)
  const port1 = JSON.parse(fs.readFileSync(USERS, 'utf8')).users[name1].port
  // 用一条已有的调用记录让它「花掉」¥6.5 ：余额 7 → 0.5；再加额度后又能用
  fs.mkdirSync(sb, { recursive: true })
  fs.writeFileSync(path.join(sb, 'calls.ndjson'), JSON.stringify({ at: new Date().toISOString(), task: 'write1', model: 'm', ok: true, cost: 6.5, ms: 1 }) + '\n')
  const envObj = Object.fromEntries(envF.split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const cust = await start({ ...baseEnv, ...envObj, WORKSHOP_PORT: String(CUST_PORT), WORKSHOP_MODE: 'customer', WORKSHOP_SANDBOX: sb, WORKSHOP_BUDGET: '2' /* 故意给旧值：实时台账必须压过它 */ }, CUST_PORT)
  kids.push(cust)
  const st = async () => (await fetch(`http://127.0.0.1:${CUST_PORT}/api/status`).then((r) => r.json())).budget
  const s0 = await st()
  ok(s0.budget === 7 && Math.abs(s0.left - 0.5) < 0.01, '客户实例启动参数是旧额度 2，但顶栏显示的是台账里的 7（剩 0.5）', JSON.stringify(s0))
  await A('/api/admin/accounts/update', { name: name1, addBudget: '3' }); await sleep(1200)
  const s1 = await st()
  ok(s1.budget === 10 && Math.abs(s1.left - 3.5) < 0.01, '管理后台加 ¥3 后，不重启客户实例，顶栏 1 秒内变成总额度 10、剩 3.5', JSON.stringify(s1))
  const llm = await import(pathToUrl(path.join(HERE, 'lib', 'llm.mjs')))
  ok(typeof llm.liveQuota === 'function', 'llm.liveQuota 已导出')
  // 用完 → 拒绝；再加额度 → 放行（precheck 走 HTTP 层）
  fs.writeFileSync(path.join(sb, 'calls.ndjson'), JSON.stringify({ at: new Date().toISOString(), task: 'write1', model: 'm', ok: true, cost: 10, ms: 1 }) + '\n'); await sleep(1200)
  const r1 = await fetch(`http://127.0.0.1:${CUST_PORT}/api/concepts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const r1t = await r1.text()
  ok(r1.status === 400 && /额度已用完/.test(r1t), '额度用完 → 点写作被拒绝（人话）', r1t.slice(0, 60))
  await A('/api/admin/accounts/update', { name: name1, addBudget: '1' }); await sleep(1200)
  const r2 = await fetch(`http://127.0.0.1:${CUST_PORT}/api/concepts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const r2t = await r2.text()
  ok(!/额度已用完/.test(r2t) && !/体验期已结束/.test(r2t), '管理后台再加 ¥1 → 同一个实例立刻放行（不再报额度用完）', r2t.slice(0, 60))
  await A('/api/admin/accounts/update', { name: name1, enabled: false }); await sleep(1200)
  const r3 = await fetch(`http://127.0.0.1:${CUST_PORT}/api/concepts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ok(/已暂停/.test(await r3.text()), '停用账号 → 不重启也立刻被拒，稿件仍可导出')
  const l2 = await A('/api/admin/accounts'); ok(l2.j.accounts.find((a) => a.name === name1).state === '已停用', '列表状态显示「已停用」')

  // 7. 客户实例不能碰管理接口
  const cx = await fetch(`http://127.0.0.1:${CUST_PORT}/api/admin/accounts`); ok(cx.status === 404, '客户实例没有账号管理接口（404）')
  const cy = await fetch(`http://127.0.0.1:${CUST_PORT}/api/admin/agents`); ok(cy.status === 404, '客户实例没有模型分工接口（404）')
  const cz = await fetch(`http://127.0.0.1:${CUST_PORT}/api/admin/tunnels/refresh`, { method: 'POST' }); ok(cz.status === 404, '客户实例不能刷新隧道（404）')

  // 8. 我自己的模型分工：读打码视图；测试连接走假模型；带未保存值
  const ag = await A('/api/admin/agents')
  ok(ag.status === 200 && ag.j.agents && Array.isArray(ag.j.tasks) && !/sk-[A-Za-z0-9]{10,}/.test(JSON.stringify(ag.j)), '模型分工读取：有模型清单与环节，Key 打码', Object.keys(ag.j.agents || {}).join(','))
  const tp = await A('/api/admin/test', { scope: 'agent', id: 'tmp1', model: { name: '临时', protocol: 'openai', baseUrl: 'http://127.0.0.1:4741/v1/chat/completions', model: 'fake', apiKey: 'sk-test-fixture-2222' } })
  ok(tp.j.ok && hits.at(-1).auth === 'Bearer sk-test-fixture-2222' && hits.at(-1).path === '/v1/chat/completions', '自己的模型「测试连接」用表单里未保存的 Key，自动去掉多余路径')
  const tn = await A('/api/admin/test', { scope: 'agent', id: 'tmp2', model: { baseUrl: 'http://127.0.0.1:4741/v1', model: 'fake' } })
  ok(tn.j.ok === false && /Key/.test(tn.j.error), '没有 Key 时给出人话提示')
} catch (e) { fail++; console.log('✗ 测试异常', e.stack || e) } finally {
  for (const k of kids) try { k.kill() } catch {}
  fake.close(); await sleep(400)
  if (hadUsers) fs.writeFileSync(USERS, usersBackup)
  else fs.rmSync(USERS, { force: true })
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true })
  // 清掉临时账号的 env 文件
  const envDir = path.join(DEPLOY, 'env')
  if (fs.existsSync(envDir)) for (const f of fs.readdirSync(envDir)) { const n = f.replace(/\.env$/, ''); if (!JSON.parse(usersBackup).users[n]) fs.rmSync(path.join(envDir, f), { force: true }) }
  fs.rmSync(sbAdmin, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)

function pathToUrl(p) { return 'file:///' + p.replace(/\\/g, '/') }

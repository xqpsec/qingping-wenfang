// accounts.mjs —— 管理后台的「账号与额度」后端（只在 WORKSHOP_MODE=admin 的本机实例里加载）
// 2026-10-03 合并原 beta-invite 开户页：开户、代号、随时加额度/延期/停用、隧道刷新全部在这里。
// 账号台账仍是 deploy/users.json（唯一事实源）；客户实例每秒内实时读它的额度与到期（见 llm.mjs liveQuota），所以改完不用重启。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadUsers, saveUsers, userDir, readEnvFile, writeEnvFile, DEPLOY } from '../deploy/ulib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 隧道守护脚本与网址记录（可用环境变量覆盖，测试时指向假脚本）
// 这两项属于可选的隧道部署能力：不配置就只是管理台里那个按钮报错，不影响主流程。
const BETA_UP = process.env.WORKSHOP_BETA_UP || ''
const URLS_FILE = process.env.WORKSHOP_URLS_FILE || path.join(DEPLOY, 'urls.json')
const POINTS_PER_YUAN = 100

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const fail = (msg) => { const e = new Error(msg); e.status = 400; throw e }

function spentOf(db, name) {
  const log = path.join(userDir(db, name), 'calls.ndjson')
  let spent = 0, calls = 0
  if (!fs.existsSync(log)) return { spent, calls }
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (!line) continue
    try { const x = JSON.parse(line); calls++; spent += Number(x.cost) || 0 } catch { /* 坏行跳过 */ }
  }
  return { spent: +spent.toFixed(5), calls }
}

const stateOf = (u, left) => !u.enabled ? '已停用' : Date.parse(u.expires) < Date.now() ? '已到期' : (Number(u.budget) > 0 && left <= 0) ? '额度用完' : '正常'

export function listAccounts() {
  const db = loadUsers()
  const links = readJson(URLS_FILE, {})
  return Object.entries(db.users).map(([name, u]) => {
    const { spent, calls } = spentOf(db, name)
    const budget = Number(u.budget) || 0
    const left = +Math.max(0, budget - spent).toFixed(3)
    const link = links[name]
    const url = link?.url && link.port === u.port && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/.test(link.url) ? link.url : ''
    const daysLeft = u.expires ? Math.ceil((Date.parse(u.expires) - Date.now()) / 86400000) : 0
    return {
      name, codename: u.codename || name, label: u.label || '', port: u.port, enabled: u.enabled !== false,
      state: stateOf({ ...u, enabled: u.enabled !== false }, left),
      budget, spent, left, points: Math.round(left * POINTS_PER_YUAN), calls,
      expires: u.expires || '', daysLeft, createdAt: u.createdAt || '',
      url, urlOk: !!url && link?.ok === true, urlAt: link?.ts || '',
      dir: userDir(db, name),
    }
  })
}

export function inviteText(a) {
  if (!a.url) return ''
  const exp = a.expires ? new Date(a.expires).toLocaleString('zh-CN') : '未知'
  return `你好${a.label ? '，' + a.label : ''}！邀请你试用清平文坊。\n访问网址：${a.url}\n体验额度：¥${a.budget}（约 ${Math.round(a.budget * POINTS_PER_YUAN)} 积分），有效期至 ${exp}\n（软件在网页里用；稿件随时可导出。额度用完或到期后仍可查看和导出稿件。）\n链接本身就是访问凭证，请勿转发。`
}

function cleanText(v, max, what) {
  const s = String(v ?? '').trim()
  if (s.length > max) fail(`${what}最多 ${max} 个字`)
  if (/[\u0000-\u001f]/.test(s)) fail(`${what}不能含换行或控制字符`)
  return s
}
function checkCodename(db, code, selfName) {
  if (!code) fail('代号不能为空')
  const dup = Object.entries(db.users).find(([n, u]) => n !== selfName && String(u.codename || n).toLowerCase() === code.toLowerCase())
  if (dup) fail(`代号「${code}」已经被账号 ${dup[0]} 用了`)
}
function nextCodename(db) {
  const used = new Set(Object.entries(db.users).map(([n, u]) => String(u.codename || n).toLowerCase()))
  for (let i = 1; i < 1000; i++) { const c = 'K' + String(i).padStart(3, '0'); if (!used.has(c.toLowerCase())) return c }
  return 'K' + crypto.randomBytes(3).toString('hex')
}
const money = (v, what, { min = 0, max = 1000 } = {}) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max || Math.abs(Math.round(n * 100) - n * 100) > 1e-7) fail(`${what}须为 ${min}–${max} 元（最多两位小数）`)
  return n
}

/** 开户：生成隔离沙箱 + 端口 + 代号；网址由随后的隧道刷新生成 */
export async function createAccount(input) {
  const db0 = loadUsers()
  const codename = cleanText(input.codename, 20, '代号') || nextCodename(db0)
  const label = cleanText(input.label, 40, '备注')
  const budget = money(input.budget ?? 3, '体验额度', { min: 0.01, max: 1000 })
  const days = Number(input.days ?? 7)
  if (!Number.isInteger(days) || days < 1 || days > 3650) fail('有效期须为 1–3650 天')
  checkCodename(db0, codename, '')
  let name
  do { name = 'beta-' + crypto.randomBytes(6).toString('hex') } while (db0.users[name])
  await new Promise((resolve, reject) => execFile(process.execPath, [path.join(DEPLOY, 'add-user.mjs'), name, '--budget', String(budget), '--days', String(days)], { cwd: DEPLOY, timeout: 30000, windowsHide: true }, (e, so, se) => e ? reject(new Error('开户脚本失败：' + (se || e.message).toString().slice(0, 200))) : resolve(so)))
  // add-user 写完后再读一次，补代号/备注（写入三重校验：读回比对）
  const db = loadUsers()
  if (!db.users[name]) throw new Error('开户后在台账里找不到账号，请检查 users.json')
  db.users[name].codename = codename
  if (label) db.users[name].label = label
  saveUsers(db)
  const back = loadUsers().users[name]
  if (back.codename !== codename) throw new Error('代号写入后读回不一致，请重试')
  return listAccounts().find((a) => a.name === name)
}

/** 改账号：代号/备注/加额度/设额度/延期/停用启用。客户实例实时读台账，不用重启。 */
export function updateAccount(input) {
  const name = String(input.name || '')
  const db = loadUsers()
  const u = db.users[name]
  if (!u) fail('没有这个账号')
  const before = JSON.stringify(u)
  if (input.codename !== undefined) { const c = cleanText(input.codename, 20, '代号'); checkCodename(db, c, name); u.codename = c }
  if (input.label !== undefined) { const l = cleanText(input.label, 40, '备注'); if (l) u.label = l; else delete u.label }
  if (input.addBudget !== undefined && input.addBudget !== '') {
    const add = money(input.addBudget, '追加额度', { min: 0.01, max: 1000 })
    u.budget = +((Number(u.budget) || 0) + add).toFixed(2)
    if (u.budget > 100000) fail('额度总和过大')
  }
  if (input.budget !== undefined && input.budget !== '') u.budget = money(input.budget, '额度', { min: 0, max: 100000 })
  if (input.addDays !== undefined && input.addDays !== '') {
    const d = Number(input.addDays)
    if (!Number.isInteger(d) || d < 1 || d > 3650) fail('延期天数须为 1–3650 的整数')
    const from = Math.max(Date.now(), Date.parse(u.expires) || 0)
    u.expires = new Date(from + d * 86400000).toISOString()
  }
  if (input.enabled !== undefined) u.enabled = !!input.enabled
  if (JSON.stringify(u) !== before) {
    saveUsers(db)
    // 环境文件同步（实时读失败时的兜底值；不影响实时读）
    try { const env = readEnvFile(name); if (Object.keys(env).length) { env.WORKSHOP_BUDGET = String(u.budget); env.WORKSHOP_EXPIRES = u.expires; writeEnvFile(name, env) } } catch { /* 兜底文件写失败不阻塞 */ }
  }
  const back = loadUsers().users[name]
  if (JSON.stringify(back) !== JSON.stringify(u)) throw new Error('写入后读回不一致，请重试')
  return listAccounts().find((a) => a.name === name)
}

// ── 隧道刷新（重启/换网后网址会变；beta-up 幂等：只补挂掉的实例和隧道） ──
export const tunnelJob = { running: false, startedAt: 0, finishedAt: 0, ok: null, trigger: '', log: '' }
export function refreshTunnels(trigger = '手动') {
  if (tunnelJob.running) return { started: false, job: tunnelJob }
  if (!BETA_UP || !fs.existsSync(BETA_UP)) {
    Object.assign(tunnelJob, { running: false, startedAt: Date.now(), finishedAt: Date.now(), ok: false, trigger, log: '未配置 WORKSHOP_BETA_UP（隧道守护脚本），已跳过隧道刷新' })
    return { started: false, job: tunnelJob }
  }
  Object.assign(tunnelJob, { running: true, startedAt: Date.now(), finishedAt: 0, ok: null, trigger, log: '' })
  execFile(process.execPath, [BETA_UP], { cwd: path.dirname(path.dirname(path.dirname(BETA_UP))), timeout: 600000, maxBuffer: 4e6, windowsHide: true }, (e, so, se) => {
    tunnelJob.log = ((so || '') + (se || '')).slice(-3000) + (e ? '\n[失败] ' + e.message : '')
    Object.assign(tunnelJob, { running: false, finishedAt: Date.now(), ok: !e })
  })
  return { started: true, job: tunnelJob }
}

const probe = async (url, okStatus) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(7000) }); return okStatus(r.status) } catch { return false } }
/** 实测每个启用账号：本机实例是否在、公网网址是否通 */
export async function checkAll() {
  const accs = listAccounts().filter((a) => a.enabled)
  return Promise.all(accs.map(async (a) => ({
    name: a.name,
    portUp: await probe(`http://127.0.0.1:${a.port}/`, (s) => s < 500),
    urlUp: a.url ? await probe(a.url, (s) => s === 200) : false,
  })))
}

/** 管理后台路由。返回 [状态码, 对象]；不是账号路由返回 null */
export async function handle(method, pathname, query, readBody) {
  try {
    if (pathname === '/api/admin/accounts' && method === 'GET') return [200, { accounts: listAccounts().map((a) => ({ ...a, invite: inviteText(a) })), tunnel: tunnelJob }]
    if (pathname === '/api/admin/accounts/check' && method === 'GET') return [200, { checks: await checkAll(), tunnel: tunnelJob }]
    if (pathname === '/api/admin/accounts/create' && method === 'POST') {
      const a = await createAccount(await readBody())
      const t = refreshTunnels('开户后')
      return [200, { ok: true, account: a, tunnelStarted: t.started }]
    }
    if (pathname === '/api/admin/accounts/update' && method === 'POST') {
      const body = await readBody()
      const was = listAccounts().find((a) => a.name === body.name)
      const a = updateAccount(body)
      // 刚从停用恢复：补起实例和隧道
      const tunnelStarted = !!(was && !was.enabled && a.enabled) && refreshTunnels('重新启用').started
      return [200, { ok: true, account: { ...a, invite: inviteText(a) }, tunnelStarted }]
    }
    if (pathname === '/api/admin/tunnels' && method === 'GET') return [200, { tunnel: tunnelJob }]
    if (pathname === '/api/admin/tunnels/refresh' && method === 'POST') { const t = refreshTunnels('手动'); return [200, { ok: true, started: t.started, tunnel: tunnelJob }] }
    return null
  } catch (e) { return [e.status || 500, { error: String(e.message || e) }] }
}

/** 管理后台一启动就补齐一次隧道（WORKSHOP_AUTO_TUNNEL=1，由 start-admin.mjs 设置）：电脑重启后网址都变了，开后台即恢复 */
export function autoTunnelOnStart() {
  if (process.env.WORKSHOP_AUTO_TUNNEL === '1') setTimeout(() => refreshTunnels('后台启动'), 4000).unref()
}

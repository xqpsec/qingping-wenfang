// add-user.mjs —— 开户。用法：node add-user.mjs <用户名> [--budget 3] [--days 7] [--port 4601]
// 建沙箱目录、分配端口、设额度和到期、生成随机密码（只显示一次），输出「发给用户的账号卡」。
import fs from 'node:fs'
import path from 'node:path'
import { loadUsers, saveUsers, userDir, genPassword, hashPassword, writeEnvFile, DEPLOY } from './ulib.mjs'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--'))
if (!name || !/^[a-z0-9_-]{2,24}$/.test(name)) { console.log('用法：node add-user.mjs <用户名(字母数字_-，2-24位)> [--budget 3] [--days 7] [--port 4601]'); process.exit(1) }
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? Number(args[i + 1]) : d }
const budget = opt('budget', 3), days = opt('days', 7)

const db = loadUsers()
if (db.users[name]) { console.log(`❌ 用户 ${name} 已存在（端口 ${db.users[name].port}）`); process.exit(1) }

// 端口分配：portBase 起，跳过已占用
const used = new Set(Object.values(db.users).map((u) => u.port))
let port = opt('port', 0) || db.portBase || 4601
if (!opt('port', 0)) { while (used.has(port)) port++ }

const dir = userDir(db, name)
fs.mkdirSync(path.join(dir, 'books'), { recursive: true })
const expires = new Date(Date.now() + days * 86400000).toISOString()
const pw = genPassword()
const passwordHash = hashPassword(pw)
db.users[name] = { port, budget, expires, enabled: true, passwordHash, createdAt: new Date().toISOString() }
saveUsers(db)
writeEnvFile(name, {
  WORKSHOP_MODE: 'customer',
  WORKSHOP_SANDBOX: path.join(dir),
  WORKSHOP_PORT: String(port),
  WORKSHOP_BUDGET: String(budget),
  WORKSHOP_EXPIRES: expires,
  WORKSHOP_ADMIN_CONFIG: path.join(DEPLOY, 'admin-tiers.json'),
  WORKSHOP_SUPERVISED: '1',
})
if (passwordHash.startsWith('plain:')) console.log('⚠ 本机没有 caddy，密码以明文存进了 users.json（权限已收紧）。服务器上装好 caddy 后建议删掉该用户重建。')

const card = `【清平文坊 · 内测账号】
访问地址：http://<服务器地址>/${name}/
用户名：${name}
密　码：${pw}
有效期：${days} 天（至 ${new Date(expires).toLocaleString('zh-CN')}）
体验额度：¥${budget}
（软件在网页里用；稿件随时可导出。额度用完或到期后仍可查看和导出稿件。）`
fs.writeFileSync(path.join(dir, '-账号卡.txt'), card, 'utf8')
console.log(`✅ 已开户 ${name}（端口 ${port}，额度 ¥${budget}，${days} 天）\n\n${card}\n\n⚠ 密码只显示这一次，已同时存到 ${path.join(dir, '-账号卡.txt')}`)

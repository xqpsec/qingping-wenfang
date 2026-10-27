// ctl-user.mjs —— 用户管控。用法：
//   node ctl-user.mjs <用户名> --disable | --enable | --budget <元> | --days <N> | --reset-pw
import fs from 'node:fs'
import path from 'node:path'
import { loadUsers, saveUsers, userDir, genPassword, hashPassword, writeEnvFile, readEnvFile, DEPLOY } from './ulib.mjs'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--'))
const db = loadUsers()
const u = name && db.users[name]
if (!u) { console.log('用法：node ctl-user.mjs <用户名> --disable|--enable|--budget N|--days N|--reset-pw'); process.exit(1) }
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null }

const env = readEnvFile(name)
if (args.includes('--disable')) { u.enabled = false; console.log(`⛔ ${name} 已停用（进程要重启才生效：stop-all 后 start-all）`) }
if (args.includes('--enable')) { u.enabled = true; console.log(`✅ ${name} 已启用`) }
if (opt('budget')) { u.budget = Number(opt('budget')); env.WORKSHOP_BUDGET = String(u.budget); console.log(`额度改为 ¥${u.budget}`) }
if (opt('days')) { u.expires = new Date(Date.now() + Number(opt('days')) * 86400000).toISOString(); env.WORKSHOP_EXPIRES = u.expires; console.log(`到期改为 ${new Date(u.expires).toLocaleString('zh-CN')}`) }
if (args.includes('--reset-pw')) {
  const pw = genPassword(); u.passwordHash = hashPassword(pw)
  console.log(`新密码（只显示这一次）：${pw}\n记得把 Caddyfile 重新生成并 reload：node gen-caddy.mjs && caddy reload`)
}
writeEnvFile(name, env)
saveUsers(db)
console.log('完成。改额度/到期需要重启该用户进程才生效。')

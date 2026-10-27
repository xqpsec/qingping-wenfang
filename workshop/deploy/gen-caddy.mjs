// gen-caddy.mjs —— 从 users.json 生成 Caddyfile（每用户一个路径 + basic_auth → 本机端口）
// 用法：node gen-caddy.mjs [监听地址]（默认 :80；有域名改成 example.com 即自动 HTTPS）
import fs from 'node:fs'
import path from 'node:path'
import { loadUsers, DEPLOY } from './ulib.mjs'

const listen = process.argv[2] || ':80'
const db = loadUsers()
// 注释一律 ASCII（Windows 控制台是 GBK，中文注释会被显示成乱码，误导排错）
const lines = [listen + ' {']
let plainWarn = false
for (const [name, u] of Object.entries(db.users)) {
  if (!u.enabled) continue
  const hash = String(u.passwordHash || '')
  if (hash.startsWith('plain:')) { plainWarn = true; lines.push(`  # WARN: ${name} password is PLAINTEXT; run: node ctl-user.mjs ${name} --reset-pw  after caddy is installed`) }
  const h = hash.startsWith('plain:') ? hash.slice(6) : hash
  lines.push(`  handle_path /${name}/* {`)
  lines.push(`    basic_auth {`)
  lines.push(`      ${name} ${h}`)
  lines.push(`    }`)
  lines.push(`    reverse_proxy 127.0.0.1:${u.port}`)
  lines.push(`  }`)
}
lines.push(`  handle {`)
lines.push(`    respond "清平文坊 · 内测中，请用发给你的专属地址访问" 200`)
lines.push(`  }`)
lines.push(`}`)
const out = path.join(DEPLOY, 'Caddyfile')
fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log(`✅ 已生成 ${out}${plainWarn ? '\n⚠ 有明文密码条目，见文件内注释' : ''}\n生效：caddy validate --config ${out} && caddy reload --config ${out}`)

// start-all.mjs —— 启动所有启用中的用户进程（Windows/Linux 通用；Linux 生产建议用 systemd，见 install-linux.sh）
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadUsers, userDir, readEnvFile, isRunning, WORKSHOP } from './ulib.mjs'

const db = loadUsers()
let started = 0
for (const [name, u] of Object.entries(db.users)) {
  if (!u.enabled) { console.log(`⏭ ${name} 已停用，跳过`); continue }
  const pidFile = path.join(userDir(db, name), 'server.pid')
  if (fs.existsSync(pidFile) && isRunning(Number(fs.readFileSync(pidFile, 'utf8')))) { console.log(`⏭ ${name} 已在运行`); continue }
  const env = { ...process.env, ...readEnvFile(name) }
  const kid = spawn(process.execPath, [path.join(WORKSHOP, 'launcher.mjs')], { env, cwd: WORKSHOP, detached: true, stdio: 'ignore', windowsHide: true })
  kid.unref()
  fs.writeFileSync(pidFile, String(kid.pid), 'utf8')
  console.log(`🚀 ${name} → 端口 ${u.port}（pid ${kid.pid}）`)
  started++
}
console.log(`完成：新启动 ${started} 个进程`)

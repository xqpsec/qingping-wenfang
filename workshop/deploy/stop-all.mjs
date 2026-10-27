// stop-all.mjs —— 停止所有用户进程
import fs from 'node:fs'
import path from 'node:path'
import { loadUsers, userDir, isRunning } from './ulib.mjs'

const db = loadUsers()
for (const [name] of Object.entries(db.users)) {
  const pidFile = path.join(userDir(db, name), 'server.pid')
  if (!fs.existsSync(pidFile)) continue
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  if (isRunning(pid)) { try { process.kill(pid); console.log(`🛑 ${name}（pid ${pid}）已停止`) } catch { console.log(`⚠ ${name}（pid ${pid}）停止失败`) } }
  else console.log(`⏭ ${name} 本来就没在跑`)
  fs.rmSync(pidFile, { force: true })
}

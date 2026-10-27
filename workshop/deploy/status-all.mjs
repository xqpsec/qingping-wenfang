// status-all.mjs —— 所有用户进程状态 + 额度使用（读各自沙箱 calls.ndjson）
import fs from 'node:fs'
import path from 'node:path'
import { loadUsers, userDir, isRunning } from './ulib.mjs'

const db = loadUsers()
const rows = []
for (const [name, u] of Object.entries(db.users)) {
  const pidFile = path.join(userDir(db, name), 'server.pid')
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0
  let spent = 0
  const f = path.join(userDir(db, name), 'calls.ndjson')
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) { try { const x = JSON.parse(l); if (x.ok) spent += x.cost || 0 } catch { /* 坏行 */ } }
  const alive = pid && isRunning(pid)
  rows.push({ 用户: name, 端口: u.port, 进程: alive ? `运行中(${pid})` : '未运行', 启用: u.enabled ? '是' : '停用', 已用: '¥' + spent.toFixed(3), 额度: '¥' + u.budget, 到期: new Date(u.expires).toLocaleString('zh-CN') })
}
console.table(rows)

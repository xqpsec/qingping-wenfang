// _start-one.mjs —— 临时：只启动一个用户（不改工坊源码，仅本部署目录的辅助脚本）
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadUsers, userDir, readEnvFile, isRunning, WORKSHOP } from './ulib.mjs'

const name = process.argv[2]
const db = loadUsers()
const u = db.users[name]
if (!u) { console.log('no such user', name); process.exit(1) }
const pidFile = path.join(userDir(db, name), 'server.pid')
if (fs.existsSync(pidFile) && isRunning(Number(fs.readFileSync(pidFile, 'utf8')))) { console.log('already running'); process.exit(0) }
const env = { ...process.env, ...readEnvFile(name) }
const kid = spawn(process.execPath, [path.join(WORKSHOP, 'launcher.mjs')], { env, cwd: WORKSHOP, detached: true, stdio: 'ignore', windowsHide: true })
kid.unref()
fs.writeFileSync(pidFile, String(kid.pid), 'utf8')
console.log('started', name, 'port', u.port, 'pid', kid.pid)

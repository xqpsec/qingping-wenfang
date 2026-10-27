// start-admin.mjs —— 启动本机管理后台（只监听 127.0.0.1，不走隧道、不对外）
// 用法：node deploy/start-admin.mjs [端口，默认 4570]；或双击 deploy/打开管理后台.cmd
// 打开 http://127.0.0.1:4570/admin ：账号与额度（代号、随时加额度、隧道网址）、用户档位与模型、自己的模型分工、用量与反馈，全在这一个页面。
// 启动后自动补一次隧道（WORKSHOP_AUTO_TUNNEL=0 可关闭）：电脑重启后网址变了，打开后台即恢复。
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { DEPLOY, WORKSHOP } from './ulib.mjs'

const port = Number(process.argv[2]) || 4570
const sandbox = path.join(DEPLOY, 'users', '_admin') // 用量查询只允许看 deploy/users 之下
fs.mkdirSync(sandbox, { recursive: true })
const busy = await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); r(true) }); s.on('error', () => r(false)) })
if (busy) { console.log(`管理后台已经在运行：http://127.0.0.1:${port}/admin`); process.exit(0) }
const env = { ...process.env, WORKSHOP_MODE: 'admin', WORKSHOP_PORT: String(port), WORKSHOP_SANDBOX: sandbox, WORKSHOP_ADMIN_CONFIG: path.join(DEPLOY, 'admin-tiers.json'), WORKSHOP_AUTO_TUNNEL: process.env.WORKSHOP_AUTO_TUNNEL ?? '1' }
const kid = spawn(process.execPath, [path.join(WORKSHOP, 'launcher.mjs')], { env, cwd: WORKSHOP, detached: true, stdio: 'ignore', windowsHide: true })
kid.unref()
fs.writeFileSync(path.join(sandbox, 'server.pid'), String(kid.pid), 'utf8')
console.log(`管理后台已启动：http://127.0.0.1:${port}/admin  （pid ${kid.pid}，只有本机能打开）`)

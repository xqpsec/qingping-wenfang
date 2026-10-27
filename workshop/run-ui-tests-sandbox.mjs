// run-ui-tests-sandbox.mjs —— 零成本：起一个非内测（管理员视角）的临时沙箱实例，放一本带 1 章的书，跑 ui-smoke 与 test-coach-ui，跑完删干净
// 为什么：在内测实例（customer 模式）上跑，会因为「模型入口按设计隐藏」误报失败（2026-10-02 实测 3 项）。
// 用法：node workshop/run-ui-tests-sandbox.mjs [端口=4598]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 4598)
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-uitest-'))
const agents = path.join(HERE, 'data', 'agents.json')
if (fs.existsSync(agents)) fs.copyFileSync(agents, path.join(SB, 'agents.json')) // 只为页面能列出 agent，测试不点任何花钱按钮
// ui-smoke 要求书有设定集与包装 → 从真书库复制一本「有 bible.md 且有章节」的书进沙箱（只读复制，真书不受影响）
const REAL = path.join(HERE, '..', 'projects', 'workshop-books')
const src = fs.existsSync(REAL) && fs.readdirSync(REAL).map((d) => path.join(REAL, d))
  .filter((d) => fs.existsSync(path.join(d, 'bible.md')) && fs.existsSync(path.join(d, 'chapters')) && fs.readdirSync(path.join(d, 'chapters')).length)
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
if (!src) { console.error('真书库里没有带设定集和章节的书，无法给 ui-smoke 做夹具'); process.exit(2) }
fs.cpSync(src, path.join(SB, 'books', path.basename(src)), { recursive: true })
console.log(`夹具：复制 ${path.basename(src)}`)
process.env.WORKSHOP_SANDBOX = SB

const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env: { ...process.env, WORKSHOP_PORT: String(PORT), WORKSHOP_SANDBOX: SB }, stdio: 'ignore' })
let code = 0
try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/status`); break } catch { await new Promise((r) => setTimeout(r, 250)) } }
  for (const t of ['ui-smoke.mjs', 'test-coach-ui.mjs']) {
    const r = spawnSync(process.execPath, [path.join(HERE, t), String(PORT)], { encoding: 'utf8', env: { ...process.env, WORKSHOP_SANDBOX: SB } })
    const out = (r.stdout + r.stderr).trim().split('\n')
    console.log(`== ${t} exit ${r.status}`); console.log(out.filter((l) => l.startsWith('✗')).join('\n') || '(无失败项)'); console.log(out.at(-1))
    if (r.status) code = 1
  }
} finally { srv.kill(); await new Promise((r) => setTimeout(r, 500)); fs.rmSync(SB, { recursive: true, force: true }) }
process.exit(code)

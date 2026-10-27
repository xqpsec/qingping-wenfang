// qa.mjs —— 改完工坊后的一键验收：零成本测试 → 界面冒烟 → 模拟真人用户（花钱，有预算上限）
// 用法：node workshop/qa.mjs [--sim=revise,history] [--budget=0.6] [--no-sim]
// 不经过 DSH：模拟用户直接调用工坊自己配置的 cheap agent（DeepSeek flash），可以挂到定时任务（kind=command）里跑。
import { spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d }
const run = (file, args = [], env = {}) => spawnSync(process.execPath, [path.join(HERE, file), ...args], { stdio: 'inherit', env: { ...process.env, ...env } }).status
let fail = 0
for (const f of ['test.mjs', 'test-revision.mjs']) if (run(f)) { console.log(`✗ ${f} 失败`); fail++ }
// 冒烟只使用临时副本，服务与测试均不接触真实书稿写入。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-qa-'))
const { BOOKS } = await import('./lib/store.mjs')
fs.cpSync(BOOKS, path.join(sandbox, 'books'), { recursive: true })
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { stdio: 'ignore', env: { ...process.env, WORKSHOP_PORT: String(port), WORKSHOP_SANDBOX: sandbox } })
await new Promise((r) => setTimeout(r, 2000))
if (run('ui-smoke.mjs', [String(port)])) { console.log('✗ 界面冒烟失败'); fail++ }
srv.kill()
if (!fail && !process.argv.includes('--no-sim')) {
  run('user-sim.mjs', [`--task=${arg('sim', 'revise,history,export')}`, '--steps=25', `--budget=${arg('budget', '0.6')}`])
  run('triage.mjs') // 第二层：另一家便宜模型初审，只把「通用问题」排进 data/qa-queue.json
}
console.log(fail ? `\n${fail} 项自动测试失败（模拟用户未运行）` : '\n自动测试全部通过；模拟用户报告见 workshop/data/user-sim/')
process.exit(fail ? 1 : 0)

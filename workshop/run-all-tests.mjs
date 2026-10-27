// run-all-tests.mjs —— 跑全部零成本测试套件（不需要浏览器、不需要真实网关）
// 用法：node workshop/run-all-tests.mjs [--verbose]
// 跳过需要 Playwright/浏览器、真实网关或私有多用户台账的套件；它们仍可单独 node 运行。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const verbose = process.argv.includes('--verbose')

// 需要浏览器、真实付费网关或私有部署台账，默认跳过
const SKIP = new Set([
  'test-agent-ui.mjs', // Playwright
  'test-coach-ui.mjs', // Playwright
  'test-fanqie-ui.mjs', // Playwright
  'test-settle-ui.mjs', // Playwright
  'test-import.mjs', // Playwright
  'test-live.mjs', // 真实网关，会花钱
  'test-customer-lab.mjs', // 客户模式多实例
  'test-lab-v2.mjs', // 客户模式多实例
  'test-desktop-delivery.mjs', // 桌面交付，需要真人桌面
])

const files = fs.readdirSync(HERE).filter((f) => /^test.*\.mjs$/.test(f) && !SKIP.has(f)).sort()
const rows = []
for (const f of files) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [f], { cwd: HERE, encoding: 'utf8', timeout: 300000 })
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).filter(Boolean)
  const tail = out.slice(-1)[0] || ''
  const ms = Date.now() - started
  rows.push({ file: f, code: r.status, ms, tail: tail.slice(0, 160) })
  console.log(`${r.status === 0 ? 'PASS ' : 'FAIL '} ${f.padEnd(34)} ${String(ms).padStart(6)}ms  ${tail.slice(0, 100)}`)
  if (r.status !== 0 && verbose) console.log(out.slice(-25).join('\n'))
}

const fails = rows.filter((r) => r.code !== 0)
console.log(`\nsum: ran=${rows.length} pass=${rows.length - fails.length} fail=${fails.length}`)
if (fails.length) {
  console.log('\nfailures:')
  for (const r of fails) console.log(`  ${r.file} :: ${r.tail}`)
}
process.exit(fails.length ? 1 : 0)

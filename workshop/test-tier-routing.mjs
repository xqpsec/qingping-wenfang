// test-tier-routing.mjs —— 内测档位「按任务分路」+ 失败退回基础模型 + 积分换算的零成本测试
// 本机起两个假模型服务（A=顶级写手、B=基础模型），不调真实 API。用法：node test-tier-routing.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`) }

const hits = []
const fake = (port, label, { fail500 = false } = {}) => new Promise((res) => {
  const s = http.createServer((req, rsp) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const j = JSON.parse(b || '{}'); hits.push({ label, model: j.model })
      if (fail500) { rsp.writeHead(402, { 'content-type': 'application/json' }); return rsp.end('{"error":"余额不足"}') }
      rsp.writeHead(200, { 'content-type': 'application/json' })
      rsp.end(JSON.stringify({ choices: [{ message: { content: `来自${label}` } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }))
    })
  }).listen(port, '127.0.0.1', () => res(s))
})
const A = await fake(4711, 'A'), B = await fake(4712, 'B'), C = await fake(4713, 'C', { fail500: true })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tierroute-'))
const cfg = {
  models: {
    top: { model: 'top-model', baseUrl: 'http://127.0.0.1:4711/v1', keyEnv: 'TK', priceIn: 30, priceOut: 150 },
    base: { model: 'base-model', baseUrl: 'http://127.0.0.1:4712/v1', keyEnv: 'TK', priceIn: 1, priceOut: 2 },
    broken: { model: 'broken-model', baseUrl: 'http://127.0.0.1:4713/v1', keyEnv: 'TK', priceIn: 30, priceOut: 150 },
  },
  tiers: {
    master: { label: '大师档', enabled: true, estPerChapter: 90, desc: '顶级写手', use: 'base', tasks: { write1: 'top', revise: 'broken' } },
    fast: { label: '快写档', enabled: true, estPerChapter: 15, use: 'base' },
    legacy: { label: '旧写法', enabled: true, model: 'base-model', baseUrl: 'http://127.0.0.1:4712/v1', keyEnv: 'TK', priceIn: 1, priceOut: 2 },
  },
}
fs.writeFileSync(path.join(tmp, 'cfg.json'), JSON.stringify(cfg))
Object.assign(process.env, { WORKSHOP_MODE: 'customer', WORKSHOP_ADMIN_CONFIG: path.join(tmp, 'cfg.json'), WORKSHOP_SANDBOX: tmp, WORKSHOP_BUDGET: '3', TK: 'sk-test-fixture-xxxx', WORKSHOP_TIER: 'master' })

const T = await import('./lib/tiers.mjs')
const { chat } = await import('./lib/llm.mjs')

const list = T.tierList()
ok(list.length === 3 && list[0].perChapter === 90 && list[0].desc === '顶级写手', '档位清单带说明与每章积分，不带模型信息', JSON.stringify(list[0]))
ok(!JSON.stringify(list).includes('model'), '档位清单里没有 model 字段')

ok(T.resolveTier('write1').model === 'top-model' && T.resolveTier('write1').routed, '大师档：候选稿 1 走顶级模型')
ok(T.resolveTier('plan').model === 'base-model' && !T.resolveTier('plan').routed, '大师档：没单独指定的任务走基础模型')
ok(T.resolveTier('write1', { base: true }).model === 'base-model', 'base=true 强制基础模型')

hits.length = 0
const r1 = await chat({ task: 'write1', user: 'x' })
ok(r1.content === '来自A' && hits.at(-1).model === 'top-model', '真实调用：写正文打到顶级模型')
ok(Math.abs(r1.cost - (1000 * 30 + 1000 * 150) / 1e6) < 1e-9, '按顶级模型单价计费', String(r1.cost))

hits.length = 0
const r2 = await chat({ task: 'revise', user: 'x' })
ok(r2.content === '来自B' && hits.some((h) => h.model === 'broken-model') && hits.at(-1).model === 'base-model', '分路模型报错 → 自动退回基础模型，用户不卡住', hits.map((h) => h.model).join('→'))

T.setTier('fast')
hits.length = 0
await chat({ task: 'write1', user: 'x' })
ok(hits.at(-1).model === 'base-model', '快写档：写正文走基础模型')
T.setTier('legacy')
ok(T.resolveTier('write1').model === 'base-model', '旧写法档位（model 直接写在档位里）仍兼容')

ok(T.modelToLabel('top-model') !== 'top-model' && !/top/.test(T.modelToLabel('top-model')), '分路模型名在调用记录里显示为档位名', T.modelToLabel('top-model'))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} 通过 / ${fail} 失败`)
// 先断开 keep-alive 连接再退出：Windows 上直接 close+exit 会触发 libuv 断言（UV_HANDLE_CLOSING）
for (const s of [A, B, C]) { s.closeAllConnections?.(); s.close() }
setTimeout(() => process.exit(fail ? 1 : 0), 200)

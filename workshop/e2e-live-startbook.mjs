// e2e-live-startbook.mjs —— 真实网关端到端：在临时沙箱起一个客户模式实例，开一本书，每 2 秒记一帧看板（job.live）
// 花钱：默认快写档（便宜模型）约 ¥0.02–0.05；跑完删沙箱。真人实例与真实书库不受影响。
// 用法：node e2e-live-startbook.mjs [端口=4619] [档位=fast]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 4619)
const TIER = process.argv[3] || 'fast'
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-e2elive-'))
// 用线上档位配置（只读复制到沙箱外的临时文件；仓库只带 admin-tiers.example.json，没有真配置就跳过）
const tiersSrc = path.join(HERE, 'deploy', 'admin-tiers.json')
const hasTiers = fs.existsSync(tiersSrc)
const cfgTmp = path.join(os.tmpdir(), `e2e-tiers-${Date.now()}.json`)
if (hasTiers) fs.copyFileSync(tiersSrc, cfgTmp)
const env = { ...process.env, WORKSHOP_MODE: 'customer', WORKSHOP_PORT: String(PORT), WORKSHOP_SANDBOX: SB, ...(hasTiers ? { WORKSHOP_ADMIN_CONFIG: cfgTmp } : {}), WORKSHOP_TIER: TIER, WORKSHOP_BUDGET: '1', WORKSHOP_USERS_FILE: path.join(SB, 'none.json') }
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env, stdio: 'ignore', windowsHide: true })
const base = `http://127.0.0.1:${PORT}`
const api = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j }
const concept = '书名：《外卖签到成神》\n一句话卖点：骑手每天最后一单签到就拿修为，用一次就得送一单地狱差评单。\n风格：吐槽流\n主角：陈野，24 岁外卖骑手，欠房租、母亲住院。\n金手指：骑手端多出一个签到按钮，地点越离谱收益越高。\n开局：废弃烂尾楼最后一单。'
const frames = []
let code = 0
try {
  for (let i = 0; i < 60; i++) { try { await api('/api/status'); break } catch { await new Promise((r) => setTimeout(r, 250)) } }
  const t0 = Date.now()
  await api('/api/start', { concept, idea: '外卖骑手签到成神', style: 'urban-brain' })
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await api('/api/status'); const j = s.job
    frames.push({ t: Math.round((Date.now() - t0) / 1000), running: j.running, live: j.live, err: j.error })
    const L = j.live || {}
    console.log(`${String(frames.at(-1).t).padStart(4)}s ${L.step || '-'} ${String(L.pct ?? '-').padStart(3)}% 卡片${Object.keys(L.card || {}).length} 章${(L.chapters || []).length} ${L.switched ? '[切线]' : ''} ${L.think || ''}`)
    if (!j.running) { if (j.error) { console.log('失败：', j.error); code = 1 } else console.log('完成：', j.done); break }
    if (Date.now() - t0 > 15 * 60000) { console.log('超时 15 分钟'); code = 1; break }
  }
  const raw = JSON.stringify(frames)
  const leak = raw.match(/deepseek|gpt|claude|custom|https?:\/\//i)
  console.log(`帧数 ${frames.length}；有思维摘要的帧 ${frames.filter((f) => f.live?.think).length}；不同摘要 ${new Set(frames.map((f) => f.live?.think).filter(Boolean)).size} 句；泄漏词 ${leak ? leak[0] : '无'}`)
  if (leak) code = 1
  const calls = fs.existsSync(path.join(SB, 'calls.ndjson')) ? fs.readFileSync(path.join(SB, 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  console.log('调用：', calls.map((c) => `${c.task}/${c.ok ? 'ok' : 'fail'}/${Math.round(c.ms / 1000)}s/¥${c.cost ?? 0}${c.est ? '(估)' : ''}`).join('  '), ' 合计 ¥' + calls.reduce((a, c) => a + (c.cost || 0), 0).toFixed(4))
  const outDir = process.env.WORKSHOP_E2E_OUT || path.join(os.tmpdir(), 'qingping-e2e')
  fs.mkdirSync(outDir, { recursive: true })
  const outF = path.join(outDir, `e2e-live-startbook-${TIER}-${Date.now()}.json`)
  fs.writeFileSync(outF, JSON.stringify({ tier: TIER, frames, calls }, null, 1), 'utf8'); console.log('saved', outF)
} catch (e) { console.log('出错：', e.message); code = 1 } finally {
  srv.kill(); await new Promise((r) => setTimeout(r, 600))
  fs.rmSync(SB, { recursive: true, force: true }); fs.rmSync(cfgTmp, { force: true })
}
process.exit(code)

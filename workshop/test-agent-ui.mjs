// test-agent-ui.mjs —— 智能代理（Beta）的接口 + 页面端到端（零成本，本机假模型 + 临时沙箱）：node workshop/test-agent-ui.mjs
// 接口：开关关着时拒绝 → 打开 → 拟计划 → 页面出现计划与「确认开始」→ 确认 → 写章 → 完成后按钮变成「清除记录」，进程里不剩后台任务。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-agentui-'))
const para = (s) => Array.from({ length: 45 }, (_, i) => `${s}第${i}段，林川抬眼看着对面那人，说了一句：“你再说一遍？”`).join('\n\n')
const fake = http.createServer(async (req, res) => {
  let s = ''; for await (const c of req) s += c
  const u = JSON.parse(s).messages.at(-1).content
  const out = /只输出 JSON：\{"think"/.test(u) ? (/已写 1\)/.test(u) || /（已写 [1-9]/.test(u) ? '{"think":"够了","action":"finish"}' : '{"think":"写","action":"write_next"}')
    : /用 3–6 条短句/.test(u) ? '1. 写一章\n完成标准：写够 1 章'
      : /结论=甲 或 结论=乙/.test(u) ? '结论=甲|2'
        : /read_next=/.test(u) ? ['hook_open', 'conflict', 'payoff', 'novelty', 'protagonist', 'density', 'dialogue', 'humor', 'logic', 'cliff'].map((k) => `${k}=7|x`).join('\n') + '\nread_next=50|x\nbest=a\nworst=b\nfix1=c'
          : /摘要：/.test(u) && /新增事实/.test(u) ? '摘要：x\n新增事实：无\n未回收悬念：无\n章末钩子类型：悬念\n爽点类型：反转'
            : /每章严格一行/.test(u) ? Array.from({ length: 6 }, (_, i) => `${i + 1}|章名${i + 1}字数够|目标|压|扬|爽|悬念|最后一幕是个很具体的画面`).join('\n')
              : /节拍序号/.test(u) ? '1. 开场｜x｜y｜800' : /硬伤/.test(u) ? '' : `第1章 假章名\n\n${para('原稿')}`
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: out } }], usage: { prompt_tokens: 500, completion_tokens: 300 } }))
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const agent = { name: '假', baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'fake', apiKey: 'x', priceIn: 1, priceOut: 1 }
fs.writeFileSync(path.join(SB, 'agents.json'), JSON.stringify({ agents: { cheap: agent, writer: agent, gpt: agent }, assign: {} }))
fs.writeFileSync(path.join(SB, 'settings.json'), JSON.stringify({ candidates: 1 }))
const bid = 'book-x'; const bd = path.join(SB, 'books', bid); fs.mkdirSync(path.join(bd, 'chapters'), { recursive: true })
fs.writeFileSync(path.join(bd, 'book.json'), JSON.stringify({ id: bid, title: '测试书', genre: 'urban-naodong', platform: 'tomato', stage: 'writing', chapters: [], createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', cost: 0 }))
fs.writeFileSync(path.join(bd, 'outline.md'), Array.from({ length: 6 }, (_, i) => `${i + 1}|章名${i + 1}字数够|目标|压|扬|爽|悬念|最后一幕是个很具体的画面`).join('\n'))
fs.writeFileSync(path.join(bd, 'bible.md'), '设定'); fs.writeFileSync(path.join(bd, 'concept.md'), '书名：测试书\n')

const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const PORT = await free(), DBG = await free()
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env: { ...process.env, WORKSHOP_SANDBOX: SB, WORKSHOP_PORT: String(PORT), WORKSHOP_KNOWLEDGE: path.join(SB, 'none') }, cwd: HERE, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const J = async (p, body) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, j: await r.json().catch(() => ({})) } }
let pass = 0, fail = 0
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n) } else { fail++; console.log('  ❌', n, x) } }
const jobDone = async () => { for (let i = 0; i < 400; i++) { const s = (await J('/api/status')).j; if (!s.job.running) return s.job; await sleep(100) } throw new Error('任务超时') }

let edge, ws
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/books`); break } catch { await sleep(200) } }
  console.log('— 接口 —')
  ok((await J('/api/agent/plan', { id: bid, instruction: 'x' })).status === 400, '开关关着：拟计划被拒绝')
  ok((await J('/api/agent/start', {})).status === 400, '开关关着：启动被拒绝')
  ok((await J('/api/agent')).j.enabled === false, '默认关闭')
  ok((await J('/api/settings', { agentBeta: true })).j.agentBeta === true, '打开开关')
  ok((await J('/api/agent/start', {})).status === 400, '没拟计划就启动 → 拒绝')

  console.log('— 页面 —')
  const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
  edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(SB, 'prof')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let target; for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()).find((t) => t.type === 'page') } catch { /* 等 */ } }
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r))
  let seq = 0; const pend = new Map(); const errs = []
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } else if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text) }
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result.value }
  await cdp('Runtime.enable'); await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(1500)
  await ev(`openBook('${bid}','pWrite')`); await sleep(1200)
  ok(await ev(`!document.querySelector('#agentCard').classList.contains('hide') && document.querySelector('#agentBeta').checked`), '写正文页有代理卡片，开关已勾选')
  ok(await ev(`!document.querySelector('#agentBox').classList.contains('hide')`), '开启后展开指令输入')
  await ev(`document.querySelector('#agIns').value='写 1 章'; document.querySelector('#agCh').value='1'; document.querySelector('#btnAgPlan').click()`)
  await jobDone(); await sleep(3000)
  ok(await ev(`/完成标准/.test(document.querySelector('#agPlan').textContent)`), '页面显示代理的计划')
  ok(await ev(`[...document.querySelectorAll('#agBtns button')].map(b=>b.textContent).join('|')`) === '确认开始|放弃这份计划', '计划出来后只有「确认开始 / 放弃」，没有自动开跑')
  ok(JSON.parse(fs.readFileSync(path.join(bd, 'book.json'), 'utf8')).chapters.length === 0, '确认前一章都没写')
  await ev(`document.querySelector('[data-ag=agStart]').click()`)
  await sleep(500); const job = await jobDone(); await sleep(3000)
  ok(job.outcome === 'ok', '代理任务正常结束', JSON.stringify(job))
  ok(JSON.parse(fs.readFileSync(path.join(bd, 'book.json'), 'utf8')).chapters.length === 1, '写完目标章数')
  ok(await ev(`[...document.querySelectorAll('#agBtns button')].map(b=>b.textContent).join('|')`) === '清除记录，开始新任务', '完成后只剩「清除记录」，不会再自己跑')
  ok(/已完成/.test(await ev(`document.querySelector('#agStat').textContent`)), '状态显示已完成')
  await sleep(3000); ok((await J('/api/status')).j.job.running === false, '结束后 3 秒内没有新任务自己冒出来（无空转）')
  ok(errs.length === 0, '页面没有 JS 异常', errs.join(' | ').slice(0, 200))
  await ev(`document.querySelector('#fTitle').value='一二三四五六七八九十一二三四五'; titleCount(); document.querySelector('#titleLen').textContent`).then((t) => ok(/15\/15/.test(t), '书名框实时显示 15/15 字', t))
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
} catch (e) { console.log('❌ 异常：', e.message); fail++ } finally {
  try { ws?.close() } catch { /* 关 */ } edge?.kill(); srv.kill(); fake.close()
  await sleep(500); fs.rmSync(SB, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

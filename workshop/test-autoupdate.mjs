// test-autoupdate.mjs —— 零成本验收：代码更新后不用关黑色窗口
// ① launcher 托管的后台在空闲时自动换新版本 ② 页面自动刷新并回到原来的书页/面板 ③ 顶部不再挂「后台还是旧版本」
// ④ 封面面板有预览图 ⑤ 非托管后台的警告里有「一键重启后台」按钮
// 用法：node workshop/test-autoupdate.mjs   （不调用任何模型；只 touch 一下 lib/metrics.mjs 的修改时间，不改内容）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
let fail = 0
const check = (name, ok, info = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${info ? '  ' + info : ''}`); if (!ok) fail++ }

const PORT = await freePort(), DBG = await freePort()
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-au-books-'))
const BOOK = path.join(SANDBOX, 'books', 'sample-book')
fs.mkdirSync(path.join(BOOK, 'chapters'), { recursive: true })
fs.writeFileSync(path.join(BOOK, 'book.json'), JSON.stringify({ id: 'sample-book', title: '示例书', genre: 'urban-naodong', platform: 'tomato', stage: 'writing', chapters: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', cost: 0 }, null, 2), 'utf8')
fs.writeFileSync(path.join(BOOK, 'chapters', '0001.txt'), '第1章 示例\n\n这是验收用的示例正文。\n', 'utf8')
const env = { ...process.env, WORKSHOP_PORT: String(PORT), WORKSHOP_RESTART_QUIET_MS: '1500', WORKSHOP_SANDBOX: SANDBOX }
const launcher = spawn(process.execPath, [path.join(HERE, 'launcher.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
const out = []; launcher.stdout.on('data', (d) => out.push(String(d))); launcher.stderr.on('data', (d) => out.push(String(d)))
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-au-'))
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const status = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json() } catch { return null } }
let ws, seq = 0; const pending = new Map()
const cdp = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })) }
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const touched = path.join(HERE, 'lib', 'metrics.mjs')
try {
  let s0; for (let i = 0; i < 40 && !s0; i++) { await sleep(250); s0 = await status() }
  check('托管模式启动', s0?.supervised === true, JSON.stringify({ supervised: s0?.supervised }))
  let target; for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()).find((t) => t.type === 'page') } catch { } }
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } }
  await cdp('Runtime.enable'); await cdp('Page.enable')
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(2500)
  // 打开第一本书的「书名·简介·封面」面板，在改写意见框里留一句话（模拟没提交的输入）
  await ev(`(async () => { document.querySelector('#books button').click(); await new Promise(r => setTimeout(r, 1200)); setPanel('pPack'); document.querySelector('#coverExtra').value = '人物更大'; window.__marker = 1 })()`)
  const before = await ev(`({ panel: cur.panel, book: cur.book, img: (() => { const i = document.querySelector('#coverImg'); return i.style.display !== 'none' ? i.naturalWidth : -1 })() })`)
  check('封面面板显示预览图', before.img !== 0, `naturalWidth=${before.img}（-1 表示这本书还没封面）`)
  // 改代码：只更新修改时间
  const t = new Date(); fs.utimesSync(touched, t, t)
  const s1 = await status(); check('改代码后后台标记待切换', s1?.pendingRestart === true)
  // 等后台换版本 + 页面自动刷新
  let s2, reloaded = false
  for (let i = 0; i < 60; i++) { await sleep(500); s2 = await status(); if (s2 && s2.startedAt !== s0.startedAt) { await sleep(4000); reloaded = await ev(`window.__marker !== 1`).catch(() => false); if (reloaded) break } }
  check('后台自动换成新版本（不用关窗口）', s2 && s2.startedAt !== s0.startedAt && s2.codeStale === false, `startedAt ${s0.startedAt} → ${s2?.startedAt}`)
  check('页面自动刷新', reloaded)
  await sleep(1500)
  const after = await ev(`({ panel: cur.panel, book: cur.book, extra: document.querySelector('#coverExtra').value, warn: document.querySelector('#verWarn').classList.contains('hide') ? '' : document.querySelector('#verWarn').innerText })`)
  check('刷新后回到同一本书同一面板', after.book === before.book && after.panel === 'pPack', JSON.stringify({ book: after.book, panel: after.panel }))
  check('没提交的输入保留', after.extra === '人物更大', after.extra)
  check('不再提示「后台还是旧版本」', !/旧版本/.test(after.warn), after.warn)
} catch (e) { check('测试过程无异常', false, e.message) }
finally { try { ws?.close() } catch { } edge.kill(); launcher.kill(); await sleep(800); try { process.kill(-launcher.pid) } catch { } }
// 托管的 server 子进程：按端口清掉
try { spawn('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force }`], { stdio: 'ignore' }) } catch { }
await sleep(1500); try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { }

// ⑤ 非托管：直接起 server.mjs，改代码后应显示一键重启按钮
const P2 = await freePort()
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env: { ...process.env, WORKSHOP_PORT: String(P2) }, stdio: 'ignore' })
await sleep(1500); const t2 = new Date(); fs.utimesSync(touched, t2, t2)
try {
  const s = await (await fetch(`http://127.0.0.1:${P2}/api/status`)).json()
  check('非托管后台：标记旧版本但不自动重启', s.codeStale === true && s.supervised === false)
  const r = await fetch(`http://127.0.0.1:${P2}/api/restart`, { method: 'POST' }); const j = await r.json()
  check('非托管后台：重启接口给出明确说明', r.status === 400 && /start\.cmd/.test(j.error || ''), j.error)
} catch (e) { check('非托管检查无异常', false, e.message) }
srv.kill()
console.log(fail ? `\n${fail} 项失败` : '\n全部通过'); process.exit(fail ? 1 : 0)

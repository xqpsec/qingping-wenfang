// test-fanqie-ui.mjs —— 零成本：沙箱实例 + 无头 Edge，验收「番茄作品信息」选择器：词表渲染 / 点选 / 数量上限 / 换频道 / 保存 / 读回
// 用法：node test-fanqie-ui.mjs [端口]   端口必须是空闲的（脚本会先检查，被占用直接退出，绝不打到在用的内测实例）
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 4621)
const DBG = 9448
const inUse = (p) => new Promise((r) => { const s = net.connect(p, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true) }); s.on('error', () => r(false)) })
if (await inUse(PORT)) { console.error(`端口 ${PORT} 已被占用（可能是在用的内测实例），拒绝运行`); process.exit(2) }
if (await inUse(DBG)) { console.error(`调试端口 ${DBG} 已被占用，拒绝运行`); process.exit(2) }
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fqui-'))
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fqui-prof-'))
const REAL = path.join(HERE, '..', 'projects', 'workshop-books')
const src = fs.readdirSync(REAL).map((d) => path.join(REAL, d)).filter((d) => fs.existsSync(path.join(d, 'bible.md')) && fs.existsSync(path.join(d, 'chapters'))).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
const bookId = path.basename(src)
fs.cpSync(src, path.join(SB, 'books', bookId), { recursive: true })
// 给沙箱书塞一份假的包装草稿（零成本），用来验证「当前采用的作品信息」区域
fs.writeFileSync(path.join(SB, 'books', bookId, 'package.json'), JSON.stringify({ history: [], latest: { at: new Date().toISOString(), instruction: '', patterns: [], sellingPoint: '测试', titles: [{ title: '测试书名一二三', why: '' }], recommend: 0, intro: '测试简介', meta: { audience: 'male', signMode: 'serial', read: { main: '都市脑洞', theme: [], role: [], plot: [] }, content: { plot: [], emotion: [], persona: [], world: [] }, heroes: [] }, metaProblems: [], tags: [], coverPrompt: {} } }))
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env: { ...process.env, WORKSHOP_PORT: String(PORT), WORKSHOP_SANDBOX: SB }, stdio: 'ignore' })
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws, seq = 0, fail = 0; const pending = new Map()
const cdp = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })) }
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const check = (name, ok, info = '') => { const good = !!ok; console.log(`${good ? '✓' : '✗'} ${name}${info ? '  ' + info : ''}`); if (!good) fail++ }
try {
  for (let i = 0; i < 60; i++) { if (await inUse(PORT)) break; await sleep(250) }
  let target; for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()).find((t) => t.type === 'page' && !/^edge:/.test(t.url)) } catch { } }
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } }
  await cdp('Runtime.enable'); await cdp('Page.enable')
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(2500)
  await ev(`window.alert = (m) => { window.__alerts = (window.__alerts || []).concat(String(m)) }`)
  await ev(`document.querySelector('#books button').click()`); await sleep(2000)
  await ev(`document.querySelector('#steps button[data-p="pPack"]').click()`); await sleep(1200)

  check('词表接口可用且数量正确', await ev(`fetch('/api/fanqie-spec').then(r => r.json()).then(j => j.spec.read.male.main.length === 19 && j.spec.read.female.main.length === 21 && j.spec.content.plot.length === 144)`))
  check('选择器已渲染（8 组标签）', await ev(`document.querySelectorAll('#mGroups .mgrp').length === 8`))
  const aud0 = await ev(`document.querySelector('input[name=mAud]:checked')?.value`)
  check('目标读者有默认值（按创作风格）', aud0 === 'male' || aud0 === 'female', aud0)
  // 切到男频，主分类词表 19 个
  await ev(`document.querySelector('input[name=mAud][value=male]').click()`); await sleep(200)
  check('男频主分类 19 个', await ev(`document.querySelectorAll('#mGroups .mgrp:nth-child(1) .chip').length`) === 19)
  await ev(`document.querySelector('input[name=mAud][value=female]').click()`); await sleep(200)
  check('切女频后主分类变 21 个且含「女频悬疑」', await ev(`(() => { const c = [...document.querySelectorAll('#mGroups .mgrp:nth-child(1) .chip')]; return c.length === 21 && c.some((x) => x.dataset.w === '女频悬疑') })()`))
  await ev(`document.querySelector('input[name=mAud][value=male]').click()`); await sleep(200)
  // 点选：主分类单选、主题上限 2
  await ev(`(() => { const g = document.querySelectorAll('#mGroups .mgrp'); const click = (i, w) => [...g[i].querySelectorAll('.chip')].find((x) => x.dataset.w === w).click(); click(0, '都市脑洞'); click(0, '都市日常'); click(1, '都市'); click(1, '玄幻'); click(1, '历史') })()`); await sleep(150)
  check('主分类只能 1 个（后点覆盖）', await ev(`document.querySelectorAll('#mGroups .mgrp:nth-child(1) .chip.on').length === 1 && document.querySelector('#mGroups .mgrp:nth-child(1) .chip.on').dataset.w === '都市日常'`))
  check('主题最多 2 个，第 3 个被拦并提示', await ev(`document.querySelectorAll('#mGroups .mgrp:nth-child(2) .chip.on').length === 2 && /最多选 2 个/.test(document.querySelector('#mMsg').textContent)`))
  // 内容标签：情节+人设合计 4
  await ev(`(() => { const g = document.querySelectorAll('#mGroups .mgrp'); const click = (i, w) => [...g[i].querySelectorAll('.chip')].find((x) => x.dataset.w === w).click(); for (const w of ['读心', '复仇', '逆袭']) click(4, w); click(5, '马甲'); click(5, '神医') })()`); await sleep(150)
  check('情节+人设合计最多 4 个', await ev(`document.querySelectorAll('#mGroups .mgrp:nth-child(5) .chip.on').length + document.querySelectorAll('#mGroups .mgrp:nth-child(6) .chip.on').length === 4`))
  await ev(`document.querySelector('#fHero1').value = '林川'; document.querySelector('#fHero2').value = '陈默'; document.querySelector('#fHero1').dispatchEvent(new Event('input'))`)
  // 包装方案区与选择器上方的「当前采用」摘要必须随点选同步（含未保存的修改）
  check('包装方案区显示当前采用的标签并同步', await ev(`(() => { const t = document.querySelector('#curMetaBox')?.textContent || ''; return t.includes('主分类 都市日常') && t.includes('读心') && t.includes('马甲') && !t.includes('神医') && t.includes('林川') })()`), await ev(`document.querySelector('#curMetaBox')?.textContent || '(无 curMetaBox)'`))
  check('选择器上方摘要同步', await ev(`(document.querySelector('#mSummary')?.textContent || '').includes('都市日常')`))
  await ev(`[...document.querySelectorAll('#mGroups .mgrp')[0].querySelectorAll('.chip')].find((x) => x.dataset.w === '都市日常').click()`); await sleep(100)
  check('取消选择后两处摘要同步变化', await ev(`!(document.querySelector('#curMetaBox').textContent.includes('主分类 都市日常')) && !(document.querySelector('#mSummary').textContent.includes('主分类 都市日常'))`))
  await ev(`[...document.querySelectorAll('#mGroups .mgrp')[0].querySelectorAll('.chip')].find((x) => x.dataset.w === '都市日常').click()`); await sleep(100)
  await ev(`document.querySelector('#btnSavePack').click()`); await sleep(1500)
  const saved = await ev(`fetch('/api/book?id=${encodeURIComponent(bookId)}').then(r => r.json()).then(b => b.package)`)
  check('保存后读回：主分类/主题/主角名一致', saved?.meta?.read?.main === '都市日常' && JSON.stringify(saved.meta.read.theme) === JSON.stringify(['都市', '玄幻']) && JSON.stringify(saved.meta.heroes) === JSON.stringify(['林川', '陈默']), JSON.stringify(saved?.meta?.read))
  check('保存后 tags 为拍平的合法词', Array.isArray(saved?.tags) && saved.tags.includes('都市日常') && saved.tags.includes('读心'))
  // 刷新后界面回显
  await ev(`document.querySelector('#steps button[data-p="pWrite"]').click()`); await sleep(300)
  await ev(`document.querySelector('#steps button[data-p="pPack"]').click()`); await sleep(1200)
  check('回显：已选标签保持', await ev(`document.querySelector('#mGroups .mgrp:nth-child(1) .chip.on')?.dataset.w === '都市日常' && document.querySelectorAll('#mGroups .mgrp:nth-child(2) .chip.on').length === 2 && document.querySelector('#fHero1').value === '林川'`))
  // 服务端严格校验：绕过界面直接提交非法词必须被拒
  const bad = await ev(`fetch('/api/package/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ${JSON.stringify(bookId)}, meta: { audience: 'male', read: { main: '不存在的分类' } } }) }).then(async (r) => ({ ok: r.ok, j: await r.json() }))`)
  check('接口拒绝非词表标签', !bad.ok && /不符合番茄规则/.test(bad.j.error || ''), bad.j.error)
  check('页面无意外弹窗', !(await ev(`(window.__alerts || []).length`)), await ev(`(window.__alerts || []).join('|')`))
} catch (e) { console.error('✗ 测试异常：', e.message); fail++ } finally {
  try { ws?.close() } catch { }
  srv.kill(); edge.kill(); await sleep(800)
  fs.rmSync(SB, { recursive: true, force: true }); fs.rmSync(prof, { recursive: true, force: true })
}
console.log(fail ? `\n${fail} 项失败` : '\n番茄作品信息界面全部通过')
process.exit(fail ? 1 : 0)

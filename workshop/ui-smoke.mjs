// ui-smoke.mjs —— 零成本界面冒烟测试：用无头 Edge 打开工坊，逐个点击书页阶段按钮，确认对应面板切换且有内容
// 用法：先启动 server（node workshop/server.mjs），再 node workshop/ui-smoke.mjs [端口]
// 不调用任何模型接口；只点「切换面板」类按钮，不点会花钱的按钮
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.argv[2] || process.env.WORKSHOP_PORT || 4580)
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
if (!EDGE) { console.error('找不到 Edge'); process.exit(2) }
const DBG = 9447 // 9444 留给「真人闸门」可见浏览器（scripts/human-gate），撞端口会劫持主办方的标签页（2026-10-02 事故）
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-smoke-'))
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws, seq = 0
const pending = new Map()
function cdp(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

let fail = 0
const check = (name, ok, info = '') => { const good = !!(ok && (typeof ok !== 'object' || ok.ok)); const extra = ok && typeof ok === 'object' ? JSON.stringify(ok) : info; console.log(`${good ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); if (!good) fail++ }

try {
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try { target = (await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()).find((t) => t.type === 'page') } catch { }
  }
  if (!target) throw new Error('无头 Edge 没启动')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } }
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(2500)

  const nBooks = await evalJs(`document.querySelectorAll('#books button').length`)
  check('首页列出书', nBooks > 0, `${nBooks} 本`)
  await evalJs(`document.querySelector('#books button').click()`)
  await sleep(1500)
  check('打开书页', await evalJs(`!document.querySelector('#bookPage').classList.contains('hide')`))

  const steps = await evalJs(`[...document.querySelectorAll('#steps button')].map(b => ({ p: b.dataset.p, t: b.textContent.trim() }))`)
  for (const s of steps) {
    await evalJs(`document.querySelector('#steps button[data-p="${s.p}"]').click()`)
    await sleep(300)
    const st = await evalJs(`(() => {
      const vis = [...document.querySelectorAll('.panel')].filter(x => !x.classList.contains('hide')).map(x => x.id)
      const el = document.getElementById('${s.p}')
      return { vis, len: (el.innerText || '').trim().length, cur: document.querySelector('#steps button[data-p="${s.p}"]').classList.contains('cur') }
    })()`)
    check(`点击「${s.t}」`, st.vis.length === 1 && st.vis[0] === s.p && st.cur && st.len > 50, `显示=${st.vis.join(',')} 字数=${st.len}`)
  }
  check('人物卡编辑入口及字段齐全', await evalJs(`document.querySelectorAll('#characterCards [data-char]').length >= 9 && !!document.querySelector('#saveCharacters')`))
  // 具体内容抽查
  check('设定集有内容', await evalJs(`document.querySelector('#bible').innerText.length > 200`))
  check('写正文有章节表', await evalJs(`document.querySelectorAll('#chapters tr').length > 0`))
  check('导出预览有书名/简介/总字数', await evalJs(`/书名：/.test(document.querySelector('#exportPreview').innerText) && /简介（\\d+ 字）/.test(document.querySelector('#exportPreview').innerText) && /总字数：/.test(document.querySelector('#exportPreview').innerText)`))
  await evalJs(`document.querySelector('#steps button[data-p="pWrite"]').click()`)
  check('章节表字数和分数分开', await evalJs(`(() => { const cells = [...document.querySelectorAll('#chapters tr td')].map((x) => x.innerText.trim()); return { n: cells.length, c2: cells[2] || '', c3: cells[3] || '', ok: cells.length >= 4 && /字/.test(cells[2]) && cells[2] !== cells[3] } })()`))
  // 润色器下拉与服务端设置一致；关闭时「自动润色」不可勾（不写死默认值 —— 主办方会在界面上改它）
  const pol = await evalJs(`fetch('/api/status').then(r => r.json()).then(s => ({ want: s.settings.polish || 'off', got: document.querySelector('#polishSel').value, dis: document.querySelector('#autoPolish').disabled }))`)
  check('润色器下拉与设置一致', pol.want === pol.got && (pol.want !== 'off' || pol.dis), JSON.stringify(pol))
  await evalJs(`document.querySelector('#steps button[data-p="pPack"]').click()`)
  check('简单模式可以编辑封面提示词', await evalJs(`(() => { document.body.classList.add('simple'); const el = document.querySelector('#fCoverZh'); return !!el && getComputedStyle(el.parentElement).display !== 'none' && el.offsetWidth > 0 })()`))
  check('中文修改清除旧英文优先项', await evalJs(`(() => { const zh = document.querySelector('#fCoverZh'), en = document.querySelector('#fCoverEn'); const oldZh = zh.value, oldEn = en.value; zh.value = '测试画面'; en.value = 'old prompt'; zh.dispatchEvent(new Event('input', { bubbles:true })); const ok = en.value === ''; zh.value = oldZh; en.value = oldEn; packDirty = false; return ok })()`))
  check('停止接口在无任务时幂等返回', await evalJs(`fetch('/api/job/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }).then(r => r.json()).then(r => r.ok === true)`))
  check('包装面板书名/简介可编辑', await evalJs(`!!document.querySelector('#fTitle').value && document.querySelector('#fIntro').value.length > 50 && !document.querySelector('#fIntro').readOnly`))
  // 页面与后台版本一致（2026-10-01 事故：改了代码没重启，新页面配旧接口）
  check('页面与后台版本一致', await evalJs(`document.querySelector('#verWarn').classList.contains('hide')`))
  // 旧版本列表：时间能显示、点「预览」能看到正文（2026-10-01 主办方截图：Invalid Date + 弹「找不到历史版本」）
  await evalJs(`window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m))`)
  const hasCh = await evalJs(`!!document.querySelector('#chapters button[data-n]')`)
  if (hasCh) {
    await evalJs(`document.querySelector('#chapters button[data-n]').click()`); await sleep(1500)
    const h = await evalJs(`({ rows: document.querySelectorAll('#hist tbody tr').length, bad: /Invalid Date/.test(document.querySelector('#hist').innerText) })`)
    check('旧版本列表时间正常', !h.bad, JSON.stringify(h))
    if (h.rows) {
      await evalJs(`document.querySelector('#hist button.prev').click()`); await sleep(1200)
      const pv = await evalJs(`({ alerts: window.__alerts, which: document.querySelector('#chWhich').textContent.slice(0, 40), len: document.querySelector('#chText').textContent.length })`)
      check('旧版本「预览」能打开正文', !pv.alerts.length && /正在预览/.test(pv.which) && pv.len > 200, JSON.stringify(pv))
    }
  }
  // 进入模型与 Agent 页
  await evalJs(`document.querySelector('#btnAgents').click()`)
  await sleep(1200)
  const ag = await evalJs(`({ vis: !document.querySelector('#agentsPage').classList.contains('hide'), inputs: document.querySelectorAll('#agentsPage [data-k=baseUrl]').length, keys: document.querySelectorAll('#agentsPage [data-k=apiKey]').length, names: document.querySelectorAll('#agentsPage [data-k=name]').length })`)
  check('模型与 Agent 页：每个 agent 有名称/BaseURL/Key 输入框', ag.vis && ag.inputs > 0 && ag.inputs === ag.keys && ag.keys === ag.names, JSON.stringify(ag))
  check('选段合并仅采用勾选块且冲突不提示定稿', await evalJs(`(() => {
    const sample = { text: '第1章 测试\\n\\n保留段\\n\\n旧句\\n\\n尾段\\n', revision: { instruction: '测试', text: '', diff: { changes: [{at:2,del:['旧句'],add:['新句']},{at:3,del:['尾段'],add:['不要采用']}] }, compare: { advice: {level:'mixed',text:'冲突'}, before: {total:68}, after:{total:57}, pair:{winner:1} } } }
    renderRevision(sample); document.querySelector('[data-rev-block="0"]').checked = true; document.querySelector('#btnRevPartial').click()
    return !document.querySelector('#settleBox') && document.querySelector('#chText').textContent === '第1章 测试\\n\\n保留段\\n\\n新句\\n\\n尾段\\n'
  })()`))
  check('批量设置仅改变本组，收集无 undefined 键且不保存真实配置', await evalJs(`(() => {
    const sels = [...document.querySelectorAll('#assignList select[data-task]')], original = sels.map(s => s.value)
    const group = document.querySelector('#bulkGroup').options[1].value, agent = document.querySelector('#bulkAgent').options[1].value
    document.querySelector('#bulkGroup').value = group; document.querySelector('#bulkAgent').value = agent; document.querySelector('#bulkApply').click()
    const ok = sels.every((s,i) => s.closest('label').dataset.taskGroup === group ? s.value === agent : s.value === original[i])
    collect(); const clean = !Object.hasOwn(agentsCfg.assign, 'undefined')
    sels.forEach((s,i) => s.value = original[i]); collect()
    return ok && clean
  })()`))
} catch (e) { console.error('✗ 冒烟测试异常：', e.message); fail++ }
finally {
  try { ws?.close() } catch { }
  edge.kill()
  await sleep(500)
  try { fs.rmSync(prof, { recursive: true, force: true }) } catch { }
}
console.log(fail ? `\n${fail} 项失败` : '\n界面冒烟全部通过')
process.exit(fail ? 1 : 0)

// test-tools.mjs —— 零成本回归：创意工具箱（lib/tools.mjs）+ 章节划选 AI 动作
// 用法：node test-tools.mjs
// 做法：起本机假模型服务（同 test-revision.mjs 的做法）+ 临时沙箱书库；不发起任何真实模型调用。
// 覆盖：工具清单、每个工具的提示词、书名超长过滤、6 种划选动作的提示词、错误输入、
//       内测档位下 tool/selection 任务不抛错、MODEL_ROUTES 登记、以及起一个隔离实例走通两个接口。
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-tools-'))
let lastReq = null, reply = ''

// ── 假模型：记录最后一次请求，按 reply 回话 ──
const fake = http.createServer(async (req, res) => {
  let s = ''; for await (const c of req) s += c
  const body = JSON.parse(s); lastReq = body.messages
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }))
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${fake.address().port}/v1`
const agent = { name: '假模型', baseUrl: base, model: 'fake', apiKey: 'x', priceIn: 1, priceOut: 1 }
fs.writeFileSync(path.join(SB, 'agents.json'), JSON.stringify({ agents: { cheap: agent, writer: agent, gpt: agent }, assign: {} }))
process.env.WORKSHOP_SANDBOX = SB

const S = await import('./lib/store.mjs')
const TL = await import('./lib/tools.mjs')
const AGS = await import('./lib/agents.mjs')
let pass = 0
const t = async (name, fn) => { await fn(); pass++; console.log('✓', name) }
const rejects = (fn, re) => assert.throws(fn, re)
let child = null

try {
  assert.ok(S.BOOKS.startsWith(SB), '书库没有进沙箱')
  const b = S.createBook('测试书')
  const chap = `第1章 开端\n\n${Array.from({ length: 30 }, (_, i) => `林川在第${i}个路口停下脚步，抬头看了看灰蒙蒙的天，心里盘算着下一步。`).join('\n\n')}\n`
  S.commitChapter(b.id, 1, chap, { title: '开端', chars: 900, summary: '林川决定去找那个欠他钱的人' })
  S.writeText(b.id, 'bible.md', '# 设定集\n主角林川，外卖员，能看见别人欠债。')

  await t('工具清单 ≥10 个，每个都有输入项、标签和说明', () => {
    const list = TL.toolList()
    assert.ok(list.length >= 10, '工具数 ' + list.length)
    for (const need of ['书名', '简介', '大纲', '细纲（单章）', '黄金开篇', '金手指', '人设', '世界观', '取名', '脑洞']) assert.ok(list.some((x) => x.label === need), '缺工具：' + need)
    for (const x of list) {
      assert.ok(x.id && x.label && x.desc, x.id + ' 缺字段')
      assert.ok(x.inputs.length >= 1 && x.inputs.length <= 3, x.id + ' 输入框数量应为 1~3：' + x.inputs.length)
      assert.ok(x.inputs.some((i) => i.required), x.id + ' 至少一个必填项')
      for (const i of x.inputs) assert.ok(i.label && (i.type === 'select' || i.placeholder), x.id + '.' + i.key + ' 缺例子占位符')
    }
    assert.equal(new Set(list.map((x) => x.id)).size, list.length, '工具 id 重复')
    assert.equal(list.find((x) => x.id === 'title').apply, 'title')
    assert.equal(list.find((x) => x.id === 'intro').apply, 'intro')
  })

  await t('每个工具的提示词都能拼出，且含作者输入；多候选工具要求编号', () => {
    const ctx = TL.bookContext(b.id)
    for (const x of TL.toolList()) {
      const vals = {}; x.inputs.forEach((i) => { vals[i.key] = i.type === 'select' ? i.options[0] : '输入标记' + i.key })
      const p = TL.buildToolPrompt(x.id, vals, null)
      for (const i of x.inputs) if (i.type !== 'select') assert.ok(p.user.includes('输入标记' + i.key), x.id + ' 提示词里没有输入 ' + i.key)
      assert.ok(/只输出|不要解释/.test(p.system), x.id + ' 缺"只输出结果"要求')
      assert.ok(!p.user.includes('本书资料'), x.id + ' 不绑定书时不该带本书资料')
      const pb = TL.buildToolPrompt(x.id, vals, ctx)
      assert.ok(pb.user.includes('本书资料') && pb.user.includes('林川，外卖员'), x.id + ' 绑定书后没带入设定集')
      assert.ok(p.maxTokens >= 1000)
      if (x.multi) assert.ok(/编号|「1\.」/.test(p.user), x.id + ' 多候选工具没要求编号')
    }
    assert.ok(TL.buildToolPrompt('title', { idea: 'x' }).user.includes('15'), '书名提示词应带 15 字上限')
    assert.ok(TL.buildToolPrompt('naming', { kind: '功法', hint: 'x' }).user.includes('8 个功法'))
  })

  await t('绑定书自动带入：风格规则≤1500字、设定集≤3000字、最近 2 章前情', () => {
    S.writeText(b.id, 'bible.md', '设' + '长'.repeat(4000))
    const c = TL.bookContext(b.id)
    assert.ok(c.bible.length === 3000, 'bible 长度 ' + c.bible.length)
    assert.ok(c.styleRules.length <= 1500 && c.styleLabel, '风格规则长度/标签')
    assert.ok(c.recap.includes('林川决定去找那个欠他钱的人'), '前情没带入')
    S.writeText(b.id, 'bible.md', '# 设定集\n主角林川，外卖员，能看见别人欠债。')
    assert.equal(TL.bookContext(''), null)
  })

  await t('输入校验：必填项缺失报人话；不绑定书时一句话必填，绑定后可空；下拉值被收敛', () => {
    rejects(() => TL.checkTool('title', {}, { bound: false }), /请先填写/)
    assert.doesNotThrow(() => TL.checkTool('title', {}, { bound: true }))
    rejects(() => TL.checkTool('detail', {}, { bound: true }), /请先填写/)
    rejects(() => TL.checkTool('nope', {}), /没有这个工具/)
    assert.equal(TL.checkTool('naming', { kind: '乱写', hint: 'x' }).kind, '人名')
    assert.equal(TL.checkTool('intro', { idea: 'a'.repeat(2000) }).idea.length, 800)
  })

  await t('书名超过 15 字被过滤并记录，书名号/解释被清理，重复去重', () => {
    const r = TL.filterTitles('1. 《我能看见你的欠条》\n2. 这是一个明显超过十五个汉字的超长书名啊啊啊啊\n3. 外卖员的逆袭——反差大\n4. 我能看见你的欠条')
    assert.deepEqual(r.kept, ['我能看见你的欠条', '外卖员的逆袭'])
    assert.equal(r.dropped.length, 1)
    assert.ok(r.dropped[0].len > 15)
    assert.ok(r.text.startsWith('1. 我能看见你的欠条\n2. 外卖员的逆袭'))
    const edge = TL.filterTitles('1. ' + '字'.repeat(15) + '\n2. ' + '字'.repeat(16))
    assert.equal(edge.kept.length, 1); assert.equal(edge.dropped.length, 1)
  })

  await t('runTool 走假模型：书名只留 ≤15 字；其它工具原样返回；空返回报错；成本记到书上', async () => {
    reply = '1. 我能看见你的欠条\n2. ' + '超长'.repeat(10) + '\n3. 送外卖送出个债主'
    const r = await TL.runTool({ id: b.id, tool: 'title', inputs: { idea: '外卖员能看欠债' } })
    assert.deepEqual(r.titles, ['我能看见你的欠条', '送外卖送出个债主'])
    assert.equal(r.dropped.length, 1)
    assert.ok(lastReq.some((m) => m.role === 'user' && m.content.includes('外卖员能看欠债')))
    assert.ok(lastReq.some((m) => m.content.includes('设定集')), '绑定书应带设定集')
    assert.ok(S.readBook(b.id).cost > 0, '成本没记到书上')
    reply = '```\n一段简介\n```'
    const r2 = await TL.runTool({ tool: 'intro', inputs: { idea: '一个故事' } }) // 不绑定书
    assert.equal(r2.text, '一段简介')
    assert.ok(!lastReq.some((m) => m.content.includes('本书资料')), '不绑定书不该带本书资料')
    reply = '   '
    await assert.rejects(() => TL.runTool({ tool: 'brainstorm', inputs: { keywords: 'x' } }), /没有返回内容|返回空内容/)
  })

  await t('划选 6 种 action 的提示词：含选区、前后文、额外要求；续写不复述原文', () => {
    const acts = Object.keys(TL.SELECTION_ACTIONS)
    assert.deepEqual(acts.sort(), ['continue', 'expand', 'fix', 'polish', 'rewrite', 'shrink'])
    for (const a of acts) {
      const req = TL.checkSelection({ action: a, text: '选中的这一段话', before: '前文甲', after: '后文乙', ask: '多写点心理' })
      const p = TL.buildSelectionPrompt(req, { label: '都市脑洞', rules: '规则' })
      assert.ok(p.user.includes('选中的这一段话') && p.user.includes('前文甲') && p.user.includes('后文乙') && p.user.includes('多写点心理') && p.user.includes('都市脑洞'), a)
      assert.ok(p.user.includes(TL.SELECTION_ACTIONS[a].label), a + ' 任务名')
      assert.ok(/只输出/.test(p.system) && p.maxTokens >= 600)
    }
    assert.ok(TL.buildSelectionPrompt(TL.checkSelection({ action: 'continue', text: 'x' })).user.includes('不要把原来的那一段再抄一遍'))
    assert.ok(TL.buildSelectionPrompt(TL.checkSelection({ action: 'fix', text: 'x' })).user.includes('只改错别字'))
    assert.equal(TL.buildSelectionPrompt(TL.checkSelection({ action: 'fix', text: 'x' })).temperature, 0.2)
  })

  await t('划选报错：未选文本 / 全是空白 / 超长 / 未知动作；前后文超长被截取而不是报错', () => {
    rejects(() => TL.checkSelection({ action: 'polish', text: '' }), /先用鼠标选中/)
    rejects(() => TL.checkSelection({ action: 'polish', text: '  \n ' }), /先用鼠标选中/)
    rejects(() => TL.checkSelection({ action: 'polish' }), /先用鼠标选中/)
    rejects(() => TL.checkSelection({ action: 'polish', text: '字'.repeat(TL.SEL_MAX + 1) }), /选的太多/)
    rejects(() => TL.checkSelection({ action: 'drop table', text: 'x' }), /没有这个动作/)
    rejects(() => TL.checkSelection({ text: 'x' }), /没有这个动作/)
    assert.doesNotThrow(() => TL.checkSelection({ action: 'polish', text: '字'.repeat(TL.SEL_MAX) }))
    const r = TL.checkSelection({ action: 'polish', text: 'x', before: 'a'.repeat(900) + 'END', after: 'START' + 'b'.repeat(900), ask: '问'.repeat(500) })
    assert.equal(r.before.length, 600); assert.ok(r.before.endsWith('END'))
    assert.equal(r.after.length, 600); assert.ok(r.after.startsWith('START'))
    assert.equal(r.ask.length, 200)
  })

  await t('runSelection 走假模型：返回 { action, original, result }，去掉"修改后："前缀，成本入账', async () => {
    const before = S.readBook(b.id).cost
    reply = '润色后：林川停下脚步，抬头望了望阴沉沉的天。'
    const r = await TL.runSelection(b.id, 1, { action: 'polish', text: '林川在路口停下脚步，抬头看了看灰蒙蒙的天', before: '', after: '', ask: '' })
    assert.equal(r.action, 'polish'); assert.equal(r.original, '林川在路口停下脚步，抬头看了看灰蒙蒙的天')
    assert.equal(r.result, '林川停下脚步，抬头望了望阴沉沉的天。')
    assert.ok(S.readBook(b.id).cost > before)
    reply = ''
    await assert.rejects(() => TL.runSelection(b.id, 1, { action: 'expand', text: 'x' }), /没有返回内容|返回空内容/)
    await assert.rejects(() => TL.runSelection(b.id, 1, { action: 'bogus', text: 'x' }), /没有这个动作/)
  })

  await t('TASKS 登记了 tool / selection；单机模式解析得到 agent', () => {
    for (const id of ['tool', 'selection']) assert.ok(AGS.TASKS.some((x) => x.id === id && x.def === 'cheap'), id)
    assert.equal(AGS.TASKS.find((x) => x.id === 'tool').label, '创意工具箱')
    assert.equal(AGS.TASKS.find((x) => x.id === 'selection').label, '划选改写')
    assert.equal(AGS.resolveAgent({ task: 'tool' }).model, 'fake')
    assert.equal(AGS.resolveAgent({ task: 'selection' }).model, 'fake')
  })

  await t('内测档位模式：resolveAgent({task:"tool"}) 与 "selection" 不抛错（基础档位 + 按任务分路两种写法）', () => {
    const cfg = path.join(SB, 'tiers.json')
    fs.writeFileSync(cfg, JSON.stringify({
      models: { base: { model: 'm-base', baseUrl: 'http://127.0.0.1:1/v1', keyEnv: 'TEST_TIER_KEY', priceIn: 1, priceOut: 2 }, big: { model: 'm-big', baseUrl: 'http://127.0.0.1:1/v1', keyEnv: 'TEST_TIER_KEY', priceIn: 9, priceOut: 9 } },
      tiers: { fast: { label: '快写档', use: 'base', enabled: true }, refine: { label: '精修档', use: 'base', tasks: { write1: 'big' }, enabled: true } },
    }))
    const code = `
      const A = await import(${JSON.stringify(new URL('./lib/agents.mjs', import.meta.url).href)})
      const out = {}
      for (const task of ['tool', 'selection']) { const a = A.resolveAgent({ task }); out[task] = a.model + '|' + a.routed }
      console.log('RESULT=' + JSON.stringify(out))`
    for (const tier of ['fast', 'refine']) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, WORKSHOP_MODE: 'customer', WORKSHOP_ADMIN_CONFIG: cfg, WORKSHOP_TIER: tier, TEST_TIER_KEY: 'k-test-123456', WORKSHOP_SANDBOX: path.join(SB, 'nosb') } })
      assert.equal(r.status, 0, tier + ' 档位子进程失败：' + (r.stderr || '').slice(0, 300))
      const got = JSON.parse(r.stdout.split('RESULT=')[1])
      assert.deepEqual(got, { tool: 'm-base|false', selection: 'm-base|false' }, tier + ' 档位：未知任务应落到档位基础模型')
    }
  })

  await t('server.mjs：/api/tool 与 /api/selection 在 MODEL_ROUTES 里，且两个路由已登记', () => {
    const src = fs.readFileSync(path.join(HERE, 'server.mjs'), 'utf8')
    const m = src.match(/const MODEL_ROUTES = new Set\(\[([^\]]*)\]\)/)
    assert.ok(m, '找不到 MODEL_ROUTES')
    assert.ok(m[1].includes("'/api/tool'") && m[1].includes("'/api/selection'"), 'MODEL_ROUTES 缺新接口')
    assert.ok(/'GET \/api\/tools'/.test(src) && /'POST \/api\/tool'/.test(src) && /'POST \/api\/selection'/.test(src))
  })

  // ── 起隔离实例走通接口（端口 4613，沙箱书库 + 假模型；不碰线上 4570/4590-4595） ──
  const PORT = 4613
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, j: await r.json() }
  }
  const waitJob = async () => { for (let i = 0; i < 100; i++) { const s = (await call('GET', '/api/status')).j.job; if (!s.running) return s; await new Promise((r) => setTimeout(r, 100)) } throw new Error('任务超时') }
  child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { stdio: 'ignore', env: { ...process.env, WORKSHOP_PORT: String(PORT), WORKSHOP_SANDBOX: SB, WORKSHOP_MODE: '' } })
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/status`); break } catch { await new Promise((r) => setTimeout(r, 200)) } }

  await t('接口：GET /api/tools 返回清单；POST /api/tool 走 runJob，结果 { tool, text } 在 job.result', async () => {
    const l = await call('GET', '/api/tools'); assert.equal(l.status, 200); assert.ok(l.j.tools.length >= 10)
    reply = '1. 外卖员的债主系统\n2. 我送的外卖都是债'
    const r = await call('POST', '/api/tool', { id: b.id, tool: 'title', inputs: { idea: '外卖员' } }); assert.equal(r.status, 200)
    const job = await waitJob()
    assert.equal(job.label, '创意工具箱：书名'); assert.equal(job.outcome, 'ok', job.error)
    assert.equal(job.result.tool, 'title'); assert.ok(job.result.text.includes('外卖员的债主系统'))
    const bad = await call('POST', '/api/tool', { tool: 'detail', inputs: {} }); assert.equal(bad.status, 400); assert.ok(/请先填写/.test(bad.j.error))
    const nb = await call('POST', '/api/tool', { id: 'no-such-book', tool: 'title', inputs: {} }); assert.equal(nb.status, 400)
    const nt = await call('POST', '/api/tool', { tool: 'nope', inputs: {} }); assert.equal(nt.status, 400)
  })

  await t('接口：POST /api/selection 返回 { action, original, result }；越界/未选/未知动作/无此章 → 400 且不占任务队列', async () => {
    reply = '林川停下脚步。'
    const seg = '林川在第3个路口停下脚步，抬头看了看灰蒙蒙的天，心里盘算着下一步。'
    const r = await call('POST', '/api/selection', { id: b.id, n: 1, action: 'shrink', text: seg, before: '', after: '' }); assert.equal(r.status, 200)
    const job = await waitJob()
    assert.equal(job.outcome, 'ok', job.error); assert.equal(job.result.action, 'shrink'); assert.equal(job.result.original, seg); assert.equal(job.result.result, '林川停下脚步。')
    for (const [body, re] of [
      [{ id: b.id, n: 1, action: 'shrink', text: '' }, /先用鼠标选中/],
      [{ id: b.id, n: 1, action: 'shrink', text: '字'.repeat(3001) }, /选的太多/],
      [{ id: b.id, n: 1, action: 'zzz', text: 'x' }, /没有这个动作/],
      [{ id: b.id, n: 9, action: 'shrink', text: 'x' }, /还没有定稿正文/],
      [{ id: 'no-such-book', n: 1, action: 'shrink', text: 'x' }, /书不存在/],
    ]) { const e = await call('POST', '/api/selection', body); assert.equal(e.status, 400); assert.ok(re.test(e.j.error), e.j.error) }
    assert.equal((await call('GET', '/api/status')).j.job.running, false, '校验失败不该占任务队列')
    assert.equal(S.readText(b.id, 'chapters', '0001.txt'), chap, '划选接口不能改正文')
  })

  await t('接口：替换链路所需的 /api/save 把新段落写进定稿并进历史（可回滚）', async () => {
    const seg = '林川在第3个路口停下脚步，抬头看了看灰蒙蒙的天，心里盘算着下一步。'
    assert.equal(chap.split(seg).length - 1, 1, '测试样本应恰好出现一次')
    const next = chap.replace(seg, '林川停下脚步。')
    assert.equal((await call('POST', '/api/save', { id: b.id, n: 1, text: next })).status, 200)
    const back = (await call('GET', `/api/chapter?id=${b.id}&n=1`)).j
    assert.ok(back.text.includes('林川停下脚步。') && !back.text.includes(seg))
    assert.ok(back.history.length >= 1, '替换应进历史版本')
  })

  await t('页面：工具箱与划选工具栏的锚点都在，内测页面脱敏后无泄漏词', () => {
    const html = fs.readFileSync(path.join(HERE, 'ui', 'index.html'), 'utf8')
    for (const id of ['data-p="pTools"', 'id="pTools"', 'id="selBar"', 'id="selBox"', 'id="thRoot"', 'id="tbRoot"']) assert.ok(html.includes(id), '缺 ' + id)
    for (const a of Object.keys(TL.SELECTION_ACTIONS)) assert.ok(html.includes(`data-sel="${a}"`), '缺按钮 ' + a)
    assert.ok(!/(?:^|\n)\s*const TOOLS\s*=/.test(html), '前端不该硬编码第二份工具清单')
    // 新增的页面脚本与工具清单文案不得出现模型/供应商名（内测用户页面脱敏会把它们替换成圆点，造成界面错乱）
    const T = fs.readFileSync(path.join(HERE, 'lib', 'tiers.mjs'), 'utf8')
    const words = T.match(/LEAK_WORDS = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((x) => x.replace(/'/g, ''))
    const tail = html.slice(html.indexOf('创意工具箱（清单来自'))
    const listText = JSON.stringify(TL.toolList())
    for (const w of words) {
      assert.ok(!new RegExp(w, 'i').test(tail), '页面新增脚本含泄漏词 ' + w)
      assert.ok(!new RegExp(w, 'i').test(listText), '工具清单含泄漏词 ' + w)
    }
  })

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('❌ 失败：', e?.stack || e); process.exitCode = 1
} finally {
  try { child?.kill() } catch { /* 已退出 */ }
  fake.close()
  await new Promise((r) => setTimeout(r, 300))
  try { fs.rmSync(SB, { recursive: true, force: true }) } catch { /* Windows 上文件句柄可能还没放 */ }
}

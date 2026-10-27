import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once, EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createLab } from './customer-lab.mjs'
import { readControl, controlContext, validateLimits } from './lib/sim-control.mjs'
import { decideWake, FIXER, FIX_PROMPT, RUN_MINUTES, repairJobActive, wakeFixer, currentFixer, fixerTitle, timerSlug, routeForEngineer } from './wake-fixer.mjs'

test('limits reject unbounded spending, bad steps and time', () => {
  validateLimits({ steps: 25, budget: .6, minutes: 20 })
  for (const budget of [0, -1, NaN, 1000]) assert.throws(() => validateLimits({ steps: 25, budget, minutes: 20 }))
  assert.throws(() => validateLimits({ steps: 1.5, budget: .6, minutes: 20 }))
  assert.throws(() => validateLimits({ steps: 25, budget: .6, minutes: 241 }))
  validateLimits({ steps: 300, budget: 60, minutes: 180 }) // 质量优先的宽限额合法
})
test('missing control pauses; corrections are data with bounded size', () => {
  assert.equal(readControl('/nonexistent/test-control').mode, 'pause')
  assert.equal(readControl('').mode, 'run')
  assert.equal(controlContext({ messages: [{ text: '先测导出' }] }), '先测导出')
})
test('wake thresholds, no daily cap and duplicate batch block', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: 'Q' + i, status: 'open', severity: '高', hits: 4 }))
  assert.equal(decideWake({ items: items.slice(0,9) }, {}).ok, false)
  const d = decideWake({ items }, {})
  assert.equal(d.ok, true)
  assert.equal(decideWake({ items }, { lastWakeBatch: d.batch }).ok, false)
  assert.equal(decideWake({ items }, { lastWakeAt: new Date().toISOString() }).ok, true)
  assert.deepEqual(FIXER, { provider: 'gptlumai', model: 'gpt-6.1-sol' })
  assert.equal(currentFixer().model, 'gpt-6.1-sol')
  assert.match(FIX_PROMPT, /禁止调用或切换 Claude\/Opus/)
})
test('fixer job title yields ASCII-only timer session id (HTTP header safe)', () => {
  for (const m of ['gpt-6.1-sol', 'grok-4.7', 'claude-sonnet-5']) {
    const title = fixerTitle({ provider: 'x', model: m }, 11)
    assert.match(timerSlug(title), /^[\x20-\x7e]+$/)
    assert.match(title, /清平文坊反馈修复/) // 「已有修复任务」检测仍能匹配
  }
  // 旧标题会产生中文会话 id → 宿主 fetch 抛 ByteString 错（Connection error 的根因）
  assert.doesNotMatch(timerSlug('清平文坊反馈修复（GPT，11 条）'), /^[\x20-\x7e]+$/)
})
test('admin-chosen engineer maps to a real DSH provider route', () => {
  const routes = { gptlumai: { baseURL: 'https://api.example.com/v1', models: ['gpt-6.1-sol', 'gpt-6-sol'] }, grok: { baseURL: 'https://api.example.com/v1', models: ['grok-4.7'] }, ccmax: { baseURL: 'https://api.example.com', models: ['claude-sonnet-5'] }, claude1: { baseURL: 'https://api.example.com', models: ['claude-sonnet-5'] } }
  assert.deepEqual(routeForEngineer({ provider: 'gptlumai', model: 'gpt-6.1-sol', agentId: 'gpt' }, routes), { provider: 'gptlumai', model: 'gpt-6.1-sol', agentId: 'gpt' })
  assert.equal(routeForEngineer({ provider: 'gptlumai', model: 'grok-4.7', agentId: 'g' }, routes).provider, 'grok')
  assert.equal(routeForEngineer({ provider: 'gptlumai', model: 'claude-sonnet-5', baseUrl: 'https://api.example.com/v1', agentId: 'writer' }, routes).provider, 'ccmax')
  assert.throws(() => routeForEngineer({ provider: 'gptlumai', model: 'nope-1', agentId: 'z' }, routes), /没有可用路由/)
  assert.equal(currentFixer({ routes: null }).model, 'gpt-6.1-sol')
})
test('failed fixer jobs can be retried but active jobs still block overlap', () => {
  assert.equal(repairJobActive({ status: 'running' }), true)
  const now = Date.now()
  assert.equal(repairJobActive({ status: 'running', executions: [{ startedAt: now - 21 * 60000 }] }, { now }), false)
  assert.equal(repairJobActive({ status: 'running', executions: [{ startedAt: now - 19 * 60000 }] }, { now }), true)
  assert.equal(repairJobActive({ status: 'pending', schedule: { enabled: true }, executions: [{ endedAt: Date.now(), result: 'failed', error: 'Connection error' }] }), false)
  assert.equal(repairJobActive({ status: 'running', schedule: { enabled: true }, executions: [{ endedAt: Date.now(), result: 'failed', error: 'Connection error' }] }), false)
  assert.equal(repairJobActive({ status: 'archived', schedule: { enabled: true } }), false)
  assert.equal(repairJobActive({ status: 'queued', schedule: { enabled: true } }), true)
})

test('wake pins GPT and survives ambiguous POST without billing twice', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-test-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  fs.writeFileSync(path.join(tmp, 'qa-queue.json'), JSON.stringify({ items: Array.from({ length: 10 }, (_, i) => ({ id: 'Q' + i, status: 'open' })) }))
  let posts = 0
  const fetchImpl = async (url, opts) => {
    if (!opts.method) return { ok: true, json: async () => ({ jobs: [] }) }
    posts++; const b = JSON.parse(opts.body); assert.deepEqual(b.modelSelection, FIXER); assert.equal(b.timeoutMinutes, RUN_MINUTES); assert.match(timerSlug(b.title), /^[\x20-\x7e]+$/)
    throw new Error('network ambiguous')
  }
  await assert.rejects(wakeFixer({ dir: tmp, root: tmp, desktop: tmp, fetchImpl }))
  assert.equal((await wakeFixer({ dir: tmp, root: tmp, desktop: tmp, fetchImpl })).woke, false)
  assert.equal(posts, 1)
})
test('local workbench waits for explicit start; rejects CSRF; corrects and pauses', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-test-'))
  let kid, calls = 0
  const server = createLab({ dataDir: tmp, runProcess: (exe, args) => {
    calls++; kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); kid.kill = () => kid.emit('close', 1); kid.args = args; return kid
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await fetch(origin)).text(); const token = page.match(/const token='([a-f0-9]+)'/)[1]
  const state = await (await fetch(origin + '/api/state')).json(); assert.equal(calls,0)
  const post = (action, body = {}, valid = true) => fetch(origin + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: valid ? origin : 'https://evil.example', 'X-Lab-Token': token }, body: JSON.stringify(body) })
  assert.equal((await post('start',{},false)).status,403)
  assert.equal((await post('start',{})).status,400); assert.equal(calls,0)
  assert.equal((await post('start',{ task:'只测试界面', persona:'customer',mode:'continue',book:state.books[0],budget:.6,steps:2,minutes:1,triage:false })).status,200)
  assert.equal(calls,1); assert(kid.args.includes('--customer-view'))
  assert(kid.args.some(a => a.startsWith('--source-books=')))
  const keep = kid.args.find(a => a.startsWith('--keep=')).slice(7)
  assert(fs.existsSync(path.join(keep,'books',state.library[0].name,'book.json')))
  assert(state.chapterCounts[state.books[0]] >= 18)
  assert(state.library.length >= 2, '沙箱和书库里的同名书应分别列出')
  const controlFile = kid.args.find(a => a.startsWith('--control=')).slice(10)
  assert.equal((await post('start',{task:'重复'})).status,400); assert.equal(calls,1)
  await post('correct',{text:'先不要改稿'}); assert.equal(readControl(controlFile).revision,1)
  await post('pause'); assert.equal(readControl(controlFile).mode,'pause')
  await post('resume'); assert.equal(readControl(controlFile).mode,'run')
  await post('stop'); assert.equal(readControl(controlFile).mode,'stop'); kid.emit('close',0)
  await new Promise(r=>setTimeout(r,30)); assert.equal((await(await fetch(origin+'/api/state')).json()).running,false)
})

test('new book mode creates only an isolated test book', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-new-book-'))
  let kid
  const server = createLab({ dataDir: tmp, runProcess: (exe, args) => {
    kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); kid.kill = () => kid.emit('close', 1); kid.args = args; return kid
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await fetch(origin)).text(); const token = page.match(/const token='([a-f0-9]+)'/)[1]
  assert.match(page, /按我的设定新建一本/)
  assert.match(page, /newTitle/)
  const post = (action, body = {}) => fetch(origin + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Lab-Token': token }, body: JSON.stringify(body) })
  const title = '测试新书-末日电台'
  const started = await post('start', { task: '只检查新书隔离', persona: 'customer', newBook: { title, genre: '末世脑洞', idea: '停电后只有电台还能播出真相' }, budget: .6, steps: 2, minutes: 1, triage: false })
  assert.equal(started.status, 200, await started.text())
  const keep = kid.args.find(a => a.startsWith('--keep=')).slice(7)
  assert.ok(fs.existsSync(path.join(keep, 'books', title, 'book.json')))
  assert.ok(fs.existsSync(path.join(keep, 'books', title, 'concept.md')))
  assert.equal(kid.args.find(a => a.startsWith('--book=')).slice(7), title)
  assert.equal(kid.args.find(a => a.startsWith('--source-books=')).slice(15), path.join(keep, 'books'))
  const source = path.resolve('projects/workshop-books')
  assert.ok(!fs.existsSync(path.join(source, title)), '源工作区不得出现新书')
  await post('stop'); kid.emit('close', 0)
})

test('one-click auto mode needs no input, starts fresh sandbox, passes think flag, delivers nothing when no chapters', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-auto-')); const desk = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-desk-'))
  let kid
  const server = createLab({ dataDir: tmp, runProcess: (exe, args) => {
    kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); kid.kill = () => kid.emit('close', 1); kid.args = args; return kid
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(desk, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await fetch(origin)).text(); const token = page.match(/const token='([a-f0-9]+)'/)[1]
  assert.match(page, /一键开始/); assert.match(page, /autoThink/)
  const post = (action, body = {}) => fetch(origin + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Lab-Token': token }, body: JSON.stringify(body) })
  const r = await post('start', { auto: true, think: 'off', triage: false, deliveryWorkspace: path.join(desk, '成果') })
  assert.equal(r.status, 200, await r.text())
  assert(kid.args.includes('--fresh')); assert(kid.args.includes('--think=off')); assert(!kid.args.some(a => a.startsWith('--book=')))
  assert(kid.args.find(a => a.startsWith('--goal=')).includes('自己挑一个'))
  const st = await (await fetch(origin + '/api/state')).json()
  assert(st.styles.length >= 8); assert(typeof st.queueOpen === 'number')
  await post('stop'); kid.emit('close', 0)
  await new Promise(r => setTimeout(r, 60))
  const s2 = await (await fetch(origin + '/api/state')).json(); assert.equal(s2.running, false)
})

function mkBook(root, name, chapters) {
  const d = path.join(root, name); fs.mkdirSync(path.join(d, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(d, 'book.json'), JSON.stringify({ id: name, title: name, genre: '都市脑洞', platform: 'tomato', stage: 'writing', chapters: Array.from({ length: chapters }, (_, i) => ({ n: i + 1 })), createdAt: 'x', updatedAt: 'x', cost: 0 }))
  for (let i = 1; i <= chapters; i++) fs.writeFileSync(path.join(d, 'chapters', String(i).padStart(4, '0') + '.txt'), '第' + i + '章\n' + '内容。'.repeat(200))
  return d
}
async function labWith(t, lib, box) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-mode-')); const desk = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-desk-'))
  const h = { kid: null }
  const server = createLab({ dataDir: tmp, libraryRoot: lib, sandboxRoot: box, runProcess: (exe, args) => {
    const kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); kid.kill = () => kid.emit('close', 1); kid.args = args; h.kid = kid; return kid
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(desk, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = (await (await fetch(origin)).text()).match(/const token='([a-f0-9]+)'/)[1]
  const post = (action, body = {}) => fetch(origin + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Lab-Token': token }, body: JSON.stringify(body) })
  const state = async () => (await fetch(origin + '/api/state')).json()
  return { h, post, state, desk }
}
const tick = ms => new Promise(r => setTimeout(r, ms))

test('continue mode: picks from library, writes new chapters, backs up and syncs back', async t => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')); const box = fs.mkdtempSync(path.join(os.tmpdir(), 'box-'))
  t.after(() => { fs.rmSync(lib, { recursive: true, force: true }); fs.rmSync(box, { recursive: true, force: true }) })
  mkBook(lib, '我的书', 3)
  const { h, post, state, desk } = await labWith(t, lib, box)
  const st = await state(); assert.deepEqual(st.library.map(x => [x.id, x.name, x.chapters, x.label]), [['我的书库:我的书', '我的书', 3, '我的书库']])
  assert.equal((await post('start', { mode: 'continue', book: '不存在', deliveryWorkspace: path.join(desk, 'o') })).status, 400)
  const r = await post('start', { mode: 'continue', book: '我的书库:我的书', chapters: 2, triage: false, deliveryWorkspace: path.join(desk, 'o') })
  assert.equal(r.status, 200, await r.text())
  const goal = h.kid.args.find(a => a.startsWith('--goal=')); assert.match(goal, /已经写了 3 章/); assert.match(goal, /再往下写 2 章/)
  assert(h.kid.args.includes('--book=我的书')); assert(!h.kid.args.includes('--fresh')); assert(h.kid.args.includes('--task=author'))
  const keep = h.kid.args.find(a => a.startsWith('--keep=')).slice(7)
  assert(fs.existsSync(path.join(keep, 'books', '我的书', 'book.json')), '沙箱里应有书副本')
  assert.equal(fs.readdirSync(path.join(lib, '我的书', 'chapters')).length, 3, '写作期间原稿不动')
  fs.writeFileSync(path.join(keep, 'books', '我的书', 'chapters', '0004.txt'), '第4章\n' + '新内容。'.repeat(200))
  h.kid.emit('close', 0); await tick(300)
  assert.equal(fs.readdirSync(path.join(lib, '我的书', 'chapters')).length, 4, '续写结果应同步回书库')
  assert(fs.readdirSync(path.join(desk, 'o', '_书稿备份')).length === 1, '应备份原稿')
  const s2 = await state(); assert(s2.logs.join('').includes('已同步回书库'), s2.logs.join(''))
})

test('continue mode: original edited meanwhile is never overwritten', async t => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')); const box = fs.mkdtempSync(path.join(os.tmpdir(), 'box-'))
  t.after(() => { fs.rmSync(lib, { recursive: true, force: true }); fs.rmSync(box, { recursive: true, force: true }) })
  mkBook(lib, '我的书', 2)
  const { h, post, state, desk } = await labWith(t, lib, box)
  assert.equal((await post('start', { mode: 'continue', book: '我的书库:我的书', triage: false, deliveryWorkspace: path.join(desk, 'o') })).status, 200)
  const keep = h.kid.args.find(a => a.startsWith('--keep=')).slice(7)
  fs.writeFileSync(path.join(keep, 'books', '我的书', 'chapters', '0003.txt'), '第3章\n' + '续写。'.repeat(200))
  fs.writeFileSync(path.join(lib, '我的书', 'chapters', '0002.txt'), '别处改过的第2章')
  h.kid.emit('close', 0); await tick(300)
  assert.equal(fs.readFileSync(path.join(lib, '我的书', 'chapters', '0002.txt'), 'utf8'), '别处改过的第2章')
  assert(fs.existsSync(path.join(lib, '我的书-续写', 'book.json')), '应另存为新名字')
})

test('new mode: everything optional; result is saved into library for later continuing', async t => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')); const box = fs.mkdtempSync(path.join(os.tmpdir(), 'box-'))
  t.after(() => { fs.rmSync(lib, { recursive: true, force: true }); fs.rmSync(box, { recursive: true, force: true }) })
  const { h, post, state, desk } = await labWith(t, lib, box)
  assert.equal((await post('start', {})).status, 400, '不选起点不应默默开始')
  assert.equal((await post('start', { mode: 'new', targetWords: 60000, triage: false, deliveryWorkspace: path.join(desk, 'o') })).status, 200)
  assert(h.kid.args.includes('--fresh')); assert.match(h.kid.args.find(a => a.startsWith('--goal=')), /6 万字/)
  const budget = Number(h.kid.args.find(a => a.startsWith('--budget=')).slice(9)); assert(budget >= 8 && budget <= 100, 'budget=' + budget) // 质量优先：按章数放宽
  const keep = h.kid.args.find(a => a.startsWith('--keep=')).slice(7)
  mkBook(path.join(keep, 'books'), '新书A', 2)
  h.kid.emit('close', 0); await tick(300)
  assert(fs.existsSync(path.join(lib, '新书A', 'book.json')), '新书应存入书库')
  assert.equal((await state()).library.find(x => x.id === '我的书库:新书A').chapters, 2)
})

test('custom mode seeds the given setting; experience persona never writes back', async t => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')); const box = fs.mkdtempSync(path.join(os.tmpdir(), 'box-'))
  t.after(() => { fs.rmSync(lib, { recursive: true, force: true }); fs.rmSync(box, { recursive: true, force: true }) })
  mkBook(lib, '书B', 2)
  const { h, post, desk } = await labWith(t, lib, box)
  assert.equal((await post('start', { mode: 'custom', newBook: { title: '', idea: '' } })).status, 400)
  assert.equal((await post('start', { mode: 'custom', newBook: { title: '停电书店', genre: '末世', idea: '只有我的店有电' }, chapters: 3, triage: false, deliveryWorkspace: path.join(desk, 'o') })).status, 200)
  assert.match(h.kid.args.find(a => a.startsWith('--goal=')), /不要改/)
  h.kid.emit('close', 0); await tick(100)
  assert.equal((await post('start', { mode: 'continue', book: '我的书库:书B', persona: 'customer', triage: false, deliveryWorkspace: path.join(desk, 'o2') })).status, 200)
  const keep = h.kid.args.find(a => a.startsWith('--keep=')).slice(7)
  fs.writeFileSync(path.join(keep, 'books', '书B', 'chapters', '0003.txt'), '体验写的' .repeat(50))
  h.kid.emit('close', 0); await tick(300)
  assert.equal(fs.readdirSync(path.join(lib, '书B', 'chapters')).length, 2, '体验身份不得改书库')
})

test('concurrent runs: isolated sandboxes, same book locked, stop/correct target the chosen run, cap enforced', async t => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')); const box = fs.mkdtempSync(path.join(os.tmpdir(), 'box-')); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-c-')); const desk = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-c-'))
  t.after(() => { for (const d of [lib, box, tmp, desk]) fs.rmSync(d, { recursive: true, force: true }) })
  mkBook(lib, '书甲', 2); mkBook(lib, '书乙', 2)
  const kids = []
  const server = createLab({ dataDir: tmp, libraryRoot: lib, sandboxRoot: box, runProcess: (exe, args) => {
    const kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); kid.kill = () => kid.emit('close', 1); kid.args = args; kids.push(kid); return kid
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = (await (await fetch(origin)).text()).match(/const token='([a-f0-9]+)'/)[1]
  const post = (action, body = {}) => fetch(origin + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Lab-Token': token }, body: JSON.stringify(body) })
  const state = async (run) => (await fetch(origin + '/api/state' + (run ? '?run=' + run : ''))).json()
  const base = { triage: false, deliveryWorkspace: path.join(desk, 'o') }
  const a = await (await post('start', { ...base, mode: 'continue', book: '我的书库:书甲', chapters: 1 })).json()
  const dup = await post('start', { ...base, mode: 'continue', book: '我的书库:书甲' }); assert.equal(dup.status, 400, '同一本书不能同时写')
  const b = await (await post('start', { ...base, mode: 'continue', book: '我的书库:书乙', chapters: 1 })).json()
  const c = await (await post('start', { ...base, mode: 'new' })).json()
  assert.notEqual(a.id, b.id); assert.equal(kids.length, 3)
  const keeps = kids.map(k => k.args.find(x => x.startsWith('--keep=')).slice(7)); assert.equal(new Set(keeps).size, 3, '沙箱必须互相独立')
  const ctl = kids.map(k => k.args.find(x => x.startsWith('--control=')).slice(10)); assert.equal(new Set(ctl).size, 3, '控制文件必须互相独立')
  assert.equal((await post('start', { ...base, mode: 'new' })).status, 400, '默认最多同时 3 个')
  const s = await state(); assert.equal(s.runningCount, 3); assert.equal(s.runs.length, 3)
  await post('correct', { runId: b.id, text: '只给乙的纠偏' })
  assert.match(fs.readFileSync(ctl[1], 'utf8'), /只给乙的纠偏/); assert.doesNotMatch(fs.readFileSync(ctl[0], 'utf8'), /只给乙的纠偏/)
  await post('stop', { runId: a.id }); kids[0].emit('close', 0); await tick(300)
  assert.equal(JSON.parse(fs.readFileSync(ctl[0], 'utf8')).mode, 'stop'); assert.notEqual(JSON.parse(fs.readFileSync(ctl[1], 'utf8')).mode, 'stop')
  const sa = await state(a.id), sb = await state(b.id); assert.equal(sa.running, false); assert.equal(sb.running, true)
  fs.writeFileSync(path.join(keeps[1], 'books', '书乙', 'chapters', '0003.txt'), '第3章\n' + '乙新内容。'.repeat(200))
  kids[1].emit('close', 0); await tick(300)
  assert.equal(fs.readdirSync(path.join(lib, '书乙', 'chapters')).length, 3, '乙的成果只写回乙')
  assert.equal(fs.readdirSync(path.join(lib, '书甲', 'chapters')).length, 2, '甲没被动')
  assert.equal((await post('start', { ...base, mode: 'continue', book: '我的书库:书甲', chapters: 1 })).status, 200, '甲结束后可再次续写')
  kids.forEach(k => k.emit('close', 1))
})
test('quality mode is default for authors: real agents, pen name in sandbox, wider limits, remembered pen names', async t => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')); const box = fs.mkdtempSync(path.join(os.tmpdir(), 'box-'))
  t.after(() => { fs.rmSync(lib, { recursive: true, force: true }); fs.rmSync(box, { recursive: true, force: true }) })
  mkBook(lib, '书Q', 2)
  const { h, post, state, desk } = await labWith(t, lib, box)
  const base = { triage: false, deliveryWorkspace: path.join(desk, 'o') }
  assert.equal((await post('start', { ...base, mode: 'continue', book: '我的书库:书Q', chapters: 5, penName: '夜行灯' })).status, 200)
  const a = h.kid.args
  assert(a.includes('--real-agents'), '质量优先要用真实模型'); assert(!a.includes('--customer-view'))
  const budget = Number(a.find(x => x.startsWith('--budget=')).slice(9)); assert(budget >= 5 && budget <= 100, 'budget=' + budget)
  const goal = a.find(x => x.startsWith('--goal=')); assert.match(goal, /靠这本书吃饭/); assert.match(goal, /夜行灯/); assert.doesNotMatch(goal, /笔名不要自己编/)
  const keep = a.find(x => x.startsWith('--keep=')).slice(7)
  assert.equal(JSON.parse(fs.readFileSync(path.join(keep, 'settings.json'), 'utf8')).penName, '夜行灯')
  assert(!fs.existsSync(path.join(keep, 'assign-override.json')), '不应强制指定模型')
  const st = await state(); assert(st.pens.includes('夜行灯')); assert.equal(st.lastPen, '夜行灯')
  h.kid.emit('close', 0); await tick(200)
  // 关闭质量优先 → 回到便宜模型 + 原有保守额度
  assert.equal((await post('start', { ...base, mode: 'new', quality: false })).status, 200)
  assert(h.kid.args.includes('--customer-view')); assert(!h.kid.args.includes('--real-agents'))
  assert.doesNotMatch(h.kid.args.find(x => x.startsWith('--goal=')), /靠这本书吃饭/)
  h.kid.emit('close', 0)
})

// 2026-10-06 根因 2：常驻工作台不能 import() wake-fixer（模块缓存→旧代码→中文会话 id→Connection error），必须子进程跑最新代码
test('spawnWake runs the on-disk wake-fixer in a child and parses the last JSON line', async () => {
  const { spawnWake } = await import('./customer-lab.mjs')
  let seen
  const runProcess = (exe, args, opts) => {
    seen = { exe, args, env: opts.env }
    const kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough()
    setImmediate(() => { kid.stdout.write('待处理 2 条\n{"woke":true,"reason":"修复任务已排队（gptlumai/gpt-6.1-sol）","jobId":"j1"}\n'); kid.emit('close', 0) })
    return kid
  }
  process.env.WORKSHOP_SANDBOX = 'C:\\x\\friend-01'
  const r = await spawnWake(['--force', '--json'], { runProcess })
  delete process.env.WORKSHOP_SANDBOX
  assert.equal(r.woke, true); assert.equal(r.jobId, 'j1')
  assert.match(seen.args[0], /wake-fixer\.mjs$/); assert.deepEqual(seen.args.slice(1), ['--force', '--json'])
  assert.equal(seen.env.WORKSHOP_SANDBOX, undefined, '唤醒不能带客户沙箱')
  const bad = () => { const kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); setImmediate(() => { kid.stderr.write('boom\n'); kid.emit('close', 1) }); return kid }
  await assert.rejects(spawnWake([], { runProcess: bad }), /boom/)
  const src = fs.readFileSync(new URL('./customer-lab.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /import\(['"]\.\/wake-fixer\.mjs['"]\)/, '常驻进程不能 import() wake-fixer')
})
test('a failed wake of the same batch is retried instead of being stuck forever', () => {
  const items = [{ id: 'Q-FB-1', status: 'open', customerRequested: true }]
  const d = decideWake({ items }, {})
  assert.equal(d.ok, true)
  assert.equal(decideWake({ items }, { lastWakeBatch: d.batch, status: 'scheduled' }).ok, false)
  assert.equal(decideWake({ items }, { lastWakeBatch: d.batch, status: 'failed' }).ok, true)
})
test('every real customer feedback enters the repair queue first and shows in admin view', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-'))
  process.env.WORKSHOP_FEEDBACK_DIR = dir
  try {
    fs.writeFileSync(path.join(dir, 'qa-queue.json'), JSON.stringify({ items: [{ id: 'Q001', status: 'open', title: 'AI 模拟' }] }), 'utf8')
    const FB = await import('./lib/feedback.mjs')
    const f = FB.createFeedback({ visitor: 'v1', text: 'ai生成封面的提示词无法在下方认为修改', page: '封面', bookId: 'b1' })
    // 「其他」类过去会被丢掉，现在也要入队
    FB.createFeedback({ visitor: 'v2', text: '首页设计精进一下，嗯嗯嗯' })
    const q = JSON.parse(fs.readFileSync(path.join(dir, 'qa-queue.json'), 'utf8'))
    const real = q.items.filter(x => x.source === 'customer-feedback')
    assert.equal(real.length, 2)
    assert(real.every(x => x.status === 'open' && x.customerRequested === true && x.priority === 'real-customer'))
    assert.match(real.find(x => x.feedbackId === f.id).evidence[0], /页面「封面」/)
    FB.syncFeedbackQueue(); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'qa-queue.json'), 'utf8')).items.length, 3, '幂等')
    // 客户追问会重新打开已修复条目
    const q2 = JSON.parse(fs.readFileSync(path.join(dir, 'qa-queue.json'), 'utf8'))
    q2.items.find(x => x.feedbackId === f.id).status = 'fixed'; q2.items.find(x => x.feedbackId === f.id).resolution = '封面页加了可编辑提示词框'
    fs.writeFileSync(path.join(dir, 'qa-queue.json'), JSON.stringify(q2), 'utf8')
    let a = FB.adminFeedback()
    assert.equal(a.count, 2); assert.equal(a.pending, 1)
    const row = a.rows.find(x => x.id === f.id)
    assert.equal(row.qa.statusText, '已修复'); assert.equal(row.qa.note, '封面页加了可编辑提示词框'); assert.equal(row.visitor, undefined, '不泄露访客凭证')
    FB.replyFeedback(f.id, { visitor: 'v1', text: '还是改不了' })
    a = FB.adminFeedback(); assert.equal(a.rows.find(x => x.id === f.id).qa.status, 'open'); assert.equal(a.pending, 2)
    // 有真人反馈时，未到 10 条阈值也会唤醒
    assert.equal(decideWake(JSON.parse(fs.readFileSync(path.join(dir, 'qa-queue.json'), 'utf8')), {}).ok, true)
    assert.match(FIX_PROMPT, /customer-feedback.*最高优先级/)
  } finally { delete process.env.WORKSHOP_FEEDBACK_DIR; fs.rmSync(dir, { recursive: true, force: true }) }
})
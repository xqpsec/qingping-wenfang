// test-lab-v2.mjs —— 2026-10-06 工作台升级的零成本回归：打磨模式、实时问题+手动加急、签约台账、签约体检、坏 JSON 解析
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once, EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createLab, signStatus } from './customer-lab.mjs'
import { checkBook, nextChance } from './lib/book-check.mjs'
import { parseJson } from './lib/llm.mjs'

const tick = (ms) => new Promise((r) => setTimeout(r, ms))
function mkBook(root, name, chapters, { para = '内容。'.repeat(10) } = {}) {
  const d = path.join(root, name); fs.mkdirSync(path.join(d, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(d, 'book.json'), JSON.stringify({ id: name, title: name, genre: '都市脑洞', chapters: Array.from({ length: chapters }, (_, i) => ({ n: i + 1, score: 60 + i })), package: {} }))
  for (let i = 1; i <= chapters; i++) fs.writeFileSync(path.join(d, 'chapters', String(i).padStart(4, '0') + '.txt'), `第${i}章\n` + Array.from({ length: 20 }, () => para).join('\n'))
  return d
}
async function lab(t) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-lib-')), box = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-box-')), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-data-')), desk = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-desk-')), qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-q-'))
  const queueFile = path.join(qdir, 'qa-queue.json')
  const h = { kid: null, wakes: 0 }
  const shorts = path.join(qdir, 'shorts')
  const server = createLab({ dataDir: tmp, libraryRoot: lib, sandboxRoot: box, deskRoot: desk, queueFile, shortsRoot: shorts, wake: async () => { h.wakes++; return { woke: true, reason: '测试：已唤醒' } }, runProcess: (exe, args) => {
    const kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); kid.kill = () => kid.emit('close', 1); kid.args = args; h.kid = kid; return kid
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise((r) => server.close(r)); for (const d of [lib, box, tmp, desk, qdir]) fs.rmSync(d, { recursive: true, force: true }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = (await (await fetch(origin)).text()).match(/const token='([a-f0-9]+)'/)[1]
  // 管理后台嵌入用的 ?embed=1 必须能打开同一个页面（2026-10-06 截图实测曾返回「没有该入口」）
  const embedded = await fetch(origin + '/?embed=1'); assert.equal(embedded.status, 200); assert.match(await embedded.text(), /DeepSeek 作者与测试/)
  const post = (action, body = {}) => fetch(origin + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Lab-Token': token }, body: JSON.stringify(body) })
  const get = async (p) => (await fetch(origin + p)).json()
  return { lib, desk, tmp, queueFile, h, post, get, shorts }
}
const base = (desk) => ({ triage: false, deliveryWorkspace: path.join(desk, 'o') })

test('polish mode: no new chapters, sim gets --no-write, goal forbids writing, rejection notes passed in', async (t) => {
  const L = await lab(t); mkBook(L.lib, '旧书', 5)
  assert.equal((await L.post('start', { ...base(L.desk), mode: 'polish', book: '我的书库:旧书', polishText: false, polishPack: false, polishCover: false })).status, 400, '至少选一项')
  mkBook(L.lib, '空书', 0)
  assert.equal((await L.post('start', { ...base(L.desk), mode: 'polish', book: '我的书库:空书' })).status, 400, '没正文不能打磨')
  // 先登记一次被拒（带编辑原话）
  assert.equal((await L.post('sign', { book: '我的书库:旧书', event: 'rejected', note: '开篇节奏慢，金手指出现太晚' })).status, 200)
  const r = await L.post('start', { ...base(L.desk), mode: 'polish', book: '我的书库:旧书', polishCover: true })
  assert.equal(r.status, 200, await r.text())
  const a = L.h.kid.args, goal = a.find((x) => x.startsWith('--goal='))
  assert(a.includes('--no-write')); assert(a.includes('--full-access')); assert(a.includes('--book=旧书'))
  assert.match(goal, /绝对不要写新章/); assert.match(goal, /开篇前 3 章/); assert.match(goal, /封面/); assert.doesNotMatch(goal, /再往下写/)
  assert.match(goal, /开篇节奏慢，金手指出现太晚/, '编辑原话要交给 DeepSeek')
  assert.equal((await L.post('start', { ...base(L.desk), mode: 'continue', book: '我的书库:旧书' })).status, 400, '打磨中的书不能同时续写')
  const keep = a.find((x) => x.startsWith('--keep=')).slice(7)
  // 模拟打磨改了第 1 章（没加新章）
  fs.writeFileSync(path.join(keep, 'books', '旧书', 'chapters', '0001.txt'), '第1章\n改过的开篇。\n短段落。')
  L.h.kid.emit('close', 0); await tick(400)
  assert.equal(fs.readdirSync(path.join(L.lib, '旧书', 'chapters')).length, 5, '章数不变')
  assert.match(fs.readFileSync(path.join(L.lib, '旧书', 'chapters', '0001.txt'), 'utf8'), /改过的开篇/, '打磨结果同步回书库')
  assert(fs.existsSync(path.join(L.desk, 'o', '旧书', '签约体检.txt')), '桌面成果附签约体检')
})

test('live issues show per run; host escalation queues a high item and wakes GPT once per issue', async (t) => {
  const L = await lab(t); mkBook(L.lib, '书A', 2)
  const { id } = await (await L.post('start', { ...base(L.desk), mode: 'continue', book: '我的书库:书A', chapters: 1 })).json()
  const ctl = L.h.kid.args.find((x) => x.startsWith('--control=')).slice(10)
  fs.appendFileSync(ctl.replace(/\.json$/, '.issues.ndjson'), JSON.stringify({ step: 7, at: new Date().toISOString(), issue: '写完章找不到新章在哪', engineerRequest: true, page: '书页' }) + '\n')
  const s = await L.get('/api/state?run=' + id)
  assert.equal(s.issues.length, 1); assert.equal(s.issues[0].issue, '写完章找不到新章在哪'); assert.equal(s.issues[0].sent, false)
  const e = await (await L.post('escalate', { runId: id, step: 7 })).json()
  assert.equal(e.wake.woke, true); assert.equal(L.h.wakes, 1)
  const q = JSON.parse(fs.readFileSync(L.queueFile, 'utf8'))
  assert.equal(q.items.length, 1); assert.equal(q.items[0].source, 'host-escalated'); assert.equal(q.items[0].severity, '高'); assert.equal(q.items[0].status, 'open')
  await L.post('escalate', { runId: id, step: 7 })
  assert.equal(JSON.parse(fs.readFileSync(L.queueFile, 'utf8')).items.length, 1, '同一条不重复入队')
  const s2 = await L.get('/api/state?run=' + id); assert.equal(s2.issues[0].sent, true); assert.equal(s2.queueOpen, 1); assert.equal(s2.openIssues[0].manual, true)
  assert.equal((await L.post('escalate', { runId: id, step: 99 })).status, 400)
  assert.equal((await (await L.post('wake', {})).json()).wake.woke, true); assert.equal(L.h.wakes, 3)
  L.h.kid.emit('close', 1)
})

test('signing ledger: submit → rejected uses chances 2万→5万; signed is final; undo works', async (t) => {
  const L = await lab(t); mkBook(L.lib, '签书', 3)
  const books = async () => (await L.get('/api/books')).books
  let b = (await books())[0]
  assert.equal(b.sign.status, 'unsubmitted'); assert.equal(b.next.tier, '2万'); assert(b.gaps.some((g) => /封面/.test(g)))
  assert.equal((await L.post('sign', { book: '我的书库:签书', event: 'submit' })).status, 200)
  assert.equal((await L.post('sign', { book: '我的书库:签书', event: 'submit' })).status, 400, '等结果时不能重复投稿')
  b = (await books())[0]; assert.equal(b.sign.status, 'pending')
  assert.equal((await L.post('sign', { book: '我的书库:签书', event: 'rejected', note: '格式混乱' })).status, 200)
  b = (await books())[0]; assert.equal(b.sign.status, 'rejected'); assert.equal(b.sign.rejections, 1); assert.equal(b.next.tier, '5万'); assert.match(b.sign.notes[0], /格式混乱/)
  assert(b.history[0].snapshot && typeof b.history[0].snapshot.chars === 'number', '登记时存体检快照')
  await L.post('sign', { book: '我的书库:签书', event: 'undo' }); b = (await books())[0]; assert.equal(b.sign.status, 'pending')
  await L.post('sign', { book: '我的书库:签书', event: 'signed' }); b = (await books())[0]; assert.equal(b.sign.status, 'signed')
  assert.equal((await L.post('sign', { book: '我的书库:签书', event: 'rejected' })).status, 400, '签约成功后不再登记')
  assert.equal(signStatus({ history: [{ event: 'rejected' }, { event: 'rejected' }, { event: 'rejected' }] }).label, '被拒 3 次（三次机会已用完）')
  assert.equal(nextChance(90000, 3), null); assert.deepEqual(nextChance(30000, 1), { tier: '5万', need: 50000, short: 20000, ready: false })
  const ck = await (await L.post('check', { book: '我的书库:签书', open: false })).json()
  assert(fs.existsSync(ck.file)); assert.match(fs.readFileSync(ck.file, 'utf8'), /签约状态：已签约/)
})

test('short mode + selectable sim model: --sim-agent passed, goal uses 短篇投稿, finished shorts delivered to desktop without annotations', async (t) => {
  const L = await lab(t)
  const s = await L.get('/api/state')
  assert(Array.isArray(s.simAgents) && s.simAgents.some((a) => a.id === 'cheap'), '状态里列出可选的模拟作者模型')
  assert(s.shortChannels.length >= 3 && s.shortGenres.includes('悬疑'), '状态里列出短篇渠道和题材')
  assert.equal((await L.post('start', { ...base(L.desk), mode: 'short', simAgent: '不存在的模型' })).status, 400, '不存在的模型直接拒绝')
  const ready = s.simAgents.find((a) => a.ready && a.id !== 'cheap') || s.simAgents.find((a) => a.ready)
  const r = await L.post('start', { ...base(L.desk), mode: 'short', simAgent: ready.id, shortChannel: '知乎盐言故事', style: '悬疑', idea: '外卖员每晚收到同一个地址的订单' })
  assert.equal(r.status, 200, await r.text())
  const a = L.h.kid.args, goal = a.find((x) => x.startsWith('--goal='))
  assert(a.includes('--sim-agent=' + ready.id)); assert(a.includes('--fresh')); assert(a.includes('--full-access')); assert(!a.includes('--no-write'))
  assert.match(goal, /短篇投稿/); assert.match(goal, /知乎盐言故事/); assert.match(goal, /悬疑/); assert.match(goal, /外卖员/); assert.doesNotMatch(goal, /写下一章/)
  // 模拟沙箱里写完一篇短篇（正文里混进一条批注）
  const keep = a.find((x) => x.startsWith('--keep=')).slice(7)
  const sd = path.join(keep, 'shorts', 's-test-1'); fs.mkdirSync(sd, { recursive: true })
  fs.writeFileSync(path.join(sd, '正文.md'), '# 第一节\n\n他推开门。（无问题，保留）\n\n**门后没人。**\n')
  fs.writeFileSync(path.join(sd, '投稿包.md'), '投稿包'); fs.writeFileSync(path.join(sd, 'meta.json'), JSON.stringify({ idea: { title: '午夜订单' }, quality: { release: 'usable' } }))
  fs.mkdirSync(path.join(keep, 'shorts', 's-unfinished'), { recursive: true })
  L.h.kid.emit('close', 0); await tick(400)
  const out = path.join(L.desk, 'o', '短篇', '午夜订单')
  const body = fs.readFileSync(path.join(out, '正文.txt'), 'utf8')
  assert.match(body, /他推开门。/); assert.doesNotMatch(body, /无问题|保留|#|\*\*/, '交付件剥掉批注和 md 标记')
  assert(fs.existsSync(path.join(out, '投稿包.md')))
  assert(!fs.existsSync(path.join(L.desk, 'o', '短篇', 's-unfinished')), '没写完的不交付')
  assert(fs.existsSync(path.join(L.shorts, 's-test-1', '正文.md')), '同步回短篇库（测试用临时目录）')
})

test('book check flags wall-of-text paragraphs and missing packaging; parseJson survives trailing junk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-ck-'))
  try {
    const d = mkBook(root, '墙', 3, { para: '他走进教室，看见窗外的夕阳，心里想着许多事情。'.repeat(8) })
    const c = checkBook(d)
    assert(c.metrics.paraAvg > 60); assert(c.gaps.some((g) => /格式混乱/.test(g))); assert(c.gaps.some((g) => /没有简介/.test(g)))
    const d2 = mkBook(root, '好', 3, { para: '他推门。' })
    const j = JSON.parse(fs.readFileSync(path.join(d2, 'book.json'), 'utf8')); j.package = { intro: '简介'.repeat(40), tags: ['都市'] }; fs.writeFileSync(path.join(d2, 'book.json'), JSON.stringify(j))
    const c2 = checkBook(d2); assert(!c2.gaps.some((g) => /格式混乱|简介/.test(g)), c2.gaps.join('|')); assert(c2.gaps.some((g) => /封面/.test(g)))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
  // 2026-10-06 实测失败样本：完整 JSON 后多一个 }
  assert.deepEqual(parseJson('{"a":{"b":"x}y"},"neg":"文字"}}'), { a: { b: 'x}y' }, neg: '文字' })
  assert.deepEqual(parseJson('```json\n{"k":1}\n```\n说明：以上'), { k: 1 })
})

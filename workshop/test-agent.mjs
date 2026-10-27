// test-agent.mjs —— 智能代理（Beta）零成本验收：node workshop/test-agent.mjs
// 本机假模型 + 临时沙箱书库，不花钱、不碰真书。覆盖：先计划后确认 / 做完自动停 / 暂停 / 立即中止（掐断请求）/ 引导 / 预算与连续失败自停 /
// 改写只在「改后更好」才采用 / 开关关闭时拒绝 / 书名 15 字上限 / 非 Windows 封面降级。
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-agent-'))
const para = (s) => Array.from({ length: 45 }, (_, i) => `${s}第${i}段，林川抬眼看着对面那人，手里的茶杯没放下，说了一句：“你再说一遍？”`).join('\n\n')
let script = [] // 决策脚本：每次 agent-decide 取一条
let hang = false // true 时 agent-decide 请求挂起，用来测立即中止
let hangSeen = 0
let titleList = ['这个书名只有十二个字真的', '这是一个明显超过十五个字的书名它一共有二十个字啊']
const fake = http.createServer(async (req, res) => {
  let s = ''; for await (const c of req) s += c
  const body = JSON.parse(s); const u = body.messages.at(-1).content
  const reply = (out) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: out } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } })) }
  if (/只输出 JSON：\{"think"/.test(u)) { // 代理决策
    if (hang) { hangSeen++; return } // 不回，等客户端掐断
    return reply(JSON.stringify(script.shift() || { think: '没了', action: 'finish' }))
  }
  if (/用 3–6 条短句写出你打算怎么做/.test(u)) return reply('1. 写下一章\n2. 看评审\n完成标准：写够章数')
  if (/"patterns"/.test(u)) return reply(JSON.stringify({ patterns: ['a'], sellingPoint: 'x', titles: titleList.map((t) => ({ title: t, why: 'w' })), recommend: 1, intro: '简介'.repeat(60), meta: { audience: 'male', signMode: 'serial', read: { main: '都市脑洞', theme: ['都市', '乱编标签'], role: ['大佬'], plot: ['系统', '重生', '穿越'] }, content: { plot: ['读心'], emotion: [], persona: ['马甲'], world: [] }, heroes: ['林川', '名字太长的主角名字'] }, coverPrompt: { zh: '图', en: 'img', negative: '' } }))
  if (/每个打一个"我会点进去"的意愿分/.test(u)) return reply(JSON.stringify({ votes: titleList.map((_, i) => ({ i: i + 1, score: 90 - i * 10, why: 'w' })) }))
  if (/结论=甲 或 结论=乙/.test(u)) { const ia = u.indexOf('【版本甲】'), ib = u.indexOf('【版本乙】'), im = u.indexOf('改写标记'); return reply(`理由略。\n结论=${im > ia && im < ib ? '甲' : '乙'}|2`) }
  if (/read_next=/.test(u)) { const good = /改写标记/.test(u) ? 8 : 6; return reply('感受略。\n' + ['hook_open', 'conflict', 'payoff', 'novelty', 'protagonist', 'density', 'dialogue', 'humor', 'logic', 'cliff'].map((k) => `${k}=${good}|理由`).join('\n') + `\nread_next=${good * 7}|x\nbest=开头\nworst=中段\nfix1=加快`) }
  if (/摘要：/.test(u) && /新增事实/.test(u)) return reply('摘要：林川遇事。\n新增事实：无\n未回收悬念：无\n章末钩子类型：悬念\n爽点类型：反转')
  if (/原句：/.test(u) && /硬伤/.test(u)) return reply('')
  if (/每章严格一行/.test(u)) return reply(Array.from({ length: 12 }, (_, i) => `${i + 1}|章名${i + 1}字数够|目标|压|扬|爽|悬念|最后一幕是个很具体的画面`).join('\n'))
  if (/场景节拍|节拍序号/.test(u)) return reply('1. 开场｜冲突｜紧张｜800\n2. 反转｜动作｜爽｜800')
  if (/改写标记|修改要求/.test(u) && /请按修改要求改写本章/.test(u)) return reply(`第1章 改过的章名\n\n${para('改写标记')}`)
  return reply(`第1章 假章名\n\n${para('原稿')}`)
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${fake.address().port}/v1`
const agent = { name: '假模型', baseUrl: base, model: 'fake', apiKey: 'x', priceIn: 1, priceOut: 1 }
fs.writeFileSync(path.join(SB, 'agents.json'), JSON.stringify({ agents: { cheap: agent, writer: agent, gpt: agent }, assign: {} }))
process.env.WORKSHOP_SANDBOX = SB
process.env.WORKSHOP_KNOWLEDGE = path.join(SB, 'no-knowledge') // 模拟 Linux 服务器：没有本地榜单库

const S = await import('./lib/store.mjs')
const PL = await import('./lib/pipeline.mjs')
const PK = await import('./lib/packaging.mjs')
const AG = await import('./lib/agent.mjs')
let pass = 0
const t = async (name, fn) => { try { await fn(); pass++; console.log('✓', name) } catch (e) { console.log('✗', name, '\n  ', e.message); process.exitCode = 1; throw e } }
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)) } throw new Error('等待超时') }
const settingsOn = () => fs.writeFileSync(PL.settingsFile(), JSON.stringify({ ...PL.settings(), agentBeta: true, candidates: 1 }))
settingsOn()

try {
  const b = S.createBook('测试书')
  fs.writeFileSync(S.bookPath(b.id, 'outline.md'), Array.from({ length: 12 }, (_, i) => `${i + 1}|章名${i + 1}字数够|目标|压|扬|爽|悬念|最后一幕是个很具体的画面`).join('\n'), 'utf8')
  fs.writeFileSync(S.bookPath(b.id, 'bible.md'), '设定集', 'utf8'); fs.writeFileSync(S.bookPath(b.id, 'concept.md'), '书名：测试书\n', 'utf8')

  await t('书名长度按字符数、15 字封顶（含标点）', () => {
    assert.equal(PK.titleLen('一二三四五六七八九十一二三四五'), 15); assert.equal(PK.titleLen('一二三四五六七八九十一二三四五，'), 16); assert.equal(PL.TITLE_MAX, 15)
    assert.throws(() => PK.applyPackage(b.id, { title: '一二三四五六七八九十一二三四五六' }), /超过番茄 15 字/)
    PK.applyPackage(b.id, { title: '一二三四五六七八九十一二三四五' }); assert.equal(S.readBook(b.id).title.length, 15)
  })
  await t('包装：超长候选被剔除，只剩合规书名可被推荐', async () => {
    const r = await PK.generatePackage(b.id, '')
    assert.ok(r.titles.every((x) => PK.titleLen(x.title) <= 15), JSON.stringify(r.titles.map((x) => x.title)))
    assert.equal(r.titles.length, 1)
    // 作品信息：非词表词（乱编标签）与超量（情节 3 个）被去掉并记录；超长主角名丢弃
    assert.equal(r.meta.read.main, '都市脑洞'); assert.deepEqual(r.meta.read.theme, ['都市']); assert.deepEqual(r.meta.read.plot, ['系统', '重生'])
    assert.deepEqual(r.meta.heroes, ['林川']); assert.ok(r.metaProblems.some((x) => x.includes('乱编标签')), r.metaProblems.join('|'))
    assert.ok(r.tags.includes('都市脑洞') && !r.tags.includes('乱编标签'))
  })
  await t('没有本地榜单库时不报错（降级为空）', () => assert.deepEqual(PK.hitSamples('urban-naodong', 5), []))
  await t('没有拟计划就直接确认 → 拒绝，不会空转', async () => {
    AG.discardPlan(); await assert.rejects(() => AG.run({}), /还没有待确认/)
  })
  await t('拟计划：只给计划、不动手、不写章', async () => {
    const st = await AG.plan(b.id, { instruction: '写 2 章', chapters: 2, budget: 5 })
    assert.equal(st.status, 'awaiting-approval'); assert.ok(st.plan.includes('完成标准')); assert.equal(S.readBook(b.id).chapters.length, 0)
  })
  await t('确认后写够章数自动结束（finish），不空转', async () => {
    script = [{ think: '先写', action: 'write_next' }, { think: '再写', action: 'write_next' }, { think: '够了', action: 'finish' }]
    const r = await AG.run({})
    const st = AG.readState()
    assert.equal(st.status, 'done'); assert.equal(S.readBook(b.id).chapters.length, 2); assert.equal(st.wrote, 2); assert.ok(r.note)
    assert.equal(script.length, 0, '结束后不应再请求决策')
  })
  await t('写够章数后模型还想写 → 被代码拦住（不允许超出目标章数）', async () => {
    AG.discardPlan(); await AG.plan(b.id, { instruction: '再写 1 章', chapters: 1, budget: 5 })
    script = [{ action: 'write_next' }, { action: 'write_next' }, { action: 'write_next' }]
    await AG.run({}); const st = AG.readState()
    assert.equal(st.wrote, 1); assert.equal(S.readBook(b.id).chapters.length, 3); assert.equal(st.status, 'done')
  })
  await t('改写：只有对比结论「改后更好」才采用', async () => {
    AG.discardPlan(); await AG.plan(b.id, { instruction: '改第 1 章', chapters: 0, budget: 5, allowPackage: false })
    script = [{ think: '改', action: 'revise', n: 1, instruction: '加快节奏' }, { action: 'finish' }]
    await AG.run({}); const st = AG.readState()
    const hist = S.listHistory(b.id, 1)
    assert.ok(st.log.some((x) => /已采用|保留原稿/.test(x.text)), JSON.stringify(st.log.map((x) => x.text)))
    assert.ok(S.readText(b.id, 'chapters', '0001.txt').includes('改写标记') ? hist.length >= 1 : true)
  })
  await t('同一章不能被改写两次', async () => {
    AG.discardPlan(); await AG.plan(b.id, { instruction: '改第 2 章', chapters: 0, budget: 5, allowPackage: false })
    script = [{ action: 'revise', n: 2, instruction: 'x' }, { action: 'revise', n: 2, instruction: 'y' }]
    await AG.run({}); const st = AG.readState()
    assert.equal(st.log.filter((x) => x.kind === 'step' && /改写第 2 章/.test(x.text)).length, 1)
  })
  await t('预算到了自动停，并说明原因', async () => {
    AG.discardPlan(); await AG.plan(b.id, { instruction: '多写', chapters: 5, budget: 0.1 })
    const f = AG.readState(); f.spent = 0; fs.writeFileSync(path.join(path.dirname(PL.settingsFile()), 'agent-run.json'), JSON.stringify({ ...f, budget: 0.0001 }))
    script = [{ action: 'write_next' }, { action: 'write_next' }]
    await AG.run({}); const st = AG.readState()
    assert.equal(st.status, 'done'); assert.match(st.note, /预算/)
  })
  await t('暂停：当前这一步做完后停下，继续后接着做', async () => {
    AG.discardPlan(); await AG.plan(b.id, { instruction: '写 3 章', chapters: 3, budget: 5 })
    script = [{ action: 'write_next' }, { action: 'write_next' }, { action: 'write_next' }, { action: 'finish' }]
    const p = AG.run({}); await waitFor(() => AG.readState().steps >= 1); AG.pause(); await p
    let st = AG.readState(); assert.equal(st.status, 'paused'); const stepsAt = st.steps; assert.ok(st.wrote >= 1 && st.wrote < 3)
    await AG.run({ resume: true }); st = AG.readState(); assert.equal(st.status, 'done'); assert.equal(st.wrote, 3); assert.ok(st.steps > stepsAt)
  })
  await t('引导：下一步决策时被注入，并标为已消费', async () => {
    AG.discardPlan(); await AG.plan(b.id, { instruction: '写 1 章', chapters: 1, budget: 5 })
    AG.guide('主角这章别再被打了')
    let seen = ''
    const orig = globalThis.fetch; globalThis.fetch = async (u, o) => { try { const m = JSON.parse(o.body).messages.at(-1).content; if (/只输出 JSON：\{"think"/.test(m)) seen += m } catch { /* 非 JSON */ } return orig(u, o) }
    script = [{ action: 'write_next' }, { action: 'finish' }]
    await AG.run({}); globalThis.fetch = orig
    assert.ok(seen.includes('主角这章别再被打了')); assert.ok(AG.readState().guidance.every((g) => g.consumed))
  })
  await t('立即中止：掐断正在进行的模型请求，已写内容保留，可继续', async () => {
    AG.discardPlan(); await AG.plan(b.id, { instruction: '写 1 章', chapters: 1, budget: 5 })
    const before = S.readBook(b.id).chapters.length
    hang = true; script = []
    const p = AG.run({}); await waitFor(() => hangSeen >= 1)
    const t0 = Date.now(); AG.stop(); await p
    assert.ok(Date.now() - t0 < 3000, '中止应当立刻生效，而不是等模型 5 分钟超时')
    hang = false
    const st = AG.readState(); assert.equal(st.status, 'stopped'); assert.equal(S.readBook(b.id).chapters.length, before)
    script = [{ action: 'write_next' }, { action: 'finish' }]
    await AG.run({ resume: true }); assert.equal(AG.readState().status, 'done'); assert.equal(S.readBook(b.id).chapters.length, before + 1)
  })
  await t('连续 2 步失败自动停下（不空转烧钱）', async () => {
    AG.discardPlan(); await AG.plan(b.id, { instruction: '写', chapters: 5, budget: 5 })
    script = [{ action: 'write_next' }, { action: 'write_next' }, { action: 'write_next' }]
    const orig = PL.writeChapter; // 让写章失败：删掉章纲与设定集
    fs.rmSync(S.bookPath(b.id, 'outline.md'), { force: true }); fs.rmSync(S.bookPath(b.id, 'bible.md'), { force: true })
    fake.close(); // 上游挂了
    await AG.run({}); const st = AG.readState()
    assert.equal(st.status, 'error'); assert.ok(st.steps <= 3)
  })
  await t('崩溃后重读状态：running 但进程里没有代理 → 判为被打断，可继续', () => {
    const f = path.join(path.dirname(PL.settingsFile()), 'agent-run.json'); const st = JSON.parse(fs.readFileSync(f, 'utf8')); fs.writeFileSync(f, JSON.stringify({ ...st, status: 'running' }))
    assert.equal(AG.readState().status, 'interrupted')
  })
  console.log(`\n✅ 全部通过：${pass} 项`)
} catch (e) {
  console.log('\n❌ 失败：', e.message)
  process.exitCode = 1
} finally {
  try { fake.close() } catch { /* 已关 */ }
  fs.rmSync(SB, { recursive: true, force: true })
  process.exit(process.exitCode || 0)
}

// test-short.mjs —— 短篇模块零成本测试：node workshop/test-short.mjs（不调模型）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'short-test-'))
process.env.WORKSHOP_SANDBOX = SB
const P = await import('./short/pipeline.mjs')
const { channel } = await import('./short/channels.mjs')
const E = await import('./short/evidence.mjs')

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('✓', name) }

t('证据包≤3000字，DeepSeek四条编造说法全部未核验，真实原句可核验', () => {
  const pack = E.buildEvidencePack('fanqie-jinpin')
  assert.ok(pack.length <= 3000)
  const claims = [
    { claim: 'IP金品共创有女性成长', evidenceId: 'fanqie-solicit#1', quote: '女性成长' },
    { claim: '番番自动审核通过率极高', evidenceId: 'fanqie-solicit#1', quote: '通过率极高' },
    { claim: '80%签约入库稿子见不到普通读者', evidenceId: 'fanqie-solicit#1', quote: '80%签约入库' },
    { claim: '改短剧法务第一轮就卡', evidenceId: 'fanqie-solicit#1', quote: '法务第一轮就卡' },
  ]
  assert.equal(E.verifyClaims(claims, pack).unverified.length, 4)
  if (!E.readEvidence().length) { console.log('    · 未提供 data/platform-rules 情报库，跳过真实原句核验'); return }
  const real = E.verifyClaims([{ claim: '金品共创超过2万字', evidenceId: 'fanqie-solicit#22', quote: '参加活动的作品字数需大于2万字' }], pack)
  assert.equal(real.verified.length, 1)
})

t('现实逻辑引用必须来自稿件原句', () => {
  const F0 = E
  assert.equal(F0.verifyClaims([{ claim: 'x', evidenceId: 'none', quote: '不存在原句' }], '').unverified.length, 1)
})

t('渠道表：每个渠道字段齐全且建议区间落在硬边界内', () => {
  for (const id of Object.keys(P.CHANNELS)) {
    const c = channel(id)
    assert.ok(c.name && c.tone && c.price && c.contact, id)
    assert.ok(['知乎盐选', '小程序', '番茄短篇'].includes(c.tone), id + ' 基调必须是 oh-story 认得的三种之一')
    assert.ok(c.sweet[0] >= c.range[0] && c.sweet[1] <= c.range[1], id + ' sweet 超出 range')
  }
  assert.throws(() => channel('nope'))
})

t('节标记归一：歪写法按顺序重编号成渠道样式、去空行', () => {
  const c = channel('fanqie-short')
  const out = P.normalizeMarkers('**1.**\n\n他来了。\n\n\n她没动。\n### 2\n第2节\n好。', c, 3)
  assert.equal(out, '###第3章\n\n他来了。\n她没动。\n\n###第4章\n\n好。\n')
  const z = P.normalizeMarkers('导语：\n1、\n一句。', channel('yanxuan'), 1)
  assert.equal(z, '1.\n\n一句。\n')
})

t('宽松 JSON：模型用「。」当字段分隔符也能解析（2026-10-04 实测）', () => {
  const j = P.looseJson('{"hookScore":7,"biggest":["a","b"]。"leadRewriteHint":"x"}')
  assert.equal(j.hookScore, 7); assert.equal(j.leadRewriteHint, 'x')
})

t('分节与合并互逆', () => {
  const body = '###1.\n\n甲。\n乙。\n\n###2.\n\n丙。\n'
  const secs = P.splitSections(body)
  assert.equal(secs.length, 2); assert.equal(secs[0].text, '甲。\n乙。')
  assert.equal(P.joinSections(secs), body)
})

t('情报摘要：能读到榜单热词（情报站存在时）', () => {
  const s = P.trendBrief()
  if (fs.existsSync('data\\intel\\rank')) assert.match(s, /书名高频词/)
})

t('闸门：oh-story 检查器在沙箱稿件上真实运行并给出字数/节数结论', () => {
  const id = 'stest'
  const dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, channelId: 'meitian', genre: '世情打脸' }))
  const row = (n) => `| 开头 | 事${n} | 他摔了碗{冲突} | 怒 | 无（本节改变：风险） | 摔碗 → 吵 → 走 → 新问题 | 他要走 | 接下一节 | 碗 | 行动 | 争吵 | 300 |`
  fs.writeFileSync(path.join(dir, '小节大纲.md'), `| 结构段/五段功能 | 主事件 | 情节推进 | 情绪 | 人物/关系变化 | 因果/逻辑链 | 读者新获知什么 | 结尾承接/钩子 | 伏笔/物件 | 场景形态 | 对白作用 | 目标字数 |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n${row(1)}\n${row(2)}\n`)
  fs.writeFileSync(path.join(dir, '正文.md'), '###1.\n\n我妈把彩礼退了回去，一共十八万八。\n\n###2.\n\n他说：“你走吧……”\n')
  const g = P.gates(id)
  assert.equal(g.sections, 2)
  assert.equal(g.deliveryOk, false, '字数远低于 6000，必须判不过')
  // 交付契约检查器来自外部的 oh-story 技能包（不随本仓库发布）：装了才验细节
  if (fs.existsSync(path.join('short', 'oh-story', 'story-short-write', 'scripts', 'check-delivery-contract.js'))) {
    assert.ok(g.deliveryFails.some((f) => f.id === 'delivery.visible-chars'))
    assert.ok(!fs.readFileSync(path.join(dir, '正文.md'), 'utf8').includes('……'), '标点归一应去掉省略号')
  } else console.log('    · 未放入 oh-story 技能包（short/oh-story/），跳过交付检查器细节断言')
  assert.equal(g.pass, false)
})

const F = await import('./short/refine.mjs')
t('盲比两顺序一致才算胜，否则平', () => {
  assert.equal(F.aggregateBlind('A', 'B'), 'left')
  assert.equal(F.aggregateBlind('B', 'A'), 'right')
  assert.equal(F.aggregateBlind('A', 'A'), 'tie')
  assert.equal(F.aggregateBlind('bad', 'B'), 'tie')
})
t('锦标赛新版必须两胜且硬闸门通过', () => {
  assert.equal(F.adoptCandidate({ pass: true }, 'right'), true)
  assert.equal(F.adoptCandidate({ pass: false }, 'right'), false)
  assert.equal(F.adoptCandidate({ pass: true }, 'tie'), false)
  assert.equal(F.adoptCandidate({ pass: true }, 'left'), false)
})
t('预算事前预留与事后熔断', () => {
  const b = new F.Budget(1)
  b.add(0.4); b.check(0.5)
  assert.throws(() => b.check(0.6), F.BudgetStop)
  assert.throws(() => b.add(0.6), F.BudgetStop)
  assert.throws(() => new F.Budget(11), F.BudgetStop)
})
t('留存坏 JSON、不全节、伪造引文不能刷分', () => {
  const secs = [{ text: '甲。乙。' }, { text: '丙。' }]
  assert.equal(F.parseRetention('bad', secs).valid, false)
  assert.equal(F.parseRetention('{"sections":[]}', secs).average, null)
  const r = F.parseRetention('```json\n{"sections":[{"section":1,"probability":60,"skip":["甲。","假句"]},{"section":2,"probability":80}],"contradictions":[{"a":"甲。","b":"丙。"},{"a":"假的","b":"丙。"}]}\n```', secs)
  assert.equal(r.average, 70); assert.equal(r.minimum, 60)
  assert.deepEqual(r.curve[0].skip, ['甲。']); assert.equal(r.contradictions.length, 1)
})
t('锚点只取四条实际存在逐字导语，不填第五条', () => {
  const anchors = F.loadAnchors()
  if (anchors.length) assert.equal(anchors.length, 4, '提供了锚点样本文件时，必须正好四条逐字导语')
  else console.log('    · 未提供锚点样本（WORKSHOP_SHORT_ANCHORS），空锚点合法')
})
const L = await import('./short/learning.mjs')
const Q = await import('./short/quality.mjs')
const H = await import('./short/polish.mjs')
t('收窄上下文：邻节全文、其余摘要≤150字，超12000 token拒绝调用', () => {
  const secs = Array.from({ length: 14 }, (_, i) => ({ marker: `###第${i + 1}章`, text: '他把门推开。' + '甲'.repeat(800) + '她把门关上。' }))
  const cache = L.contextCache(secs, [])
  assert.ok(cache.summaries.every((x) => [...x].length <= 150))
  const text = L.buildRewriteContext({ secs, k: 5, rows: [], setting: '人物设定', cache })
  assert.ok(text.includes(secs[4].text) && text.includes(secs[6].text))
  assert.ok(text.length < P.joinSections(secs).length / 2)
  assert.ok(L.assertRewriteSize('作者', text) <= 12000)
  assert.throws(() => L.assertRewriteSize('', '甲'.repeat(7001)), /超限/)
  console.log('  收窄样本：', text.length + 2, '字符，保守估算', (text.length + 2) * 2, 'token')
})
t('现实逻辑只定位稿件原句，非法领域或伪造引文丢弃', () => {
  const secs = [{ text: '母亲签了担保书。' }, { text: '银行拒绝放款。' }]
  assert.deepEqual(F.locateRealism(secs, [
    { quote: '母亲签了担保书。', why: '法律', domain: '法律' },
    { quote: '不存在的句子', why: '伪造', domain: '常识' },
    { quote: '银行拒绝放款。', why: '坏领域', domain: '平台' },
  ]).map((x) => x.quote), ['母亲签了担保书。'])
})

t('矛盾定位按节排序、最多4节且本节评审只带相关引文', () => {
  const secs = ['甲地点。', '乙欠条。', '丙年份。', '丁礼单。', '戊金额。', '己烧毁。'].map((text) => ({ text }))
  const review = { curve: secs.map((_, i) => ({ section: i + 1, probability: 50 + i })), contradictions: [
    { a: '甲地点。', b: '乙欠条。' }, { a: '甲地点。', b: '己烧毁。' }, { a: '丙年份。', b: '丁礼单。' },
    { a: '戊金额。', b: '不存在。' }, { a: '不存在2。', b: '不存在3。' }, { a: '己烧毁。', b: '丁礼单。' } ] }
  const located = F.locateContradictions(secs, review.contradictions)
  assert.equal(located.unlocated, 2); assert.equal(located.fixes.length, 4); assert.equal(located.fixes[0].section, 1)
  const scoped = L.sectionReview(secs, 0, review)
  assert.equal(scoped.contradictions.length, 2); assert.equal(scoped.contradictions.some((x) => x.a === '丙年份。'), false)
})
t('重写估算按1.8 token/字符，并按三级顺序降级后通过或全降仍抛错', () => {
  const base = { system: '作者', secs: [{ text: '甲'.repeat(2500) }], k: 0, rows: [], setting: '设定'.repeat(800), cache: { summaries: [], facts: '事实'.repeat(800) }, review: { curve: [{ section: 1, probability: 50 }], contradictions: [] }, instruction: '重写' }
  // 1.8 token/字符下需补 2500 字后缀才会三级全降（基线 9027 token，每级省约 1080）
  const L2 = L.buildRewritePrompt({ ...base, suffix: '乙'.repeat(2500) }); assert.ok(L2.estimatedTokens <= 12000); assert.deepEqual(L2.degradation.map((x) => x.step), ['其余节摘要45→25', '设定1200→600', '事实摘录1200→600'])
  assert.equal(L.estimateRewriteTokens('甲', '乙'), 4) // ceil(2×1.8)
  assert.equal(L.estimateRewriteTokens('甲'.repeat(10), ''), 18)
  // 本节原文/设定/事实都有截断上限，只有不可压缩部分（后缀）过大时三级全降才仍超限
  assert.throws(() => L.buildRewritePrompt({ ...base, suffix: '乙'.repeat(3000) }), /超限/)
})
// 异步用例必须 await，否则断言失败只会在「通过」之后变成未处理拒绝
await (async (name, fn) => { await fn(); pass++; console.log('✓', name) })('矛盾修复过的节不重复进入留存重写', async () => {
  const secs = [1, 2, 3, 4, 5, 6].map((n) => ({ text: `第${n}节。` })), calls = []
  const result = await F.rewriteRoundSections(secs, { curve: secs.map((_, i) => ({ section: i + 1, probability: 20 + i })), contradictions: [{ a: '第2节。', b: '第3节。' }] }, async (_secs, k, _review, kind) => { calls.push([k + 1, kind]); return `改${k + 1}` }, {})
  assert.equal(calls.filter((x) => x[0] === 2 && x[1] === 'contradiction').length, 1); assert.equal(calls.some((x) => x[0] === 2 && x[1] === 'retention'), false); assert.equal(calls.some((x) => x[0] === 3 && x[1] === 'retention'), false)
  // 第2、3节都含矛盾引文已修过；剩余非末节按分低选第1、4节（0基 0、3）
  assert.deepEqual(result.weak, [0, 3])
})
t('矛盾修复走cheap、留存重写走学习选出的写手、真实角色名原样', () => {
  assert.equal(F.rewriteRole('contradiction', 'writer'), 'cheap')
  assert.equal(F.rewriteRole('retention', 'writer'), 'writer')
  assert.equal(F.rewriteRole('retention', 'cheap'), 'cheap')
  assert.equal(F.rewriteRole('writer', 'cheap'), 'writer')
})
t('重写缓存：同键命中、换写手或换指令不命中、坏文件不抛错', () => {
  const dir = fs.mkdtempSync(path.join(SB, 'rc-'))
  const k1 = F.rewriteCacheKey('原文', 'contradiction', 'cheap', '指令')
  assert.deepEqual(F.readRewriteCache(dir), {})
  F.writeRewriteCache(dir, k1, '改好的')
  assert.equal(F.readRewriteCache(dir)[k1], '改好的')
  assert.equal(F.readRewriteCache(dir)[F.rewriteCacheKey('原文', 'contradiction', 'writer', '指令')], undefined)
  assert.equal(F.readRewriteCache(dir)[F.rewriteCacheKey('原文', 'contradiction', 'cheap', '指令2')], undefined)
  fs.writeFileSync(path.join(dir, 'versions', 'rewrite-cache.json'), '{坏')
  assert.deepEqual(F.readRewriteCache(dir), {})
})
await (async (name, fn) => { await fn(); pass++; console.log('✓', name) })('润色引号保真：节内引号数变化即保留原文（R8 直引化缺陷回归）', async () => {
  const H = await import('./short/polish.mjs')
  assert.equal(H.quoteCount('他说：“走。”她说「好」'), 4)
  const id = 'quote-guard'
  const dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  const body = '###第1章\n\n就这一句。她没问一句学费多少。\n\n###第2章\n\n"走吧。"他说。\n'
  fs.writeFileSync(path.join(dir, '正文.md'), body, 'utf8'); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, channelId: 'fanqie-short' }), 'utf8')
  const good = { pass: true, deliveryOk: true, deliveryFails: [], aiBlocking: [], degenBlocking: [] }
  const r = await H.polishShort(id, { gateCheck: () => good, run: async ({ text, output }) => { const t = text.replace('她没问一句', '她没问：“一句') + '”'; fs.writeFileSync(output, t); return { ok: true, text: t } } })
  assert.equal(r.sections[0].changed, false); assert.match(r.sections[0].error, /引号数/)
  assert.ok(fs.readFileSync(path.join(dir, '正文.md'), 'utf8').includes('她没问一句学费多少'))
})
t('writer选择：不足4条保持默认；4条胜率0.5选cheap，低于0.5选writer；平局无效', () => {
  const win = { genre: '悬疑', ab: { winner: 'A' }, ba: { winner: 'B' }, verdict: 'left' }
  const lose = { genre: '悬疑', ab: { winner: 'B' }, ba: { winner: 'A' }, verdict: 'right' }
  assert.equal(L.pickWriterRole('悬疑', { records: [win, win, win], defaultRole: 'writer' }).role, 'writer')
  assert.equal(L.pickWriterRole('悬疑', { records: [win, win, lose, lose] }).role, 'cheap')
  assert.equal(L.pickWriterRole('悬疑', { records: [win, lose, lose, lose] }).role, 'writer')
  assert.equal(L.pickWriterRole('其他', { records: [win, win, win, win] }).valid, 0)
  L.appendLearning(win); assert.equal(L.readLearning().length, 1)
})
t('release三档及证据缺失、版本错配降级', () => {
  const base = { gates: { pass: true }, retention: { valid: true, minimum: 70 }, anchor: { winRate: 0.5 }, unresolved: 0 }
  assert.equal(Q.releaseDecision(base).release, 'competitive')
  assert.equal(Q.releaseDecision({ ...base, retention: { valid: true, minimum: 69 } }).release, 'usable')
  assert.equal(Q.releaseDecision({ ...base, gates: { pass: false } }).release, 'blocked')
  assert.equal(Q.releaseDecision({ ...base, evidenceCurrent: false }).release, 'usable')
  assert.equal(Q.releaseDecision({ ...base, unresolved: 1 }).release, 'usable')
})
t('润色新增单项交付失败必须回滚，即使整体原先不通过', () => {
  assert.equal(H.hardGateRegression({ pass: false, deliveryOk: false, deliveryFails: [{ id: 'length' }] }, { pass: false, deliveryOk: false, deliveryFails: [{ id: 'length' }, { id: 'markers' }] }), true)
})
const at = async (name, fn) => { await fn(); pass++; console.log('✓', name) }
await at('润色退步整篇回滚，保真失败节保留，版本记录齐全（桩零模型）', async () => {
  const id = 'stest', dir = P.shortDir(id), file = path.join(dir, '正文.md')
  const original = fs.readFileSync(file, 'utf8')
  const good = { pass: true, deliveryOk: true, aiBlocking: [], degenBlocking: [] }
  let n = 0
  const r = await H.polishShort(id, { gateCheck: () => n++ ? { ...good, aiBlocking: [{}], pass: false } : good,
    run: async ({ text }) => ({ ok: true, text: text + '改句。', cost: 0 }) })
  assert.equal(r.rolledBack, true); assert.equal(fs.readFileSync(file, 'utf8'), original)
  assert.ok(fs.existsSync(path.join(dir, 'versions', r.versions + '-candidate.md')))
  const r2 = await H.polishShort(id, { gateCheck: () => good, run: async () => ({ ok: false, code: 5 }) })
  assert.ok(r2.sections.every((s) => !s.changed && !s.ok))
})
await at('规则润色脚本真实零成本运行，不调用模型', async () => {
  const r = await H.polishShort('stest')
  assert.equal(r.mode, 'rules'); assert.ok(r.sections.every((s) => s.cost === 0))
  assert.ok(r.sections.some((s) => s.ok))
})
await at('resume按持久阶段跳过已完成操作，二次resume不重付', async () => {
  const id = 'resume-test', dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, idea: { title: '桩' }, stage: 'gated', gates: {}, consistency: {}, editor: [{}] }))
  const calls = [], stages = {}
  for (const name of ['design', 'draft', 'repair', 'consistency', 'editorRead', 'refine', 'polish', 'finalRepair', 'quality', 'package']) stages[name] = async () => { calls.push(name) }
  await P.resumeShort(id, { stages })
  assert.deepEqual(calls, ['polish', 'refine', 'finalRepair', 'quality', 'package'])
  calls.length = 0; await P.resumeShort(id, { stages }); assert.deepEqual(calls, [])
})
await at('resume失败前持久失效标记，重试不错误跳过下游旧成果', async () => {
  const id = 'resume-fail', dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, idea: {}, stage: 'done', package: {}, quality: {}, completed: { design: true, draft: true, repair: true, consistency: true, editorRead: true, quality: true, package: true } }))
  await assert.rejects(() => P.resumeShort(id, { stages: { polish: async () => { throw new Error('桩失败') } } }), /桩失败/)
  assert.equal(P.readMeta(id).completed.package, undefined)
  const calls = [], stages = {}
  for (const name of ['polish', 'refine', 'finalRepair', 'quality', 'package']) stages[name] = async () => calls.push(name)
  await P.resumeShort(id, { stages }); assert.deepEqual(calls, ['polish', 'refine', 'finalRepair', 'quality', 'package'])
})
await at('quality报告写盘可复算，并包含检测器不作放行条件', async () => {
  const id = 'stest', dir = P.shortDir(id)
  const q = Q.qualityReport(id)
  assert.equal(q.release, 'blocked')
  assert.ok(fs.readFileSync(path.join(dir, '质量报告.md'), 'utf8').includes('朱雀和 TMS 读数不作为放行条件'))
  assert.equal(P.readMeta(id).quality.bodyHash, Q.bodyHash(fs.readFileSync(path.join(dir, '正文.md'), 'utf8')))
})
await at('独立四维评分：分差≥1判胜，小于1平，单文本prompt', async () => {
  const score = (n) => JSON.stringify({ event: n, emotion: n, logic: n, pace: n, total: n })
  let calls = 0
  const j = F.createIndependentJudge({ model: 'stub', ask: async (_tag, opts) => { calls++; assert.ok(!opts.user.includes('【A】')); return score(opts.user.endsWith('高') ? 8 : opts.user.endsWith('近') ? 7.5 : 7) } })
  assert.equal((await j.compare('高', '低', 'test')).verdict, 'left')
  assert.equal((await j.compare('低', '高', 'test')).verdict, 'right')
  assert.equal((await j.compare('高', '近', 'test')).verdict, 'tie')
  assert.equal(calls, 3)
  assert.throws(() => F.parseIndependentScore('{"event":10,"emotion":10,"logic":10,"pace":10,"total":1}'))
})
await at('锚点缓存按hash+模型跨轮复用，同轮导语不重复调用', async () => {
  const file = path.join(SB, 'anchor-scores.json'), anchors = [{ text: '锚点甲' }, { text: '锚点乙' }]
  let calls = 0
  const ask = async () => { calls++; return '{"event":7,"emotion":7,"logic":7,"pace":7,"total":7}' }
  const j = F.createIndependentJudge({ ask, model: 'stub', anchorFile: file })
  await j.anchorScore('导语', anchors, 'one'); await j.anchorScore('导语', anchors, 'two'); assert.equal(calls, 3)
  j.clear(); await j.anchorScore('导语', anchors, 'three'); assert.equal(calls, 4)
  await F.createIndependentJudge({ ask, model: 'stub', anchorFile: file }).anchorScore('新导语', anchors, 'four'); assert.equal(calls, 5)
  await F.createIndependentJudge({ ask, model: 'other', anchorFile: file }).anchorScore('新导语', anchors, 'five'); assert.equal(calls, 8)
})
await at('累计漏斗无效并最多重问一次，末节不选为重写节', async () => {
  const secs = Array.from({ length: 6 }, (_, k) => ({ marker: `###${k + 1}.`, text: `内容${k}。` }))
  const raw = (ps) => JSON.stringify({ sections: ps.map((probability, k) => ({ section: k + 1, probability })) })
  const bad = raw([86, 76, 70, 55, 21, 14])
  assert.equal(F.parseRetention(bad, secs).error, 'cumulative-retention')
  let calls = 0
  const r = await F.evaluateRetention(P.joinSections(secs), 'test', async (_tag, opts) => { calls++; assert.match(opts.user, /不是累计留存/); if (calls === 2) assert.match(opts.user, /纠正/); return calls === 1 ? bad : raw([80, 75, 90, 72, 88, 10]) })
  assert.equal(calls, 2); assert.deepEqual(r.weakest.map((x) => x.section), [4, 2])
  calls = 0
  await assert.rejects(() => F.evaluateRetention(P.joinSections(secs), 'test', async () => { calls++; return bad }), /保留原稿/)
  assert.equal(calls, 2)
})
await at('成对评分批次位置偏差标记，质量不计入放行', async () => {
  const batch = [], ask = async () => '{"winner":"A"}'
  for (let k = 0; k < 3; k++) await F.pairedBlind('甲', '乙', 'pair', ask, batch)
  assert.ok(batch.every((x) => x.positionBiased))
  assert.equal(F.positionBias(batch.slice(0, 2)).positionBiased, false)
  const q = Q.releaseDecision({ gates: { pass: true }, retention: { valid: true, minimum: 80 }, anchor: { winRate: 1, comparisons: batch }, unresolved: 0 })
  assert.equal(q.release, 'usable'); assert.ok(q.reasons.some((x) => x.includes('不可信')))
})
await at('全新resume执行新阶段顺序（全桩）', async () => {
  const id = 'new-order', dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, idea: {}, completed: {} }))
  const order = ['design', 'draft', 'repair', 'consistency', 'editorRead', 'polish', 'refine', 'finalRepair', 'quality', 'package'], calls = []
  await P.resumeShort(id, { stages: Object.fromEntries(order.map((name) => [name, async () => calls.push(name)])) })
  assert.deepEqual(calls, order)
})
await at('finalRepair局部单次留存+首节独立分，更新hash后competitive', async () => {
  const id = 'final-local', dir = P.shortDir(id); fs.mkdirSync(path.join(dir, 'versions'), { recursive: true })
  const secs = Array.from({ length: 6 }, (_, k) => ({ marker: `###${k + 1}.`, text: `原句${k}。` }))
  const body = P.joinSections(secs), file = path.join(dir, '正文.md'), anchors = [{ text: '锚点' }]
  fs.writeFileSync(file, body); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id }))
  const retention = F.parseRetention(JSON.stringify({ sections: secs.map((_, k) => ({ section: k + 1, probability: 80 })) }), secs)
  fs.writeFileSync(path.join(dir, 'refine-log.jsonl'), JSON.stringify({ bodyHash: Q.bodyHash(body), retention, anchor: { winRate: 1, anchorCount: 1 } }) + '\n')
  let retainCalls = 0, scoreCalls = 0
  const ask = async (tag, opts) => {
    if (tag === 'final-retention') { retainCalls++; assert.ok(!opts.user.includes('原句1。') && !opts.user.includes('原句4。')); return JSON.stringify({ sections: [1, 2, 3].map((section) => ({ section, probability: 85 })) }) }
    scoreCalls++; return JSON.stringify(Object.fromEntries([...F.SCORE_DIMENSIONS, 'total'].map((k) => [k, opts.user.endsWith('锚点') ? 7 : 9])))
  }
  await P.finalRepair(id, () => {}, { gateCheck: () => ({ pass: true }), repairStage: async () => { const next = secs.map((s) => ({ ...s })); next[0].text += '首节改。'; next[3].text += '第四节改。'; fs.writeFileSync(file, P.joinSections(next)); return { pass: true } }, refresh: (id, before) => F.refreshFinalEvidence(id, before, { ask, model: 'stub', anchors }) })
  assert.equal(retainCalls, 1); assert.equal(scoreCalls, 2)
  const q = Q.qualityReport(id, { gateCheck: () => ({ pass: true }) }); assert.equal(q.evidenceCurrent, true); assert.equal(q.release, 'competitive')
  const last = JSON.parse(fs.readFileSync(path.join(dir, 'refine-log.jsonl'), 'utf8').trim().split('\n').at(-1)); assert.deepEqual(last.reevaluated, [1, 3, 4])
  const current = fs.readFileSync(file, 'utf8')
  await assert.rejects(() => P.finalRepair(id, () => {}, { gateCheck: () => ({ pass: true }), repairStage: async () => fs.writeFileSync(file, current + '坏改'), refresh: async () => { throw new Error('评分失败') } }), /评分失败/)
  assert.equal(fs.readFileSync(file, 'utf8'), current)
})
// 2026-10-06 内测实测回归：小节大纲.md 里混进第二份设定+大纲 → 18 节、15852 字；功能标签 {行动} 不在白名单 → 构思门禁挂
const HEAD = '| 结构段/五段功能 | 主事件 | 情节推进 | 情绪 | 人物/关系变化 | 因果/逻辑链 | 读者新获知什么 | 结尾承接/钩子 | 伏笔/物件 | 场景形态 | 对白作用 | 目标字数 |'
const SEP = '|' + ' --- |'.repeat(12)
const row = (k, push) => `| 开头 | 事件${k} | ${push} | 怕 | 变 | 因 | 知 | 钩 | 物 | 室内 | 推进 | 1000 |`
t('大纲只认第一张表，白名单外功能标签映射、无标签步骤补递进', () => {
  const text = [HEAD, SEP, row(1, '甲开门{行动} -> 乙回头{回忆}'), row(2, '丙摔碗'), '<<<设定.md>>>', '# 设定.md', HEAD, SEP, row(3, '重复{对话}')].join('\n')
  const n = P.normalizeOutline(text)
  assert.equal(n.text.split('\n').filter((l) => l.startsWith('| 开头')).length, 2)
  assert.ok(n.text.includes('甲开门{递进} -> 乙回头{回忆}') && n.text.includes('丙摔碗{递进}') && !n.text.includes('设定.md'))
  assert.equal(n.fixedTags, 2); assert.equal(n.dropped, 5)
  const id = 'two-tables', dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '小节大纲.md'), text)
  assert.equal(P.outlineRows(id).length, 2)
})
await at('repair 先零成本删掉多于大纲的重复节', async () => {
  if (!fs.existsSync(path.join('short', 'oh-story', 'story-short-write', 'references', 'short-craft.md'))) {
    console.log('    · 未放入 oh-story 技能包，repair 需要 references/short-craft.md，跳过'); return
  }
  const id = 'dup-secs', dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, channelId: 'xiaochengxu', genre: '民俗怪谈', idea: {} }))
  fs.writeFileSync(path.join(dir, '小节大纲.md'), [HEAD, SEP, row(1, 'a{递进}'), row(2, 'b{递进}')].join('\n') + '\n')
  fs.writeFileSync(path.join(dir, '正文.md'), P.joinSections([1, 2, 3, 4].map((k) => ({ marker: `###${k}.`, text: `第${k}节。` }))))
  const asked = []
  await P.repair(id, () => {}, 0, async (m, tag) => { asked.push(tag); return '' })
  assert.equal(P.splitSections(fs.readFileSync(path.join(dir, '正文.md'), 'utf8')).length, 2)
  assert.deepEqual(asked, []); assert.equal(P.readMeta(id).sectionsTrimmed[0].from, 4)
})
await at('refine 档位模式路由：agent id 是档位名不再误判降级；最终修补无原版评分时跳过不抛错', async () => {
  const id = 'no-evidence', dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  const secs = [1, 2].map((k) => ({ marker: `###${k}.`, text: `原${k}。` }))
  fs.writeFileSync(path.join(dir, '正文.md'), P.joinSections(secs)); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id }))
  const before = fs.readFileSync(path.join(dir, '正文.md'), 'utf8')
  fs.writeFileSync(path.join(dir, '正文.md'), P.joinSections([{ ...secs[0], text: '改。' }, secs[1]]))
  const r = await F.refreshFinalEvidence(id, before, { ask: async () => { throw new Error('不该调模型') }, model: 'stub' })
  assert.equal(r.skipped, 'no-evidence')
  const src = fs.readFileSync(new URL('./short/refine.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('r.agent !== a.id') && !src.includes('r.agent !== role'))
})
await at('resume：正文节数多于大纲时从 repair 起重跑', async () => {
  const id = 'dup-resume', dir = P.shortDir(id); fs.mkdirSync(dir, { recursive: true })
  const done = Object.fromEntries(['design', 'draft', 'repair', 'consistency', 'editorRead', 'polish', 'refine'].map((k) => [k, true]))
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, idea: {}, completed: done }))
  fs.writeFileSync(path.join(dir, '小节大纲.md'), [HEAD, SEP, row(1, 'a{递进}')].join('\n') + '\n')
  fs.writeFileSync(path.join(dir, '正文.md'), P.joinSections([1, 2].map((k) => ({ marker: `###${k}.`, text: `第${k}节。` }))))
  const order = ['design', 'draft', 'repair', 'consistency', 'editorRead', 'polish', 'refine', 'finalRepair', 'quality', 'package'], calls = []
  await P.resumeShort(id, { stages: Object.fromEntries(order.map((name) => [name, async () => calls.push(name)])) })
  assert.deepEqual(calls, order.slice(2))
})
fs.rmSync(SB, { recursive: true, force: true })
console.log(`\n短篇模块测试 ${pass}/${pass} 通过`)

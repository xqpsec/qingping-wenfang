// test-revision.mjs —— 零成本回归：改写稿 → 公平对比 → 采用/放弃 → 回滚（分数跟着回来）
// 用法：node workshop/test-revision.mjs
// 做法：起一个本机假模型服务（不花钱）+ 临时沙箱书库（真书不受影响），走完整个改稿流程。
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rev-'))

// ── 假模型：按提示词判断是哪类调用 ──
const para = (s) => Array.from({ length: 40 }, (_, i) => `${s}第${i}段，林川抬眼看着对面那人，手里的茶杯没放下。`).join('\n\n')
const fake = http.createServer(async (req, res) => {
  let s = ''; for await (const c of req) s += c
  const body = JSON.parse(s); const u = body.messages.at(-1).content
  let out
  if (/结论=甲 或 结论=乙/.test(u)) {
    // 成对比较：带「改写标记」的那版更好（换序后也一致）
    const ia = u.indexOf('【版本甲】'), ib = u.indexOf('【版本乙】'), im = u.indexOf('改写标记')
    out = `理由略。\n结论=${im > ia && im < ib ? '甲' : '乙'}|2`
  } else if (/read_next=/.test(u)) {
    const good = /改写标记/.test(u) ? 8 : 6
    out = '感受略。\n' + ['hook_open', 'conflict', 'payoff', 'novelty', 'protagonist', 'density', 'dialogue', 'humor', 'logic', 'cliff'].map((k) => `${k}=${good}|理由`).join('\n') + `\nread_next=${good * 7}|x\nbest=开头\nworst=中段\nfix1=加快`
  } else out = `第1章 改过的章名\n\n${para('改写标记')}`
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: out } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }))
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${fake.address().port}/v1`
const agent = { name: '假模型', baseUrl: base, model: 'fake', apiKey: 'x', priceIn: 1, priceOut: 1 }
fs.writeFileSync(path.join(SB, 'agents.json'), JSON.stringify({ agents: { cheap: agent, writer: agent, pro: agent, gpt: agent }, assign: {} }))
process.env.WORKSHOP_SANDBOX = SB

const S = await import('./lib/store.mjs')
const PL = await import('./lib/pipeline.mjs')
let pass = 0
const t = async (name, fn) => { await fn(); pass++; console.log('✓', name) }

try {
  assert.ok(S.BOOKS.startsWith(SB), '书库没有进沙箱')
  const b = S.createBook('测试书')
  const orig = `第1章 原章名\n\n${para('原稿')}\n`
  S.commitChapter(b.id, 1, orig, { title: '原章名', chars: 1000, score: 50, readNext: 40 })
  S.writeText(b.id, 'work/0001/report.json', JSON.stringify({ total: 50, readNext: 40, worst: '太慢', fixes: ['加快'] }))

  await t('停止信号拒绝模型请求并保留定稿', async () => {
    const { abortCtl } = await import('./lib/llm.mjs')
    const ctl = new AbortController(); ctl.abort(); abortCtl.signal = ctl.signal
    try { await assert.rejects(() => PL.reviseChapter(b.id, 1, '加快'), /中止|停止/); assert.equal(S.readText(b.id, 'chapters', '0001.txt'), orig) }
    finally { abortCtl.signal = null }
  })
  await t('改写后定稿不变，改写稿进候选并有改前/改后同评审打分', async () => {
    const rev = await PL.reviseChapter(b.id, 1, '')
    assert.equal(S.readText(b.id, 'chapters', '0001.txt'), orig)
    assert.equal(S.readBook(b.id).chapters[0].score, 50)
    assert.ok(rev.compare.sameJudge && rev.compare.before.total < rev.compare.after.total)
    assert.equal(rev.compare.verdict, '改后更好')
  })
  await t('再改一版：上一版未决定的改写稿被归档而不是丢失', async () => {
    await PL.reviseChapter(b.id, 1, '再快一点')
    const arch = fs.readdirSync(S.bookPath(b.id, 'work', '0001', 'revisions'))
    assert.ok(arch.some((f) => f.endsWith('-superseded.json')))
  })
  await t('采用：定稿替换，分数取对比时的改后分，旧版本带当时分数', async () => {
    PL.adoptRevision(b.id, 1)
    assert.ok(S.readText(b.id, 'chapters', '0001.txt').includes('改写标记'))
    const c = S.readBook(b.id).chapters[0]; assert.ok(c.score > 50)
    const h = S.listHistory(b.id, 1); assert.equal(h[0].score, 50); assert.equal(h[0].replacedBy, `采用改写稿（对比时改前55分→改后${c.score}分）`)
    assert.ok(!fs.existsSync(S.bookPath(b.id, 'work', '0001', 'revision.json')))
    // 采用后报告指纹 = 当前定稿正文指纹（界面据此判断「报告评的是不是这一版」）
    assert.equal(S.readJson(b.id, 'work/0001/report.json').textHash, S.bodyHash(S.readText(b.id, 'chapters', '0001.txt')))
  })
  await t('回滚：正文、分数、评审报告一起回到旧版本', async () => {
    const h = S.listHistory(b.id, 1)
    // 默认只换正文、保留当前章名（模拟用户实测：连章名一起退回会把修好的章名改坏）
    const curTitle = S.readText(b.id, 'chapters', '0001.txt').split('\n')[0]
    S.rollback(b.id, 1, h[0].file)
    const kept = S.readText(b.id, 'chapters', '0001.txt')
    assert.equal(kept.split('\n')[0], curTitle)
    assert.equal(kept.split('\n').slice(1).join('\n'), orig.split('\n').slice(1).join('\n'))
    // 显式选择连章名一起恢复 = 与原稿逐字相同
    S.rollback(b.id, 1, h[0].file, { keepTitle: false })
    assert.equal(S.readText(b.id, 'chapters', '0001.txt'), orig)
    assert.equal(S.readBook(b.id).chapters[0].score, 50)
    assert.equal(S.readJson(b.id, 'work/0001/report.json').total, 50)
    // 回滚前的改写版也进了旧版本，可再恢复；原因是人能看懂的话，不是文件名
    const h2 = S.listHistory(b.id, 1)
    assert.ok(h2.some((x) => x.score > 50))
    assert.ok(/^恢复旧版本时换下来的（当时恢复的是 .+ 存档的那版，.+）$/.test(h2[0].replacedBy), h2[0].replacedBy)
    // 列表带章名与正文指纹（界面据此标「与当前定稿相同」）
    assert.equal(h2[0].hash, S.bodyHash(S.readText(b.id, 'history', h2[0].file)))
    assert.ok(h2[0].title.startsWith('第1章'))
    // 字数与章节表同口径（不含章名行与空白）
    assert.equal(h2[0].chars, S.readText(b.id, 'history', h2[0].file).split('\n').slice(1).join('').replace(/\s/g, '').length)
  })
  await t('放弃：定稿不动', async () => {
    await PL.reviseChapter(b.id, 1, 'x'); PL.discardRevision(b.id, 1)
    assert.equal(S.readText(b.id, 'chapters', '0001.txt'), orig)
  })
  await t('逐段 diff：只改一段时只报一处，且位置正确', async () => {
    assert.deepEqual(PL.paraChanges(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e']), [{ at: 2, del: ['b'], add: ['B'] }, { at: 5, del: [], add: ['e'] }])
    assert.deepEqual(PL.paraChanges(['x', 'y'], ['x', 'y']), [])
    assert.deepEqual(PL.paraChanges(['x', 'y', 'z'], ['x', 'z']), [{ at: 2, del: ['y'], add: [] }])
  })
  await t('回滚拒绝不合法的文件名（防路径穿越）', async () => {
    assert.throws(() => S.rollback(b.id, 1, '../book.json'))
  })
  await t('沙箱调用记录不混进真实花费', async () => {
    const { CALL_LOG } = await import('./lib/llm.mjs'); assert.ok(CALL_LOG.startsWith(SB))
  })
  console.log(`\n${pass} 项全部通过`)
} finally {
  fake.close(); fs.rmSync(SB, { recursive: true, force: true })
}

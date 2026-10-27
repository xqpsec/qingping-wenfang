// test-fanqie.mjs —— 番茄作品信息（词表/校验/保存/交付单）零成本验收：node test-fanqie.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fanqie-'))
process.env.WORKSHOP_SANDBOX = SB
const FQ = await import('./lib/fanqie.mjs')
const S = await import('./lib/store.mjs')
const PK = await import('./lib/packaging.mjs')
const { deliverBook } = await import('./lib/delivery.mjs')
let pass = 0
const t = (name, fn) => { try { fn(); pass++; console.log('✓', name) } catch (e) { console.log('✗', name, '\n  ', e.message); process.exitCode = 1 } }

t('词表数量与抓取一致', () => {
  assert.equal(FQ.SPEC.read.male.main.length, 19); assert.equal(FQ.SPEC.read.female.main.length, 21)
  assert.equal(FQ.SPEC.content.plot.length, 144); assert.equal(FQ.SPEC.content.emotion.length, 58)
  assert.equal(FQ.SPEC.content.persona.length, 94); assert.equal(FQ.SPEC.content.world.length, 60)
  assert.deepEqual(FQ.LIMITS, { title: 15, introMin: 50, introMax: 500, hero: 5, heroCount: 2 })
})
t('男女频阅读标签词表不同：女频主分类不接受男频词', () => {
  const r = FQ.normalizeMeta({ audience: 'female', read: { main: '都市脑洞' } })
  assert.equal(r.meta.read.main, ''); assert.ok(r.problems.some((p) => p.includes('主分类')))
})
t('宽松模式：丢弃非法词、截断超量；严格模式报错', () => {
  const raw = { audience: 'male', read: { main: '都市脑洞', theme: ['都市', '瞎编', '玄幻', '历史'] }, content: { plot: ['读心', '复仇', '逆袭'], persona: ['马甲', '神医'], emotion: ['暗恋', '宠妻', '初恋'], world: ['乡村', '军旅'] }, heroes: ['林川', '陈默', '第三个'] }
  const { meta, problems } = FQ.normalizeMeta(raw)
  assert.deepEqual(meta.read.theme, ['都市', '玄幻']); assert.equal(meta.content.plot.length + meta.content.persona.length, 4)
  assert.deepEqual(meta.content.plot, ['读心', '复仇', '逆袭']); assert.deepEqual(meta.content.persona, ['马甲'])
  assert.deepEqual(meta.content.emotion, ['暗恋', '宠妻']); assert.deepEqual(meta.content.world, ['乡村']); assert.deepEqual(meta.heroes, ['林川', '陈默'])
  assert.ok(problems.length >= 5)
  assert.throws(() => FQ.normalizeMeta(raw, { strict: true }), /不符合番茄规则/)
})
t('合法作品信息严格模式通过，拍平标签包含全部', () => {
  const { meta, problems } = FQ.normalizeMeta({ audience: 'male', signMode: '完本', read: { main: '都市脑洞', theme: ['都市'], role: ['大佬'], plot: ['系统'] }, content: { plot: ['读心'], persona: ['马甲'], emotion: [], world: ['乡村'] }, heroes: ['林川'] }, { strict: true })
  assert.deepEqual(problems, []); assert.equal(meta.signMode, 'complete')
  assert.deepEqual(FQ.flatTags(meta), ['都市脑洞', '都市', '大佬', '系统', '读心', '马甲', '乡村'])
})
t('缺口提示：没选主分类/没填主角名/简介不足 50 字', () => {
  const g = FQ.metaGaps(FQ.emptyMeta('male'), '太短')
  assert.ok(g.some((x) => x.includes('主分类')) && g.some((x) => x.includes('主角名')) && g.some((x) => x.includes('至少 50')))
})
t('给 AI 的词表说明包含对应频道词与上限', () => {
  const s = FQ.specForPrompt('female')
  assert.ok(s.includes('女频悬疑') && !s.includes('都市脑洞、') && s.includes('主分类必选且只能 1 个') && s.includes('合计最多 4 个'))
})

const b = S.createBook('作品信息测试书')
t('applyPackage：保存 meta 严格校验，非法词报错且不落盘', () => {
  assert.throws(() => PK.applyPackage(b.id, { meta: { audience: 'male', read: { main: '瞎编分类' } } }), /不符合番茄规则/)
  assert.equal(S.readBook(b.id).package?.meta, undefined)
  PK.applyPackage(b.id, { meta: { audience: 'male', read: { main: '都市脑洞', theme: ['都市'] }, content: { plot: ['读心'] }, heroes: ['林川'] } })
  const p = S.readBook(b.id).package
  assert.equal(p.meta.read.main, '都市脑洞'); assert.deepEqual(p.tags, ['都市脑洞', '都市', '读心'])
})
t('applyPackage：只改书名/简介不会动 meta', () => {
  PK.applyPackage(b.id, { title: '换个书名试试看吧', intro: '简'.repeat(80) })
  assert.equal(S.readBook(b.id).package.meta.read.main, '都市脑洞')
})
t('交付单按番茄页顺序列出结构化标签与主角名', () => {
  const book = S.readBook(b.id)
  const src = S.bookPath(b.id)
  fs.mkdirSync(path.join(src, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(src, 'chapters', '0001.txt'), '第1章 开始\n\n正文'.repeat(5), 'utf8')
  book.chapters = [{ n: 1, title: '开始', chars: 20 }]; S.saveBook(book)
  const dest = path.join(SB, 'out')
  deliverBook(src, dest, { penName: '笔名' })
  const sheet = fs.readFileSync(path.join(dest, '番茄填写单.txt'), 'utf8')
  assert.ok(sheet.includes('主分类（必选 1 个）：都市脑洞') && sheet.includes('主题（最多 2 个）：都市') && sheet.includes('情节：读心') && sheet.includes('主角名1：林川'), sheet)
  assert.ok(sheet.includes('签约模式（必填，创建后不能改）：连载模式') && sheet.includes('50–500'), sheet)
})
console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`)

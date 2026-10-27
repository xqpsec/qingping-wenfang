// test-import.mjs —— 零成本：带稿导入（拆章 / 落库 / 续写前整理设定 / 大请求中文不乱码 / 页面上传）
// 用法：node workshop/test-import.mjs     （假模型 + 临时沙箱 + 临时实例，跑完删干净）
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-import-'))
let modelCalls = []
const fake = http.createServer(async (req, res) => {
  let s = ''; for await (const c of req) s += c
  const u = JSON.parse(s).messages.at(-1).content; modelCalls.push(u)
  const out = /只根据原文/.test(u)
    ? '## 核心设定\n原文未交代\n## 主角\n林川\n## 主要配角\n老周\n## 反派与阻力\n原文未交代\n## 世界与现实锚点\n小城\n## 长线主线\n推断\n## 文风要求\n短句\n## 各章摘要\n第2章摘要：林川拿到钥匙\n第3章摘要：老周失踪\n## 未回收悬念\n钥匙开哪扇门\n老周去了哪'
    : 'x'
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: out } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const agent = { name: '假模型', baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'fake', apiKey: 'x', priceIn: 1, priceOut: 1 }
fs.writeFileSync(path.join(SB, 'agents.json'), JSON.stringify({ agents: { cheap: agent, writer: agent, pro: agent, gpt: agent }, assign: {} }))
process.env.WORKSHOP_SANDBOX = SB
const IM = await import('./lib/importer.mjs')
const S = await import('./lib/store.mjs')
const PL = await import('./lib/pipeline.mjs')

let pass = 0, fail = 0
const t = async (name, fn) => { try { await fn(); pass++; console.log('✓', name) } catch (e) { fail++; console.log('✗', name, '—', e.message) } }
const ns = (x) => x.replace(/\s/g, '').length

const sample = '\uFEFF作品简介：一个人的小城。\r\n\r\n第一章 钥匙\r\n  林川推开门。\r\n他看见桌上有把钥匙。\r\n\r\n\r\n第2章：老周\r\n老周没回来。\r\n第十二章 门\r\n门开了。\r\n'

await t('中文数字解析', () => { assert.equal(IM.parseNum('十二'), 12); assert.equal(IM.parseNum('一百零三'), 103); assert.equal(IM.parseNum('两千'), 2000); assert.equal(IM.parseNum('１２'), 12); assert.equal(IM.parseNum('abc'), null) })
await t('按「第X章」拆章、重排章号、跳号写进提示、正文段间一个空行', () => {
  const r = IM.splitChapters(sample)
  assert.equal(r.chapters.length, 3)
  assert.deepEqual(r.chapters.map((c) => [c.n, c.title, c.srcNo]), [[1, '钥匙', 1], [2, '老周', 2], [3, '门', 12]])
  assert.equal(r.chapters[0].body, '林川推开门。\n\n他看见桌上有把钥匙。')
  assert.equal(r.preface, '作品简介：一个人的小城。')
  assert.ok(r.warnings.some((w) => /不连续/.test(w) && /2→12/.test(w)))
})
await t('Markdown 标题、空章跳过', () => {
  const r = IM.splitChapters('## 第1章 开始\n正文一\n## 第2章 空\n\n## 第3章 结束\n正文三')
  assert.deepEqual(r.chapters.map((c) => [c.n, c.title]), [[1, '开始'], [2, '结束']])
  assert.ok(r.warnings.some((w) => /没有正文/.test(w)))
})
await t('正文里出现「第三章」字样（长句）不被当成章标题', () => {
  const r = IM.splitChapters('第1章 a\n' + '他说第三章的时候我就知道了，' + '这是一句很长很长的正文用来超过六十个字符的限制所以不会被当成标题对吧对吧对吧对吧对吧对吧。')
  assert.equal(r.chapters.length, 1)
})
await t('没有章标题：短文 1 章、长文约 3000 字一章', () => {
  assert.equal(IM.splitChapters('就一段。').chapters.length, 1)
  const long = Array.from({ length: 100 }, (_, i) => `第${i}段`.padEnd(100, '字')).join('\n')
  const r = IM.splitChapters(long)
  assert.ok(r.chapters.length >= 3 && r.chapters.length <= 4, String(r.chapters.length))
  assert.equal(r.chapters.reduce((a, c) => a + ns(c.body), 0), ns(long))
})
let id
await t('落库：字数逐章不丢、风格写进书、占位章纲让续写从第 4 章开始', () => {
  const r = IM.importBook({ title: '导入测试', text: sample, style: { id: 'custom', custom: '八零年代东北' } })
  id = r.book.id
  assert.equal(r.chapters, 3)
  const b = S.readBook(id)
  assert.equal(b.genre, 'custom'); assert.equal(b.styleCustom, '八零年代东北'); assert.ok(b.imported)
  assert.equal(S.readText(id, 'chapters', '0003.txt'), '第3章 门\n\n门开了。\n')
  assert.equal(PL.outlineRows(id).length, 3)
  assert.ok(!S.readText(id, 'bible.md'), '导入时不该调模型生成设定')
  assert.equal(modelCalls.length, 0)
})
await t('空文件 / 没书名 报人话错误', () => {
  assert.throws(() => IM.importBook({ title: 'x', text: '   ' }), /没读到正文/)
  assert.throws(() => IM.importBook({ title: '', text: 'a' }), /书名/)
})
await t('第一次续写前：从原稿整理设定 + 最近章摘要 + 悬念，只做一次', async () => {
  await PL.ensureImportedFoundation(id)
  assert.ok(/作者导入的原稿/.test(S.readText(id, 'bible.md')))
  const b = S.readBook(id)
  assert.equal(b.chapters.find((c) => c.n === 3).summary, '老周失踪')
  assert.ok(/钥匙开哪扇门/.test(b.chapters.find((c) => c.n === 3).hooks))
  assert.equal(modelCalls.length, 1)
  assert.ok(modelCalls[0].includes('门开了'), '摘录里要有最后一章原文')
  await PL.ensureImportedFoundation(id)
  assert.equal(modelCalls.length, 1, '第二次不该再花钱')
})

// ── 服务器：大请求中文不乱码（readBody 旧写法逐块转字符串会把切开的汉字变成 �） ──
const PORT = 4596
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env: { ...process.env, WORKSHOP_PORT: String(PORT), WORKSHOP_SANDBOX: SB }, stdio: 'ignore' })
try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/status`); break } catch { await new Promise((r) => setTimeout(r, 250)) } }
  const big = Array.from({ length: 60 }, (_, i) => `第${i + 1}章 第${i + 1}个标题\n` + '林川看着窗外的雨，想起了老周说过的话。'.repeat(150)).join('\n')
  await t(`接口导入 ${Math.round(Buffer.byteLength(big) / 1024)}KB 中文：章数对、全文无乱码`, async () => {
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '大书', text: big }) })).json()
    assert.equal(r.chapters, 60, JSON.stringify(r).slice(0, 200))
    const all = Array.from({ length: 60 }, (_, i) => S.readText(r.id, 'chapters', S.pad(i + 1) + '.txt')).join('')
    assert.ok(!all.includes('\uFFFD'), '出现乱码字符')
    assert.equal(r.chars, ns(big) - Array.from({ length: 60 }, (_, i) => ns(`第${i + 1}章 第${i + 1}个标题`)).reduce((a, b) => a + b, 0))
  })
  // ── 页面：选文件 → 导入 → 自动打开书页（GBK 文件也能读） ──
  const { chromium } = createRequire(new URL('../package.json', import.meta.url))('playwright')
  const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
  const browser = await chromium.launch({ executablePath: EDGE, headless: true })
  try {
    const page = await (await browser.newContext()).newPage()
    const errs = []; page.on('pageerror', (e) => errs.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(1200)
    await t('页面上传 UTF-8 文件：书名自动带出、导入后打开书页', async () => {
      const f = path.join(SB, '我的旧稿.txt'); fs.writeFileSync(f, sample, 'utf8')
      await page.setInputFiles('#impFile', f)
      assert.equal(await page.inputValue('#impTitle'), '我的旧稿')
      await page.click('#btnImport'); await page.waitForTimeout(1500)
      assert.ok(/导入《我的旧稿》：3 章/.test(await page.textContent('#impMsg')), await page.textContent('#impMsg'))
      assert.ok(await page.isVisible('#bookPage'))
    })
    await t('页面上传 GBK 文件也不乱码', async () => {
      await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(1000)
      const f = path.join(SB, 'gbk.txt')
      // 「第1章 钥匙\n林川推开门。」的 GBK 字节
      fs.writeFileSync(f, Buffer.from('b5da31d5c220d4bfb3d70ac1d6b4a8cdc6bfaac3c5a1a30a', 'hex'))
      await page.fill('#impTitle', 'GBK书'); await page.setInputFiles('#impFile', f)
      await page.click('#btnImport'); await page.waitForTimeout(1500)
      const b = S.listBooks().find((x) => x.title === 'GBK书')
      assert.ok(b, await page.textContent('#impMsg'))
      assert.equal(S.readText(b.id, 'chapters', '0001.txt'), '第1章 钥匙\n\n林川推开门。\n')
    })
    await t('页面无脚本错误', () => assert.equal(errs.length, 0, errs.join(' | ')))
  } finally { await browser.close() }
} finally { srv.kill(); fake.close(); await new Promise((r) => setTimeout(r, 400)); fs.rmSync(SB, { recursive: true, force: true }) }
console.log(fail ? `\n${fail} 项失败 / ${pass} 通过` : `\n带稿导入全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)

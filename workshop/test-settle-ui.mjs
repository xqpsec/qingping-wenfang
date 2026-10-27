// test-settle-ui.mjs —— 零成本：改写对比「差不多」时，给出「保留原稿，写下一章」出路，手指指向它（2026-10-02）
// 起因：内测 friend-01 第 1 章改了 6 次（58→74），每次评审都说差不多，没有出路就一直改。
// 用法：node workshop/test-settle-ui.mjs   （自己起临时沙箱 + 工坊实例，不花钱：/api/write 被拦截，不会真写）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const { chromium } = createRequire(new URL('../package.json', import.meta.url))('playwright')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-settle-'))
const PORT = 4597
process.env.WORKSHOP_SANDBOX = SB
const S = await import('./lib/store.mjs')
const para = (s) => Array.from({ length: 30 }, (_, i) => `${s}第${i}段，林川抬眼看着对面那人。`).join('\n\n')
const b = S.createBook('差不多测试书')
const orig = `第1章 原章名\n\n${para('原稿')}\n`
S.commitChapter(b.id, 1, orig, { title: '原章名', chars: 900, score: 72, readNext: 50 })
const rev = (level, winner, at = 72, bt = 74) => ({
  text: `第1章 改后\n\n${para('改后')}\n`, title: '改后', chars: 900, instruction: '加快节奏', baseHash: S.bodyHash(orig),
  diff: { after: 30, kept: 0, added: 30, removed: 30, changes: [] },
  compare: { at: new Date().toISOString(), noise: 8, verdict: winner === -1 ? '差不多（两次换序结论不一致）' : winner === 1 ? '改后更好' : '改前更好',
    before: { total: at, readNext: 50, scores: {} }, after: { total: bt, readNext: 52, scores: {} },
    pair: { winner, reasons: [] }, advice: { level, text: level } },
})
const setRev = (r) => S.writeText(b.id, 'work/0001/revision.json', JSON.stringify(r))

let fail = 0
const ok = (c, name, info = '') => { console.log(`${c ? '✓' : '✗'} ${name}${info ? '  ' + info : ''}`); if (!c) fail++ }
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env: { ...process.env, WORKSHOP_PORT: String(PORT), WORKSHOP_SANDBOX: SB }, stdio: 'ignore' })
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
const browser = await chromium.launch({ executablePath: EDGE, headless: true })
try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/status`); break } catch { await new Promise((r) => setTimeout(r, 250)) } }
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  const errs = []; page.on('pageerror', (e) => errs.push(e.message))
  const calls = []
  await page.route('**/api/write', (r) => { calls.push('write'); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }) })
  page.on('dialog', (d) => d.accept())
  const openCh = async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(1200)
    await page.evaluate((id) => openBook(id), b.id); await page.waitForTimeout(600)
    await page.evaluate(() => openChapter(1)); await page.waitForTimeout(1200)
  }

  setRev(rev('same', -1))
  await openCh()
  ok(await page.isVisible('#settleBox'), '差不多 → 出现「这一章可以定了」框')
  ok(await page.isVisible('#btnSettleKeep'), '差不多 → 有「保留原稿，写下一章」大按钮')
  const target = await page.evaluate(() => document.querySelector('.coach-target')?.id)
  ok(target === 'btnSettleKeep', '手指指向「保留原稿，写下一章」', String(target))
  await page.click('#btnSettleKeep'); await page.waitForTimeout(1500)
  ok(!S.readJson(b.id, 'work/0001/revision.json'), '点了以后改写稿被放弃（归档）')
  ok(S.readText(b.id, 'chapters', '0001.txt') === orig, '定稿仍是原稿')
  ok(calls.includes('write'), '随后自动发起「写下一章」')
  ok(/定稿了/.test(await page.textContent('#chWhich')), '页面告诉用户已定稿、正在写下一章')

  setRev(rev('better', 1, 60, 75)); calls.length = 0
  await openCh()
  ok(await page.isVisible('#btnSettleAdopt') && !(await page.isVisible('#btnSettleKeep')), '改后更好 → 只给「采用改写稿，写下一章」')
  await page.click('#btnSettleAdopt'); await page.waitForTimeout(1500)
  ok(/改后/.test(S.readText(b.id, 'chapters', '0001.txt')), '点了以后改写稿成为定稿')
  ok(calls.includes('write'), '采用后自动写下一章')

  setRev(rev('worse', 0, 74, 60))
  await openCh()
  ok(!(await page.isVisible('#settleBox')), '改后更差 → 不出现定稿框（保持原有放弃流程）')
  ok(!errs.length, '页面无脚本错误', errs.join(' | '))
} catch (e) { console.error('✗ 异常：', e.message); fail++ } finally {
  await browser.close(); srv.kill(); fs.rmSync(SB, { recursive: true, force: true })
}
console.log(fail ? `\n${fail} 项失败` : '\n「差不多就定稿」全部通过')
process.exit(fail ? 1 : 0)

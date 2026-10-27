// test-coach-ui.mjs —— 零成本：验证「简单模式 + 手指引导」（2026-10-02）
// 用法：先启动工坊，再 node workshop/test-coach-ui.mjs [端口] [--shots 目录]
// 只点切换面板/打开类按钮，不点任何会花钱的按钮。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
// playwright 是可选依赖：装在别的目录时用 PLAYWRIGHT_DIR 指定，按绝对路径解析
const PW_BASE = (process.env.PLAYWRIGHT_DIR || process.cwd()).replace(/[\\/]+$/, '') + '/package.json'
const { chromium } = createRequire(PW_BASE)('playwright')

const PORT = Number(process.argv[2] || 4580)
const si = process.argv.indexOf('--shots')
const SHOTS = si > 0 ? process.argv[si + 1] : ''
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
let fail = 0
const ok = (cond, name, info = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${info ? '  ' + info : ''}`); if (!cond) fail++ }
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }) }

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
try {
  for (const vp of [{ w: 1280, h: 860, tag: 'pc' }, { w: 390, h: 844, tag: 'phone' }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } })
    const page = await ctx.newPage()
    const errs = []; page.on('pageerror', (e) => errs.push(e.message))
    await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(2000)
    ok(await page.evaluate(() => document.body.classList.contains('simple')), `[${vp.tag}] 默认是简单模式`)
    ok(await page.isHidden('#newbieGuide'), `[${vp.tag}] 简单模式隐藏旧版文字指导`)
    ok(await page.isHidden('#btnAgents'), `[${vp.tag}] 简单模式隐藏模型配置入口`)
    await page.waitForTimeout(800)
    const f = await page.evaluate(() => { const fe = document.getElementById('coachFinger'); const t = document.querySelector('.coach-target'); return { show: fe && fe.style.display !== 'none', target: t?.id || t?.textContent?.trim().slice(0, 12), text: document.getElementById('coachBubble')?.textContent || '' } })
    ok(f.show && !!f.target, `[${vp.tag}] 首页出现手指并指向按钮`, JSON.stringify(f))
    await shot(page, `${vp.tag}-1-home`)
    // 打开第一本书
    const open = page.locator('#books button').first()
    if (await open.count()) {
      await open.click(); await page.waitForTimeout(1500)
      ok(await page.isHidden('#agentCard'), `[${vp.tag}] 写正文页隐藏智能代理卡`)
      ok(await page.isHidden('#candSel'), `[${vp.tag}] 写正文页隐藏版本数/润色器设置`)
      ok(await page.isVisible('#btnWrite1'), `[${vp.tag}] 「写下一章」可见`)
      await page.waitForTimeout(800)
      const g = await page.evaluate(() => ({ target: document.querySelector('.coach-target')?.textContent?.trim().slice(0, 16), text: document.getElementById('coachBubble')?.textContent || '' }))
      ok(!!g.target, `[${vp.tag}] 书页手指指向下一步`, JSON.stringify(g))
      await shot(page, `${vp.tag}-2-book`)
      await page.click('#steps button[data-p="pBible"]'); await page.waitForTimeout(400)
      ok(await page.isHidden('#characterCards'), `[${vp.tag}] 简单模式隐藏人物卡表单`)
      // 切专业模式：全部回来
      await page.click('#btnMode'); await page.waitForTimeout(300)
      ok(await page.isVisible('#characterCards'), `[${vp.tag}] 专业模式显示人物卡`)
      ok(await page.isVisible('#btnAgents') || await page.evaluate(() => !!window.__recMode), `[${vp.tag}] 专业模式显示模型配置入口`)
      await page.click('#btnMode'); await page.waitForTimeout(200)
      // 关闭引导
      await page.click('#steps button[data-p="pWrite"]'); await page.waitForTimeout(900)
      await page.click('#coachBubble a'); await page.waitForTimeout(700)
      ok(await page.evaluate(() => document.getElementById('coachFinger').style.display === 'none' && !document.querySelector('.coach-target')), `[${vp.tag}] 「不用引导了」能关掉手指`)
      await page.click('#btnCoach'); await page.waitForTimeout(900)
      ok(await page.evaluate(() => document.getElementById('coachFinger').style.display !== 'none'), `[${vp.tag}] 「新手引导」按钮能重新打开`)
    }
    ok(!errs.length, `[${vp.tag}] 页面无脚本错误`, errs.join(' | '))
    await ctx.close()
  }
} catch (e) { console.error('✗ 异常：', e.message); fail++ } finally { await browser.close() }
console.log(fail ? `\n${fail} 项失败` : '\n简单模式与手指引导全部通过')
process.exit(fail ? 1 : 0)

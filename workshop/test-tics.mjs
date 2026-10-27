// test-tics.mjs —— 去 AI 腔检测与接入的零成本测试
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { scanTics, deticBlock, deticPrompt } from './lib/tics.mjs'
import * as PR from './lib/prompts.mjs'

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('✓', name) }

const ai = '第1章 测试\n\n他盯着那行字，看了两秒。\n\n林铮没说话。\n\n所以这一下不是摔，是摔在刀口上。\n\n他顿了顿，声音很轻。\n\n嘴角勾起一抹笑——像刀。\n\n“你看了两秒吧？”他问。\n\n【提示：三秒后启动。】'
t('检测：叙述里的口癖都被数到', () => {
  const r = scanTics(ai)
  for (const k of ['seconds', 'silent', 'notis', 'pause', 'soft', 'cliche', 'dash']) assert.ok(r.counts[k] > 0, k)
})
t('检测：台词和系统弹窗里的「两秒/三秒」不算', () => {
  const r = scanTics('第1章 x\n\n“你看了两秒吧？”他问。\n\n【提示：三秒后启动。】\n\n他走了。')
  assert.equal(r.counts.seconds || 0, 0)
})
t('检测：每章保留额度内的不标出（破折号允许 1 个）', () => {
  const r = scanTics('第1章 x\n\n他推开门——屋里没人。\n\n他坐下来开始吃面。')
  assert.equal(r.flagged.length, 0)
})
t('检测：零感叹号零语气词判为情绪平', () => {
  assert.equal(scanTics('第1章 x\n\n' + '他走进办公室，把文件放下，坐到窗边。\n\n'.repeat(40)).flat, true)
  assert.equal(scanTics('第1章 x\n\n' + '“卧槽，真的假的啊！”老周喊。\n\n'.repeat(40)).flat, false)
})
t('提示词：deticText 为空时 writerPrompt 与旧版逐字相同；有值时带上去 AI 腔段落', () => {
  const base = { bible: 'b', characterCard: null, plan: 'p', recap: '', prevTail: '', chapterNo: 1, outlineRow: '1|x', anchors: [] }
  assert.equal(PR.writerPrompt({ ...base, deticText: '' }), PR.writerPrompt(base))
  assert.ok(PR.writerPrompt({ ...base, deticText: deticBlock() }).includes('【去 AI 腔'))
})
t('改写 prompt：逐句列出原句并要求「原句=>改为」格式', () => {
  const r = scanTics(ai)
  const p = deticPrompt(ai, r.flagged)
  assert.ok(p.includes('原句：<从上面逐字复制的原句> => 改为：'))
  assert.ok(r.flagged.every((f) => p.includes(f.s)))
})
t('管线：写章接入去 AI 腔（2026-10-07 起默认开，detic:false 关），并保留 detic.json 产物', () => {
  const src = fs.readFileSync(new URL('./lib/pipeline.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('cfg.detic !== false'))
  assert.ok(src.includes('/detic.json'))
  assert.ok(/dt\.used = after\.total < before\.total && shrink < 0\.03/.test(src), '只在口癖变少且没删短时采用')
})
console.log(`\n${pass} 项全部通过`)

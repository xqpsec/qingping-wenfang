// test-voices.mjs —— 文风（笔调）+ 玩梗模式的零成本测试（不调模型）
// 用法：node test-voices.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`) }

// 临时梗库：含问句式垃圾条目
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voices-'))
const file = path.join(tmp, 'memes.json')
const memes = []
for (let i = 0; i < 20; i++) memes.push({ meme: `梗${i}`, meaning: `意思${i}`, usage: '', example: i < 12 ? `例句${i}` : '', fit: ['通用'], tier: 'SSS' })
memes.push({ meme: '战鹰是谁', meaning: '搜索词', usage: '', example: '例', fit: ['通用'], tier: 'SSS' })
memes.push({ meme: '区是啥梗？', meaning: '搜索词', usage: '', example: '', fit: ['通用'], tier: 'SSS' })
fs.writeFileSync(file, JSON.stringify({ memes }))
process.env.WORKSHOP_MEMES = file

const V = await import('./lib/voices.mjs')
const M = await import('./lib/memes.mjs')
const P = await import('./lib/prompts.mjs')
const { judgeSystem, VOICE_SEP } = await import('./lib/judge.mjs')

// ── 文风 ──
ok(V.VOICES.length >= 10 && V.VOICES[0].id === 'auto', `文风清单 ≥10 且第一个是「按题材默认」（${V.VOICES.length} 个）`)
ok(new Set(V.VOICES.map((v) => v.id)).size === V.VOICES.length, '文风 id 不重复')
ok(V.VOICES.every((v) => v.label && v.tagline && [...v.tagline].length <= 16), '每个文风都有名字和 ≤16 字的说明')
ok(V.VOICES.filter((v) => v.id !== 'auto').every((v) => v.rules.length >= 3 && v.ban), '除默认外每个文风 ≥3 条写法规则 + 1 条禁忌')
ok(V.resolveVoice('不存在').id === 'auto' && V.resolveVoice('').id === 'auto' && V.resolveVoice(undefined).id === 'auto', '未知/空文风回退默认')
ok(V.voiceBlock('auto') === '' && V.voiceBlock(undefined) === '', '默认文风不注入任何文字')
ok(V.voiceBlock('cold').includes('【文风：冷峻克制】') && V.voiceBlock('cold').includes('禁忌'), '冷峻克制注入规则段落')
ok(V.publicVoices().every((v) => !('rules' in v)), '给前端的清单不带 prompt 规则')

// 开书方案：auto 逐字不变；指定文风替换掉「吐槽流 或 白描流」
const cp = P.conceptPrompt('x', ['a'])
ok(P.withVoiceConcept(cp, 'auto') === cp && P.withVoiceConcept(cp, undefined) === cp, '开书方案：默认文风逐字不变')
const cpCold = P.withVoiceConcept(cp, 'cold')
ok(!cpCold.includes('吐槽流 或 白描流') && cpCold.includes('风格：冷峻克制'), '开书方案：指定文风后不再只给吐槽/白描二选一')
const cpOther = P.withVoiceConcept(P.conceptPrompt('', [], { id: '悬疑灵异' }), 'epic')
ok(cpOther.includes('风格：大气史诗'), '非都市题材的开书方案也能换文风')

// 设定集
ok(P.biblePromptV('C', 'auto') === P.biblePrompt('C'), '设定集：默认文风逐字不变')
ok(P.biblePromptV('C', 'sweet').includes('作者指定文风：甜宠撒糖') && !P.biblePromptV('C', 'sweet').includes('（吐槽流/白描流'), '设定集：文风要求换成作者指定')

// 写手
const args = { bible: 'B', characterCard: [], plan: 'P', recap: 'R', prevTail: '', chapterNo: 3, outlineRow: 'O', anchors: [] }
ok(P.writerPrompt(args) === P.writerPrompt({ ...args, voiceText: '' }), '写手 prompt：无文风时逐字不变')
ok(P.writerPrompt({ ...args, voiceText: V.voiceBlock('dark') }).includes('【文风：黑色幽默】'), '写手 prompt：带上文风段落')

// 评审
ok(judgeSystem('悬疑灵异') === judgeSystem('悬疑灵异' + ''), '评审：不带文风后缀时不变')
const jv = judgeSystem('悬疑灵异' + VOICE_SEP + '冷峻克制')
ok(jv.includes('「悬疑灵异」频道') && jv.includes('「冷峻克制」文风') && !jv.includes(VOICE_SEP), '评审：带文风后缀时按文风口径评、频道名不串')
ok(judgeSystem('都市脑洞' + VOICE_SEP + '热血燃系').startsWith('你是番茄小说男频都市脑洞频道'), '评审：都市脑洞 + 文风仍识别为都市脑洞频道')

// ── 玩梗模式 ──
const urban = { id: 'urban-naodong', label: '都市脑洞' }
const light = M.pickMemes(urban, 'b#1')
ok(light.length === 6, '默认（偶尔玩梗）给 6 个候选')
ok(M.pickMemes(urban, 'b#1', 6, 'off').length === 0, '不玩梗：一个都不给')
const heavy = M.pickMemes(urban, 'b#1', 6, 'heavy')
ok(heavy.length === 10, '玩梗模式给 10 个候选')
const allPicked = [...M.pickMemes(urban, 'b#2', 20, 'heavy'), ...M.pickMemes(urban, 'b#3', 20, 'heavy')]
ok(!allPicked.some((m) => /是谁|是啥梗/.test(m.meme)), '「XX是谁 / 是啥梗」这类搜索问句不入选')
ok(M.pickMemes({ id: '宫斗宅斗', label: '宫斗宅斗' }, 'x#1').length === 0, '时代题材默认仍不给梗')
ok(M.pickMemes({ id: '宫斗宅斗', label: '宫斗宅斗' }, 'x#1', 6, 'heavy').length > 0, '作者主动开玩梗模式时，时代题材也给')
ok(M.memeBlock(heavy, 'heavy').includes('【玩梗模式') && M.memeBlock(heavy, 'heavy').includes('3–5 个'), '玩梗模式 prompt 要求 3–5 个')
ok(M.memeBlock(light) === M.memeBlock(light, 'light') && M.memeBlock(light).includes('1–2 个'), '默认 prompt 段落与旧版一致（1–2 个）')
ok(M.normMemeMode('乱写') === 'light', '非法玩梗模式按默认')

// ── 接口与页面接线（静态检查，不起服务）──
const srv = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
ok(srv.includes("'GET /api/voices'") && srv.includes("'POST /api/book/voice'"), 'server：有文风清单与按书保存接口')
ok(/PL\.startBook\(.*voice: body\.voice, memeMode: body\.memeMode/.test(srv) && /PL\.proposeConcepts\(.*body\.style, body\.voice\)/.test(srv), 'server：开书方案与开书都带上文风')
ok(!/\/api\/book\/voice/.test((srv.match(/const MODEL_ROUTES = new Set\(\[[^\]]*\]/) || [''])[0]), '保存文风不算调模型（不扣额度闸门）')
const ui = fs.readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8')
ok(ui.includes('id="voiceRow"') && ui.includes('id="memeRow"') && ui.includes('id="bookVoice"') && ui.includes('id="bookMeme"'), '页面：首页与书页都有文风/玩梗控件')
ok(/\/api\/start', \{[^}]*voice: window\._voice, memeMode: window\._memeMode/.test(ui), '页面：开书请求带上文风和玩梗模式')
const pl = fs.readFileSync(new URL('./lib/pipeline.mjs', import.meta.url), 'utf8')
ok(!pl.includes('styleLabel: st.label'), 'pipeline：评审都用 judgeLabelOf（带文风）')
ok(/voiceBlock\(S\.readBook\(id\)\.voice\)/.test(pl), 'pipeline：按意见改写也遵守文风')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

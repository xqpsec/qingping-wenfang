// test-memes.mjs —— 网络梗知识库接入的零成本测试（不调模型）
// 用法：node test-memes.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`) }

// 用临时小库，不依赖真实 memes.json 的内容
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memes-'))
const file = path.join(tmp, 'memes.json')
const memes = [
  { meme: '那咋了', meaning: '理直气壮地反问', usage: '被指出问题时', example: '“你迟到了。”“那咋了？”', fit: ['通用'], tier: '' },
  { meme: '班味', meaning: '上班带来的疲惫气质', usage: '吐槽打工人', example: '他一进门，班味就扑面而来。', fit: ['都市'], tier: '' },
  { meme: '修仙梗', meaning: '只适合玄幻', usage: '', example: '道友请留步。', fit: ['玄幻'], tier: '' },
  { meme: '绷不住了', meaning: '忍不住笑或崩溃', usage: '', example: '', fit: ['通用'], tier: 'SSS' },
  { meme: '低热', meaning: '热度低', usage: '', example: '', fit: ['通用'], tier: 'C' },
]
fs.writeFileSync(file, JSON.stringify({ memes }))
process.env.WORKSHOP_MEMES = file
const M = await import('./lib/memes.mjs')
const P = await import('./lib/prompts.mjs')

ok(M.loadMemes().length === 5, '能加载梗库')
const urban = { id: 'urban-naodong', label: '都市脑洞' }
const a = M.pickMemes(urban, 'book#1'), b = M.pickMemes(urban, 'book#1')
ok(a.length > 0 && JSON.stringify(a) === JSON.stringify(b), '同书同章选到同一批（可复现）', a.map((x) => x.meme).join('、'))
ok(!a.some((x) => x.meme === '修仙梗'), '都市风格不给玄幻专属梗')
ok(!a.some((x) => x.meme === '低热'), '无例句的低热度梗不入选')
ok(M.pickMemes({ id: '玄幻脑洞', label: '玄幻脑洞' }, 'x#1', 10).some((x) => x.meme === '修仙梗'), '玄幻风格能拿到玄幻梗')
ok(M.pickMemes({ id: '宫斗宅斗', label: '宫斗宅斗' }, 'x#1').length === 0, '宫斗宅斗（时代题材）默认不给现代梗')
ok(M.pickMemes({ id: '古言脑洞', label: '古言脑洞' }, 'x#1').length > 0, '古言脑洞（脑洞类）仍给梗')
ok(M.pickMemes({ id: 'custom', label: '自定义：当代打工人', custom: '当代打工人在大厂摸鱼，嘴碎同事一堆' }, 'x#1').length > 0, '自定义风格默认给梗（作者没写时代题材关键词）')
ok(M.pickMemes({ id: 'custom', label: '自定义：八零年代东北小镇', custom: '八零年代东北小镇，糙汉与知青的慢热日常' }, 'x#1').length === 0, '自定义写了「年代」→ 不给现代梗（防穿越）')
ok(M.pickMemes({ id: 'custom', label: '自定义', custom: '民国年间的谍战' }, 'x#1').length === 0, '自定义写了民国等时代词 → 不给')
const blk = M.memeBlock(a)
ok(blk.includes('1–2 个') && blk.includes('用不上就一个都别用') && blk.includes(a[0].meme), 'prompt 段落含限量规则和梗名')
ok(M.memeBlock([]) === '', '没梗时 prompt 段落为空')

// 回归：memeText 为空时 writerPrompt 与不传参数逐字相同
const args = { bible: 'B', characterCard: [], plan: 'P', recap: 'R', prevTail: '', chapterNo: 3, outlineRow: 'O', anchors: [] }
ok(P.writerPrompt(args) === P.writerPrompt({ ...args, memeText: '' }), '无梗时写手 prompt 与旧版逐字相同')
ok(P.writerPrompt({ ...args, memeText: blk }).includes('【本章可用的网络梗（可选）】'), '有梗时 prompt 带上梗段落')

// 坏文件不能让写章崩
fs.writeFileSync(file, '{坏json')
await new Promise((r) => setTimeout(r, 20)); fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
ok(Array.isArray(M.pickMemes(urban, 'z#1')) && M.pickMemes(urban, 'z#1').length === 0, '梗库损坏时返回空、不抛错')

// 真实库存在时做一次体检（不存在就跳过，不算失败）
const real = path.resolve('..', 'projects', 'memes', 'memes.json')
if (fs.existsSync(real)) {
  const j = JSON.parse(fs.readFileSync(real, 'utf8'))
  ok(j.memes.length >= 500 && j.memes.every((m) => m.meme && m.meaning), `真实梗库结构完整（${j.memes.length} 条）`)
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

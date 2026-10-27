// test-cover-aitext.mjs —— 封面「生图模型自己写字」模式的验收。
// 免费部分（默认）：设置默认值与开关、提示词含书名/笔名、overlay 旧封面仍可免费重新压字、AI 封面拒绝走免费压字。
// 真实出图部分（会花 2 张图约 ¥2.9）：node test-cover-aitext.mjs --live ；出图后请人工看 PNG 书名是否一字不差。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cover-'))
process.env.WORKSHOP_SANDBOX = SB
const S = await import('./lib/store.mjs')
const CV = await import('./lib/cover.mjs')
const PL = await import('./lib/pipeline.mjs')
const live = process.argv.includes('--live')
let n = 0; const ok = (m) => console.log('✓', m, ++n)
try {
  // 1. 默认就是 AI 写字；设成 overlay 才回到本机压字
  assert.equal(CV.textMode({}), 'ai'); assert.equal(CV.textMode({ coverTextMode: 'overlay' }), 'overlay'); assert.equal(CV.textMode({ coverTextMode: 'x' }), 'ai'); ok('默认 AI 写字，overlay 可切回')
  // 2. 造一本带 overlay 封面的书（用一张纯色 PNG 当原图）
  const b = S.createBook('送外卖后，我成了荒天帝'); const id = b.id
  const dir = S.bookPath(id, 'covers'); fs.mkdirSync(dir, { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAIAAABvrngfAAAAFklEQVR4nGP8z8Dwn4EIwESMolGF+BUCAFqZAgsVbQ8pAAAAAElFTkSuQmCC', 'base64')
  fs.writeFileSync(path.join(dir, 'raw-old.png'), png)
  const bk = S.readBook(id); bk.package = { coverPrompt: { en: 'a delivery rider glowing with golden light, night city' }, cover: { file: 'x.png', raw: 'raw-old.png', textMode: 'overlay' } }; S.saveBook(bk)
  fs.mkdirSync(path.dirname(PL.settingsFile()), { recursive: true }); fs.writeFileSync(PL.settingsFile(), JSON.stringify({ penName: '清风', coverWidth: 600, coverHeight: 800 }), 'utf8')
  const f = CV.recomposeCover(id); assert.ok(fs.existsSync(f)); ok('overlay 封面仍可免费重新压字')
  const b2 = S.readBook(id); b2.package.cover.textMode = 'ai'; S.saveBook(b2)
  assert.throws(() => CV.recomposeCover(id), /改字/); ok('AI 写字封面不走免费压字（会提示用「改字」）')
  if (live) {
    const b3 = S.readBook(id); delete b3.package.cover; S.saveBook(b3)
    const r = await CV.generateCover(id, { onStep: (s) => console.log('  ·', s) })
    const c = S.readBook(id).package.cover; assert.equal(c.textMode, 'ai'); assert.equal(c.size, '600x800'); assert.ok(fs.existsSync(r.file)); ok('AI 写字出图：' + r.file)
    const bb = S.readBook(id); bb.title = '我在都市送外卖成神'; S.saveBook(bb)
    fs.writeFileSync(PL.settingsFile(), JSON.stringify({ penName: '云舟', coverWidth: 600, coverHeight: 800 }), 'utf8')
    const r2 = await CV.retextCover(id, { onStep: (s) => console.log('  ·', s) })
    assert.ok(fs.existsSync(r2.file)); assert.equal(S.readBook(id).package.cover.coverTitle, '我在都市送外卖成神'); ok('改字：' + r2.file)
    fs.mkdirSync(process.env.TEMP + '\\covprobe', { recursive: true }); fs.copyFileSync(r.file, process.env.TEMP + '\\covprobe\\live-gen.png'); fs.copyFileSync(r2.file, process.env.TEMP + '\\covprobe\\live-retext.png')
  }
  console.log('全部通过', n)
} finally { fs.rmSync(SB, { recursive: true, force: true }) }

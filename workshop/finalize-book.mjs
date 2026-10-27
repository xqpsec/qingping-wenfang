// finalize-book.mjs —— 收尾补全：书写完后，如果书名/简介/标签/封面还没备齐，用真实模型补上，保证桌面交付物可以直接拿去填番茄。
// 不写新章、不改已有正文。用法：WORKSHOP_SANDBOX=<沙箱目录> node finalize-book.mjs <书id> [--redo-package] [--redo-cover] [--extra=<给封面/包装的要求>]
// 默认只补缺：已经备齐的部分一概不动（简介、标签、封面提示词、封面各自独立判断）。
// --redo-package / --redo-cover：主办方在「打磨已有的书」里明确要求重做时才用（书名仍不改，除非超过 15 字）。
import fs from 'node:fs'
import * as S from './lib/store.mjs'
import * as PK from './lib/packaging.mjs'
import * as CV from './lib/cover.mjs'

const id = process.argv[2]
const REDO_PKG = process.argv.includes('--redo-package')
const REDO_COVER = process.argv.includes('--redo-cover')
const EXTRA = (process.argv.find((a) => a.startsWith('--extra=')) || '').slice(8).slice(0, 600)
if (!id || !fs.existsSync(S.bookPath(id, 'book.json'))) { console.error('找不到书：' + id); process.exit(2) }
const say = (m) => console.log('[收尾] ' + m)
let b = S.readBook(id)
if (!(b.chapters || []).length) { say('还没有章节，不做包装'); process.exit(0) }

const hasPrompt = () => { const c = S.readBook(id).package?.coverPrompt || {}; return !!(c.en || c.zh) }
const pk = () => S.readBook(id).package || {}
let changed = false, failed = 0

if (REDO_PKG || !pk().intro || !(pk().tags || []).length || !hasPrompt()) {
  say(REDO_PKG ? '按要求重做简介/标签/封面提示词' : '简介/标签/封面提示词不全，生成包装方案')
  // 模型偶尔吐出坏 JSON：重试一次，仍失败就跳过包装、继续尝试封面，不让一处失败拖垮整个收尾
  let r = null
  for (let tr = 1; tr <= 2 && !r; tr++) {
    try { r = await PK.generatePackage(id, EXTRA, { onStep: (s) => say(s) }) } catch (e) { say(`包装方案第 ${tr} 次失败：${String(e.message || e).slice(0, 160)}`) }
  }
  if (r) {
    const rec = r.titles[r.recommend] || r.titles[0]
    // 收尾不改书名（书名是主办方或作者定的）；只有超过 15 字、放不进番茄表单时才换成推荐书名
    const keepTitle = PK.titleLen(b.title) <= PK.TITLE_MAX
    PK.applyPackage(id, {
      ...(keepTitle ? {} : { title: rec.title }),
      intro: REDO_PKG ? r.intro : pk().intro || r.intro,
      tags: !REDO_PKG && (pk().tags || []).length ? pk().tags : r.tags,
      coverPrompt: !REDO_PKG && hasPrompt() ? undefined : r.coverPrompt,
    })
    changed = true
    say(`包装已${REDO_PKG ? '重做' : '补全'}，书名《${S.readBook(id).title}》`)
  } else failed++
}

if (REDO_COVER || !pk().cover?.file) {
  if (!hasPrompt()) { say('没有封面提示词，跳过封面'); failed++ }
  else {
    say((REDO_COVER ? '按要求重做封面' : '还没有封面，生成封面') + '（通常 1–4 分钟）')
    try { const r = await CV.generateCover(id, { extra: EXTRA, onStep: (s) => say(s) }); say('封面已生成：' + r.file); changed = true } catch (e) { say('封面生成失败：' + String(e.message || e).slice(0, 200)); failed++ }
  }
}
say(failed ? `收尾有 ${failed} 项没完成（看上面）` : changed ? '收尾完成' : '书名、简介、标签、封面都已备齐，无需补全')
process.exit(failed ? 1 : 0)

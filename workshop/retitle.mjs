// retitle.mjs —— 给某本书重新起书名（包装编辑出 5 个候选 + 读者试读打分），可选直接采用最高分
// 用法：WORKSHOP_SANDBOX=<沙箱目录> node workshop/retitle.mjs <书目录id> "<修改意见>" [--apply]
// 只改 book.json 的显示书名与 package 字段，不改目录、不动正文。
import { generatePackage, applyPackage, titleLen } from './lib/packaging.mjs'
import * as S from './lib/store.mjs'

const [id, instruction = ''] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!id) { console.error('用法：node retitle.mjs <书id> "<意见>" [--apply]'); process.exit(2) }
const before = S.readBook(id).title
const r = await generatePackage(id, instruction, { onStep: (s) => console.log('·', s) })
console.log(`\n原书名：${before}`)
console.log('卖点：', r.sellingPoint)
r.titles.forEach((t, i) => console.log(`${i === r.recommend ? '★' : ' '} ${t.title}（${titleLen(t.title)}字）读者分 ${t.score ?? '—'}：${t.readerWhy || ''}｜编辑：${t.why || ''}`))
console.log(`本次花费 ¥${(r.cost || 0).toFixed(4)}`)
if (process.argv.includes('--apply')) {
  const pick = r.titles[r.recommend]
  const b = applyPackage(id, { title: pick.title, intro: r.intro, tags: r.tags })
  const back = S.readBook(id)
  if (back.title !== pick.title) { console.error('写后读回不一致，未采用'); process.exit(1) }
  console.log(`\n已采用：${b.title}`)
}

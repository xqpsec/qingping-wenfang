// cli.mjs —— 命令行入口（界面背后调用的也是同一套函数）
// node workshop/cli.mjs concepts "想法"          出 3 个开书方案，存到 workshop/data/last-concepts.json
// node workshop/cli.mjs start <方案序号1-3>       用上一步的方案开书（设定集 + 章纲）
// node workshop/cli.mjs write <书id> [章数]       续写
// node workshop/cli.mjs revise <书id> <章> [意见]  按意见改写
// node workshop/cli.mjs export <书id>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as PL from './lib/pipeline.mjs'
import * as S from './lib/store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [cmd, a, b, ...rest] = process.argv.slice(2)
const LAST = path.join(HERE, 'data', 'last-concepts.json')

if (cmd === 'concepts') {
  const r = await PL.proposeConcepts(a || '')
  fs.writeFileSync(LAST, JSON.stringify({ idea: a || '', list: r.list }, null, 2), 'utf8')
  r.list.forEach((c, i) => console.log(`\n===== 方案 ${i + 1} =====\n${c}`))
  console.log(`\n花费 ¥${r.cost.toFixed(3)}`)
} else if (cmd === 'start') {
  const { idea, list } = JSON.parse(fs.readFileSync(LAST, 'utf8'))
  const book = await PL.startBook(list[Number(a) - 1], idea)
  console.log(`已开书：${book.id}，花费 ¥${book.cost}`)
} else if (cmd === 'write') {
  const out = await PL.writeNext(a, Number(b || 1))
  for (const c of out) console.log(`第${c.n}章 ${c.title} ${c.chars}字 评分${c.score} 追读${c.readNext}%`)
  console.log(`累计花费 ¥${S.readBook(a).cost}`)
} else if (cmd === 'revise') {
  const c = await PL.reviseChapter(a, Number(b), rest.join(' '))
  console.log(`第${c.n}章已改写，评分 ${c.score}`)
} else if (cmd === 'export') {
  console.log(PL.exportBook(a))
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 7).join('\n'))
}

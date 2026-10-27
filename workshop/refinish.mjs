// refinish.mjs —— 对已写的章节重跑「逻辑自检 → 格式修正 → 报告 → 定稿」，保留原候选稿和择优结果（不再花写手的钱）
// 用法：node workshop/refinish.mjs <书id> <章号,章号>
import fs from 'node:fs'
import * as S from './lib/store.mjs'
import * as PL from './lib/pipeline.mjs'

const [id, list] = process.argv.slice(2)
const nums = String(list || '').split(',').map(Number).filter(Boolean)
for (const n of nums) {
  const W = S.bookPath(id, 'work', S.pad(n))
  for (const f of ['fix.json', 'report.json', 'summary.md']) fs.rmSync(`${W}/${f}`, { force: true })
  // 让 writeChapter 从已存在的 plan/cand/judge 续跑
  const c = await PL.writeChapter(id, n)
  console.log(`第${n}章 ${c.title} ${c.chars}字 评分${c.score} 追读${c.readNext}% 文体${c.machineScore}`)
}

// title-vote.mjs —— 书名盲测：同一组书名打乱顺序让「番茄读者」打分 N 次，取平均与标准差（消除位置偏差）
// 用法：node workshop/title-vote.mjs <次数> "书名1" "书名2" ...
import { chat, parseJson } from './lib/llm.mjs'
import { readerSystem } from './lib/packaging.mjs'

const [nArg, ...titles] = process.argv.slice(2)
const N = Number(nArg) || 3
const scores = Object.fromEntries(titles.map((t) => [t, []]))
let cost = 0
for (let r = 0; r < N; r++) {
  const order = [...titles].sort(() => Math.random() - 0.5)
  const user = `下面是书城列表里刷到的书名，给每个打一个"我会点进去"的意愿分 0–100，并用一句话说原因。\n${order.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n只输出 JSON：{"votes":[{"i":1,"score":0,"why":"..."}]}`
  const res = await chat({ task: 'packageJudge', system: readerSystem('都市脑洞'), user, temperature: 0.7, maxTokens: 3000, json: true, tag: 'title-vote' })
  cost += res.cost
  for (const v of parseJson(res.content).votes || []) { const t = order[Number(v.i) - 1]; if (t) scores[t].push(Number(v.score) || 0) }
}
const rows = titles.map((t) => { const a = scores[t]; const m = a.reduce((x, y) => x + y, 0) / (a.length || 1); const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length || 1)); return { t, m: +m.toFixed(1), sd: +sd.toFixed(1), a } }).sort((x, y) => y.m - x.m)
for (const r of rows) console.log(`${String(r.m).padStart(5)} ±${r.sd}  ${r.t}  [${r.a.join(',')}]`)
console.log(`花费 ¥${cost.toFixed(4)}`)

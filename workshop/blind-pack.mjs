// blind-pack.mjs —— 把 A/B 稿打乱成「稿X / 稿Y」给人或外部模型盲读；映射只打印到标准输出，不写进盲读目录
// 用法：node workshop/blind-pack.mjs <A/B 目录> <输出目录>
import fs from 'node:fs'
import path from 'node:path'
const [src, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const map = {}
for (const f of fs.readdirSync(src).filter((x) => /-A\.txt$/.test(x)).sort()) {
  const n = (f.match(/-(\d{4})-A\.txt$/) || [])[1]; if (!n) continue
  const B = f.replace(/-A\.txt$/, '-B.txt'); if (!fs.existsSync(path.join(src, B))) continue
  const flip = Math.random() < 0.5
  const [x, y] = flip ? [B, f] : [f, B]
  fs.copyFileSync(path.join(src, x), path.join(out, `${n}-X.txt`))
  fs.copyFileSync(path.join(src, y), path.join(out, `${n}-Y.txt`))
  map[n] = { X: flip ? 'B' : 'A', Y: flip ? 'A' : 'B' }
}
console.log(JSON.stringify(map))

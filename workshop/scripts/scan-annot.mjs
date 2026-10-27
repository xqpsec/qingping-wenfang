// scan-annot.mjs —— 扫描书稿里的审稿批注泄漏（只读，默认）
// 用法：node scripts/scan-annot.mjs <根目录...>            列出命中
//       node scripts/scan-annot.mjs --fix <书目录...>      清除指定书（走 commitChapter，旧版本进 history，可回滚）
import fs from 'node:fs'
import path from 'node:path'
import { findAnnot, stripAnnot } from '../lib/annot.mjs'

const args = process.argv.slice(2)
const fix = args.includes('--fix')
const roots = args.filter((a) => !a.startsWith('--'))
const hits = []
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name)
    if (e.isDirectory()) { if (!/^(node_modules|backup-|history$|work$)/.test(e.name)) walk(f) }
    else if (/\.txt$/.test(e.name) && /[\\/](chapters|分章正文)$/.test(d)) {
      const t = fs.readFileSync(f, 'utf8'); const a = findAnnot(t)
      if (a.length) hits.push({ f, n: a.length, sample: a[0].text })
    }
  }
}
if (!fix) {
  for (const r of roots) walk(r)
  for (const h of hits) console.log(`${h.n}\t${h.f}\t${h.sample}`)
  console.log(`共 ${hits.length} 个文件，${hits.reduce((a, h) => a + h.n, 0)} 处`)
} else {
  // 每本书：book.json 所在目录；改写 chapters/*.txt，旧文件先复制进 history/<nnnn>-<ts>.txt（与 lib/store.mjs commitChapter 同格式）
  for (const dir of roots) {
    // 桌面交付件（分章正文/ + 全书正文.txt）：原文件复制成 .bak-annot 后就地清除
    if (fs.existsSync(path.join(dir, '分章正文'))) {
      const fl = [path.join(dir, '全书正文.txt'), ...fs.readdirSync(path.join(dir, '分章正文')).map((x) => path.join(dir, '分章正文', x))].filter((f) => fs.existsSync(f) && f.endsWith('.txt'))
      for (const f of fl) {
        const t = fs.readFileSync(f, 'utf8'); const a = findAnnot(t); if (!a.length) continue
        const out = stripAnnot(t); fs.copyFileSync(f, f + '.bak-annot'); fs.writeFileSync(f, out, 'utf8')
        if (fs.readFileSync(f, 'utf8') !== out) throw new Error('写后读回不一致：' + f)
        console.log(`清除 ${a.length} 处\t${f}`)
      }
      continue
    }
    const cd = path.join(dir, 'chapters'); if (!fs.existsSync(cd)) { console.log('跳过（无 chapters）', dir); continue }
    for (const name of fs.readdirSync(cd).filter((x) => /^\d{4}\.txt$/.test(x))) {
      const f = path.join(cd, name); const t = fs.readFileSync(f, 'utf8'); const a = findAnnot(t)
      if (!a.length) continue
      const out = stripAnnot(t)
      const hd = path.join(dir, 'history'); fs.mkdirSync(hd, { recursive: true })
      const stamp = `${name.slice(0, 4)}-${Date.now()}`
      fs.writeFileSync(path.join(hd, stamp + '.txt'), t, 'utf8')
      fs.writeFileSync(path.join(hd, stamp + '.json'), JSON.stringify({ meta: null, report: null, replacedBy: `清除 ${a.length} 处审稿批注（2026-10-07 事故修复）`, at: new Date().toISOString() }, null, 2), 'utf8')
      fs.writeFileSync(f, out, 'utf8')
      const back = fs.readFileSync(f, 'utf8')
      if (back !== out || findAnnot(back).length) throw new Error('写后读回不一致：' + f)
      console.log(`清除 ${a.length} 处\t${f}`)
    }
  }
}

// manual-deliver.mjs —— 手工触发交付（用于 DeepSeek 已完成但因措辞没触发自动交付的情况）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SB = path.join(HERE, 'data', 'author-sandbox')
const DESK = path.join(os.homedir(), 'Desktop')
const OUT = path.join(DESK, '清平文坊-交付')
const STATE = path.join(HERE, 'data', 'author-state.json')

process.env.WORKSHOP_SANDBOX = SB

const PL = await import('./lib/pipeline.mjs')
const S = await import('./lib/store.mjs')
const CV = await import('./lib/cover.mjs')

const books = S.listBooks()
console.log('找到书籍:', books.map(b => b.id).join(', '))

for (const b of books) {
  const d = path.join(OUT, new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '-' + b.id)
  fs.mkdirSync(d, { recursive: true })
  
  const exp = PL.exportBook(b.id)
  fs.copyFileSync(exp, path.join(d, path.basename(exp)))
  
  fs.writeFileSync(path.join(d, '作品信息.txt'), PL.exportInfo(b.id), 'utf8')
  
  const cf = CV.coverFile(b.id)
  if (cf) fs.copyFileSync(cf, path.join(d, '封面-' + path.basename(cf)))
  
  fs.writeFileSync(path.join(d, '说明.txt'), `DeepSeek 作为作者在工坊里改到自己满意后交付（本次为手工触发）。\n请主办方最终修订后上传；AI 申报请按实际情况填写。\n`, 'utf8')
  
  console.log('✅ 已交付到', d)
}

// 更新状态
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
st.delivered = { at: new Date().toISOString(), dir: path.join(OUT, fs.readdirSync(OUT)[0]), manual: true }
fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8')
console.log('✅ 状态已更新')

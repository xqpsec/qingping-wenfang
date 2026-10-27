// store.mjs —— 书本存储与 checkpoint。每一步产物都单独落盘，任何一步中断都能从上一步续跑。
// 目录：projects/workshop-books/<书名>/
//   book.json         书的基本信息与进度
//   concepts.md       3 个开书方案（原文）
//   bible.md          全书设定集
//   outline.md        章纲（一行一章）
//   chapters/0001.txt 定稿正文
//   work/0001/        本章工作区：plan.md、cand-1.txt…、judge.json、revise.txt、summary.md（落选稿全部保留）
//   history/          每次定稿前的旧版本（可回滚）
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './llm.mjs'

// WORKSHOP_SANDBOX=<目录>：测试/模拟用户时把书库放进沙箱，真书不受影响
export const SANDBOX = process.env.WORKSHOP_SANDBOX ? path.resolve(process.env.WORKSHOP_SANDBOX) : ''
export const BOOKS = SANDBOX ? path.join(SANDBOX, 'books') : path.join(ROOT, 'projects', 'workshop-books')
fs.mkdirSync(BOOKS, { recursive: true })

const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 40) || 'book'
export const pad = (n) => String(n).padStart(4, '0')

export function listBooks() {
  return fs.readdirSync(BOOKS).filter((d) => fs.existsSync(path.join(BOOKS, d, 'book.json')))
    .map((d) => readBook(d)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

export function createBook(title, fields = {}) {
  let id = safe(title); let i = 2
  while (fs.existsSync(path.join(BOOKS, id))) id = safe(title) + '-' + i++
  const dir = path.join(BOOKS, id)
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true })
  const book = { id, title, genre: 'urban-naodong', platform: 'tomato', stage: 'new', chapters: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cost: 0, ...fields }
  writeJson(path.join(dir, 'book.json'), book)
  return book
}

export function readBook(id) { return JSON.parse(fs.readFileSync(path.join(BOOKS, id, 'book.json'), 'utf8')) }
export function saveBook(book) { book.updatedAt = new Date().toISOString(); writeJson(path.join(BOOKS, book.id, 'book.json'), book); return book }
export function bookPath(id, ...p) { return path.join(BOOKS, id, ...p) }

export function readText(id, ...p) { const f = bookPath(id, ...p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }
export function writeText(id, rel, text) {
  const f = bookPath(id, ...rel.split('/'))
  fs.mkdirSync(path.dirname(f), { recursive: true })
  // 写入先落临时文件再改名，防止中途断电留下半个文件
  fs.writeFileSync(f + '.tmp', text, 'utf8'); fs.renameSync(f + '.tmp', f)
  // 回读校验
  if (fs.readFileSync(f, 'utf8') !== text) throw new Error('写盘校验失败：' + rel)
}
export function writeJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2), 'utf8'); fs.renameSync(f + '.tmp', f) }
export function readJson(id, rel, dflt = null) { const t = readText(id, ...rel.split('/')); return t ? JSON.parse(t) : dflt }

// 书级人物事实层：独立于 bible，作者可随时修订；旧书没有此文件时返回空卡。
export function readCharacterCard(id) { return readJson(id, 'character-card.json', { version: 1, updatedAt: '', characters: [] }) }
export function saveCharacterCard(id, card) {
  const characters = Array.isArray(card?.characters) ? card.characters.slice(0, 30).map((x) => ({
    name: String(x?.name || '').trim().slice(0, 40),
    role: String(x?.role || '').trim().slice(0, 80),
    goal: String(x?.goal || '').trim().slice(0, 160),
    traits: String(x?.traits || '').trim().slice(0, 160),
    behavior: String(x?.behavior || '').trim().slice(0, 240),
    bottomLine: String(x?.bottomLine || '').trim().slice(0, 160),
    weakness: String(x?.weakness || '').trim().slice(0, 160),
    relation: String(x?.relation || '').trim().slice(0, 160),
    decisionPriority: String(x?.decisionPriority || '').trim().slice(0, 160),
  })).filter((x) => x.name) : []
  const out = { version: 1, updatedAt: new Date().toISOString(), characters }
  writeText(id, 'character-card.json', JSON.stringify(out, null, 2)); return out
}

/** 定稿：旧版本（正文 + 当时的分数/评审报告）先进 history，再写新版本 */
export function commitChapter(id, n, text, meta, { reason = '' } = {}) {
  const cur = readText(id, 'chapters', pad(n) + '.txt')
  const book = readBook(id)
  const i = book.chapters.findIndex((c) => c.n === n)
  if (cur) {
    const stamp = `${pad(n)}-${Date.now()}`
    writeText(id, `history/${stamp}.txt`, cur)
    // 旁注：旧版本的元数据与评审报告一起存，回滚时分数跟着回来，不会出现「正文回去了、分数还是新的」
    const oldMeta = i >= 0 ? book.chapters[i] : {}
    const oldReport = readText(id, 'work', pad(n), 'report.json')
    writeText(id, `history/${stamp}.json`, JSON.stringify({ meta: oldMeta, report: oldReport ? JSON.parse(oldReport) : null, replacedBy: reason, at: new Date().toISOString() }, null, 2))
  }
  writeText(id, `chapters/${pad(n)}.txt`, text)
  const row = { n, ...meta, committedAt: new Date().toISOString() }
  if (i >= 0) book.chapters[i] = row; else book.chapters.push(row)
  book.chapters.sort((a, b) => a.n - b.n)
  saveBook(book)
}

/** 某章的旧版本列表（新→旧），带当时的分数与被什么操作替换 */
export function listHistory(id, n) {
  const d = bookPath(id, 'history'); if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).filter((f) => f.startsWith(pad(n) + '-') && f.endsWith('.txt')).sort().reverse()
    .map((file) => {
      const side = readJson(id, `history/${file.replace(/\.txt$/, '.json')}`, null)
      const ts = Number((file.match(/^\d+-(\d+)/) || [])[1]) || 0
      // 字数按旧版本正文实算（不信旁注里的 meta.chars —— 那是被替换前的元数据，可能和正文不同步）
      const body = readText(id, 'history', file).split('\n').slice(1).join('').replace(/\s/g, '') // 不含第一行章名，与章节表「字数」同口径
      const full = readText(id, 'history', file)
      return { file, at: ts ? new Date(ts).toISOString() : '', score: side?.meta?.score ?? null, readNext: side?.meta?.readNext ?? null, replacedBy: side?.replacedBy || (file.includes('dropped') ? '删除最后一章' : ''), chars: body.length, title: full.split('\n')[0].trim(), hash: bodyHash(full) }
    })
}

/** 恢复旧版本。默认只恢复正文、保留当前章名（模拟用户实测：连章名一起退回会把已修好的章名改坏）；keepTitle=false 才连章名一起恢复 */
export function rollback(id, n, file, { keepTitle = true } = {}) {
  if (!/^\d{4}-\d+(-dropped)?\.txt$/.test(file)) throw new Error('历史版本文件名不对')
  let t = readText(id, 'history', file); if (!t) throw new Error('找不到历史版本')
  const side = readJson(id, `history/${file.replace(/\.txt$/, '.json')}`, null)
  const curMeta = readBook(id).chapters.find((c) => c.n === n) || {}
  const curText = readText(id, 'chapters', pad(n) + '.txt')
  if (keepTitle && curText) { const lines = t.split('\n'); lines[0] = curText.split('\n')[0]; t = lines.join('\n') }
  // 有旁注就把当时的分数/报告一起恢复；旧数据没有旁注则分数置空，提示重做评审，避免张冠李戴
  const meta = side?.meta ? { ...side.meta, rolledBackFrom: file } : { ...curMeta, score: null, readNext: null, rolledBackFrom: file }
  if (keepTitle && curMeta.title) meta.title = curMeta.title
  const ts = Number((file.match(/^\d+-(\d+)/) || [])[1]) || 0
  commitChapter(id, n, t, meta, { reason: `恢复旧版本时换下来的（当时恢复的是 ${ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : file} 存档的那版${keepTitle ? '，章名保持不变' : '，连章名一起恢复'}）` })
  if (side?.report) writeText(id, `work/${pad(n)}/report.json`, JSON.stringify(side.report, null, 2))
  else fs.rmSync(bookPath(id, 'work', pad(n), 'report.json'), { force: true })
}

/** 删除最后一章（放进 history，不真删），以便重写 */
export function dropLastChapter(id) {
  const book = readBook(id); const last = book.chapters[book.chapters.length - 1]; if (!last) return
  const cur = readText(id, 'chapters', pad(last.n) + '.txt')
  if (cur) writeText(id, `history/${pad(last.n)}-${Date.now()}-dropped.txt`, cur)
  fs.rmSync(bookPath(id, 'chapters', pad(last.n) + '.txt'), { force: true })
  fs.rmSync(bookPath(id, 'work', pad(last.n)), { recursive: true, force: true })
  book.chapters.pop(); saveBook(book)
}

/** 正文指纹（不含第一行章名、忽略空白）：用来判断一份评审报告评的是不是当前这版正文。改章名不算改正文 */
export function bodyHash(text) { const s = String(text || '').split('\n').slice(1).join('').replace(/\s/g, ''); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(16) }

export function addCost(id, c) { const b = readBook(id); b.cost = +((b.cost || 0) + c).toFixed(4); saveBook(b) }

// importer.mjs —— 带稿导入（2026-10-02）：把作者已有的 TXT / Markdown 按「第N章」拆开存成工坊的书，之后直接「写下一章」接着写
// 拆章与落库不调模型、不花钱；第一次「写下一章」时才用便宜模型从原文整理设定集（见 pipeline.ensureImportedFoundation）。
import * as S from './store.mjs'
import { resolveStyle } from './styles.mjs'

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
/** 中文数字 / 阿拉伯数字 / 全角数字 → 整数；认不出返回 null */
export function parseNum(s) {
  s = String(s).trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
  if (/^\d+$/.test(s)) return Number(s)
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(s)) return null
  let total = 0, cur = 0
  for (const ch of s) {
    if (ch in CN) cur = CN[ch]
    else { const unit = { 十: 10, 百: 100, 千: 1000 }[ch]; total += (cur || 1) * unit; cur = 0 }
  }
  return total + cur
}

// 章标题：行首「第X章/回/节」，或 Markdown 标题里带它；允许「第一章：xxx」「第 12 章 xxx」「## 第3章 xxx」
const HEAD = /^\s*(?:#{1,6}\s*)?第\s*([0-9０-９]+|[零〇一二两三四五六七八九十百千]+)\s*[章回节]\s*[:：.、\-—\s]*(.*)$/

/** 正文规范化：去行首尾空白、去空行，段与段之间一个空行（番茄「格式混乱」拒签项的防线） */
export const normParas = (t) => String(t).split('\n').map((l) => l.replace(/^[\s\u3000]+|\s+$/g, '')).filter(Boolean).join('\n\n')
const nonSpace = (t) => String(t).replace(/\s/g, '').length

/**
 * 拆章（纯函数）。返回 { chapters:[{n,title,body,srcNo}], preface, warnings }
 * - 有章标题：按标题切；章号一律按出现顺序重排为 1..k（原文跳号/重号写进 warnings，不静默吞掉）
 * - 没有章标题：短文整篇一章；长文按段落凑到约 3000 字一章
 */
export function splitChapters(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const heads = []
  lines.forEach((l, i) => { const m = l.match(HEAD); if (m && l.trim().length <= 60) heads.push({ i, srcNo: parseNum(m[1]), title: m[2].replace(/^[#\s]+|[#\s]+$/g, '').slice(0, 30) }) })
  const warnings = []
  let chapters = [], preface = ''
  if (heads.length) {
    preface = normParas(lines.slice(0, heads[0].i).join('\n'))
    heads.forEach((h, k) => {
      const body = normParas(lines.slice(h.i + 1, k + 1 < heads.length ? heads[k + 1].i : lines.length).join('\n'))
      chapters.push({ n: chapters.length + 1, title: h.title, body, srcNo: h.srcNo })
    })
    const empty = chapters.filter((c) => !nonSpace(c.body))
    if (empty.length) warnings.push(`有 ${empty.length} 个章标题下面没有正文（${empty.slice(0, 5).map((c) => `原第${c.srcNo ?? '?'}章`).join('、')}），已跳过`)
    chapters = chapters.filter((c) => nonSpace(c.body)).map((c, i) => ({ ...c, n: i + 1 }))
    const nos = chapters.map((c) => c.srcNo)
    const jumps = nos.slice(1).map((v, i) => [nos[i], v]).filter(([a, b]) => a != null && b != null && b !== a + 1)
    if (jumps.length) warnings.push(`原文章号不连续（例如 ${jumps.slice(0, 3).map(([a, b]) => `${a}→${b}`).join('、')}），已按出现顺序重新编号为 1–${chapters.length}`)
  } else {
    const paras = normParas(text).split('\n\n').filter(Boolean)
    if (nonSpace(text) <= 6000) chapters = paras.length ? [{ n: 1, title: '', body: paras.join('\n\n'), srcNo: null }] : []
    else {
      let buf = []
      const flush = () => { if (buf.length) chapters.push({ n: chapters.length + 1, title: '', body: buf.join('\n\n'), srcNo: null }); buf = [] }
      for (const p of paras) { buf.push(p); if (nonSpace(buf.join('')) >= 3000) flush() }
      flush()
    }
    if (chapters.length) warnings.push(`没找到「第X章」这样的章标题，已按约 3000 字一章自动切成 ${chapters.length} 章，章名留空`)
  }
  return { chapters, preface, warnings }
}

/** 落库（不花钱）：建书 → 逐章定稿 → 写占位章纲（让后续章纲从第 k+1 章接着生成，不重写已有章节） */
export function importBook({ title, text, style } = {}) {
  title = String(title || '').trim().slice(0, 30)
  if (!title) throw new Error('请填写书名')
  const { chapters, preface, warnings } = splitChapters(text)
  if (!chapters.length) throw new Error('文件里没读到正文。请确认是 TXT（UTF-8）或 Markdown 文本')
  if (chapters.length > 2000) throw new Error(`拆出 ${chapters.length} 章，超过 2000 章上限，请分卷导入`)
  const st = resolveStyle(style)
  const total = chapters.reduce((a, c) => a + nonSpace(c.body), 0)
  const book = S.createBook(title, { stage: 'writing', genre: st.id, styleCustom: st.custom || '', imported: { at: new Date().toISOString(), chapters: chapters.length, chars: total, preface: preface.slice(0, 500) } })
  for (const c of chapters) {
    const t = c.title || `第${c.n}章`
    // 逐章写后回读（铁律 8：写后读回比对）
    S.commitChapter(book.id, c.n, `第${c.n}章 ${c.title}`.trim() + `\n\n${c.body}\n`, { title: t, chars: nonSpace(c.body), score: null, readNext: null, imported: true }, { reason: '导入原稿' })
    const back = S.readText(book.id, 'chapters', S.pad(c.n) + '.txt')
    if (nonSpace(back.split('\n').slice(1).join('')) !== nonSpace(c.body)) throw new Error(`第 ${c.n} 章写盘后字数对不上，已停止导入`)
  }
  const tail = (b) => b.replace(/\s/g, '').slice(-24)
  S.writeText(book.id, 'outline.md', chapters.map((c) => `${c.n}|${(c.title || `第${c.n}章`).replace(/\|/g, '/')}|已导入原稿|-|-|-|-|已导入原稿，结尾：${tail(c.body).replace(/\|/g, '/')}`).join('\n') + '\n')
  if (preface) S.writeText(book.id, 'imported-preface.md', preface)
  return { book: S.readBook(book.id), chapters: chapters.length, chars: total, warnings }
}

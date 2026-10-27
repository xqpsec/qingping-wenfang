// book-check.mjs —— 签约前体检（零成本，纯计数，不调模型）
// 为什么要它：签约结果是唯一的真标准，但一本书只有 2万/5万/8万 三次机会，不能拿来试错。
// 所以投稿前用「数得出来、官方明文拒签项对得上」的硬指标把关；投稿时把这份体检存进签约台账，
// 签约/被拒结果回来后，就能对比「签上的书」和「被拒的书」这些指标差在哪，逐步校准哪些指标真的有用。
// 依据：memory/knowledge/签约调研汇总-20260924.md（拒因①格式混乱：头部基线约 25 字/段；②结构失常：章末同型钩、句式重复；③AI 粗制滥造）
//       lib/tics.mjs（AI 腔口癖规则，番茄 119 章爆款对照）；lib/fanqie-spec.json（书名 15 字、简介 50–500 字）
import fs from 'node:fs'
import path from 'node:path'
import { scanTics } from './tics.mjs'
import { findAnnot } from './annot.mjs'

export const TIERS = [20000, 50000, 80000] // 番茄长篇签约：2万 / 5万 / 8万字各一次，三档都失败该书永久不能签
const han = (s) => (String(s).match(/[\u4e00-\u9fa5]/g) || []).length
const body = (t) => String(t || '').split('\n').slice(1).join('\n') // 去掉章名行
const count = (s) => String(s).replace(/\s/g, '').length

function chapterFiles(dir) {
  const d = path.join(dir, 'chapters')
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^\d{4}\.txt$/.test(f)).sort().map((f) => path.join(d, f)).filter((f) => fs.statSync(f).size > 0) : []
}

/** 体检一本书（bookDir = 含 book.json 的目录）。返回指标 + 缺项（每条缺项都是能直接动手改的话） */
export function checkBook(bookDir) {
  const b = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'))
  const files = chapterFiles(bookDir)
  const texts = files.map((f) => fs.readFileSync(f, 'utf8'))
  const chars = texts.reduce((a, t) => a + count(body(t)), 0)
  const pk = b.package || {}
  const coverFile = pk.cover?.file ? path.join(bookDir, 'covers', pk.cover.file) : ''
  const m = {
    chapters: files.length,
    chars,
    titleLen: [...String(b.title || '')].length,
    introLen: count(pk.intro || ''),
    tags: (pk.tags || []).length,
    cover: !!(coverFile && fs.existsSync(coverFile)),
  }
  // 开篇（前 3 章）：编辑最先看、也最决定签不签的部分
  const open = texts.slice(0, 3).map(body)
  const paras = open.flatMap((t) => t.split('\n').map((x) => x.trim()).filter(Boolean))
  m.paraAvg = paras.length ? Math.round(paras.reduce((a, p) => a + count(p), 0) / paras.length) : 0
  m.paraMax = paras.reduce((a, p) => Math.max(a, count(p)), 0)
  const openText = open.join('\n')
  const k = Math.max(0.3, han(openText) / 1000)
  const tics = scanTics(openText)
  m.ticsPerK = tics.perK
  m.dashPerK = +(((openText.match(/——/g) || []).length) / k).toFixed(2)
  m.notButPerK = +(((openText.match(/不是[^。！？\n]{0,20}而是/g) || []).length) / k).toFixed(2)
  m.exclaimPerK = tics.exclaimPerK
  // 章末同型：每章最后一句的末 4 字，相同的越多越像套模板
  const tails = texts.map((t) => { const s = body(t).trim().split(/[。！？…\n]/).map((x) => x.trim()).filter(Boolean).pop() || ''; return s.slice(-4) })
  const freq = {}; for (const t of tails) if (t) freq[t] = (freq[t] || 0) + 1
  m.sameTailMax = Object.values(freq).reduce((a, n) => Math.max(a, n), 0)
  m.firstScore = b.chapters?.[0]?.score ?? null
  m.scores = (b.chapters || []).slice(0, 5).map((c) => c.score ?? null)

  // 审稿批注泄漏（全书扫，不只开篇）：一处都不能有，发出去就是事故
  const leaks = texts.flatMap((t, i) => findAnnot(t).map((x) => ({ ch: i + 1, ...x })))
  m.annot = leaks.length

  const gaps = []
  if (m.annot) gaps.push(`正文混进了 ${m.annot} 处审稿批注（如第 ${leaks[0].ch} 章第 ${leaks[0].line} 行「${leaks[0].text}」），发表前必须删掉`)
  if (m.chapters === 0) gaps.push('还没有正文')
  if (m.titleLen === 0 || m.titleLen > 15) gaps.push(`书名 ${m.titleLen} 字，番茄要求 1–15 字（含标点）`)
  if (m.introLen < 50) gaps.push(m.introLen ? `简介只有 ${m.introLen} 字，番茄至少 50 字` : '没有简介')
  if (m.introLen > 500) gaps.push(`简介 ${m.introLen} 字，超过番茄 500 字上限`)
  if (!m.tags) gaps.push('没有标签')
  if (!m.cover) gaps.push('没有封面')
  if (m.paraAvg > 60) gaps.push(`开篇段落平均 ${m.paraAvg} 字/段（头部作品约 25 字/段），手机上是大段文字墙，官方拒签项「格式混乱」`)
  if (m.paraMax > 300) gaps.push(`开篇最长一段 ${m.paraMax} 字，需要拆段`)
  if (m.ticsPerK > 4) gaps.push(`开篇 AI 腔口癖 ${m.ticsPerK} 处/千字（计时停顿、盯着看、没说话等），官方拒签项「AI 粗制滥造」`)
  if (m.dashPerK > 3) gaps.push(`开篇破折号 ${m.dashPerK} 个/千字，偏多`)
  if (m.notButPerK > 1) gaps.push(`「不是……而是……」${m.notButPerK} 处/千字，典型 AI 句式`)
  if (m.chapters >= 4 && m.sameTailMax >= Math.ceil(m.chapters / 2)) gaps.push(`${m.sameTailMax} 章的章末结尾几乎一样，官方拒签项「结构失常」`)
  return { at: new Date().toISOString(), title: b.title || path.basename(bookDir), metrics: m, gaps }
}

/** 下一次签约机会：rejections = 已被拒次数（0/1/2）。返回 null = 三次都用完 */
export function nextChance(chars, rejections) {
  if (rejections >= TIERS.length) return null
  const need = TIERS[rejections]
  return { tier: need / 10000 + '万', need, short: Math.max(0, need - chars), ready: chars >= need }
}

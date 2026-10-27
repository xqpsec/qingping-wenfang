// metrics.mjs —— 章节「可机器计算」的吸引力指标（零 token）
// 设计依据：memory/RESEARCH-v01-小说评判体系-20260930.md §1（维度 1/2/6/7/11 的机器代理量）
//           memory/RESEARCH-v01-都市脑洞写法-20260930.md（300 字冲突 / 500 字金手指 / 章末钩子）
// 所有指标都只做「与爆款分布比位置」，不设拍脑袋阈值。阈值来自 baseline.json（build-baseline.mjs 生成）。

const QUOTE_RE = /[“「]([^”」]{0,400})[”」]/g
const CLICHE = ['冷笑', '不可思议', '震惊', '难以置信', '深吸一口气', '眼中闪过一丝', '仿佛', '不禁', '宛如', '竟然',
  '嘴角勾起', '一抹', '心中暗道', '不由得', '缓缓', '淡淡', '微微一笑', '倒吸一口凉气', '瞳孔一缩', '瞳孔骤缩', '心头一震',
  '空气仿佛凝固', '时间仿佛静止', '命运的齿轮', '这一刻', '他知道', '她知道', '某种', '莫名的', '一丝丝']

/** 去掉爬取语料的元数据头（书名: / 题材id: …） */
export function stripMeta(raw) {
  const lines = String(raw).replace(/\r/g, '').split('\n')
  let i = 0
  while (i < lines.length && /^(书名|题材id|排行|章节id|mode|字数|性别):/.test(lines[i])) i++
  return lines.slice(i).join('\n').trim()
}

/** 去掉 markdown 章标题 */
export function stripHeading(t) {
  return String(t).replace(/^\s*#+[^\n]*\n/, '').replace(/^\s*第[0-9一二三四五六七八九十百零]+章[^\n]*\n/, '').trim()
}

const count = (s, re) => (s.match(re) || []).length

export function computeMetrics(text) {
  const body = stripHeading(stripMeta(text))
  const paras = body.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  const flat = body.replace(/\s/g, '')
  const chars = flat.length
  const k = Math.max(0.3, chars / 1000)

  // 对白
  let dlgChars = 0; let dlgCount = 0; let firstQuote = -1
  for (const m of flat.matchAll(QUOTE_RE)) { dlgChars += m[1].length; dlgCount++; if (firstQuote < 0) firstQuote = m.index }
  const dlgParas = paras.filter((p) => /^[“「]/.test(p)).length

  // 句子
  const sents = flat.split(/[。！？!?…]+/).map((x) => x.replace(/[“”「」]/g, '')).filter((x) => x.length > 0)
  const lens = sents.map((s) => [...s].length)
  const mean = lens.reduce((a, b) => a + b, 0) / (lens.length || 1)
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length || 1))

  // 段落
  const plens = paras.map((p) => p.replace(/\s/g, '').length)
  const pMean = plens.reduce((a, b) => a + b, 0) / (plens.length || 1)
  const longParas = plens.filter((x) => x > 120).length

  // 开篇（仅对第一章有意义，但所有章都算，作为「每章开场进入速度」）
  const head300 = flat.slice(0, 300)
  const headDialog = count(head300, /[“「]/g) > 0 ? 1 : 0
  const headPunch = count(head300, /[！？!?]/g)
  const firstSys = flat.search(/【[^】]{1,30}】|系统|面板|金手指|技能|奖励/)

  // 章末 200 字
  const tail = flat.slice(-200)
  const tailQ = count(tail, /[？?]/g)
  const tailEllipsis = count(tail, /…|\.\.\./g)
  const tailDialog = count(tail, /[“「]/g) > 0 ? 1 : 0
  const lastPara = paras[paras.length - 1] || ''
  const lastParaLen = lastPara.replace(/\s/g, '').length

  // 水：4-gram 重复率（去标点）
  const han = flat.replace(/[^\u4e00-\u9fa5]/g, '')
  const grams = new Map()
  for (let i = 0; i + 4 <= han.length; i++) { const g = han.slice(i, i + 4); grams.set(g, (grams.get(g) || 0) + 1) }
  let rep = 0; for (const v of grams.values()) if (v > 1) rep += v - 1
  const rep4 = rep / Math.max(1, han.length - 3)

  // 套话
  let cliche = 0; const clicheHits = {}
  for (const w of CLICHE) { const n = flat.split(w).length - 1; if (n) { cliche += n; clicheHits[w] = n } }

  // 格式
  const halfComma = count(flat, /[\u4e00-\u9fa5],|,[\u4e00-\u9fa5]/g)
  const halfQuote = count(flat, /"/g)
  const markdown = count(body, /\*\*|^#+ |^- /gm)

  // 逐字重复的段落（≥12 字）与未空行分段（番茄拒稿项）
  const seen = new Map(); let dupParas = 0
  for (const p of paras) { const key = p.replace(/\s/g, ''); if (key.length < 12) continue; if (seen.has(key)) dupParas++; else seen.set(key, 1) }
  const rawLines = body.split('\n')
  let glued = 0; for (let i = 1; i < rawLines.length; i++) if (rawLines[i].trim() && rawLines[i - 1].trim()) glued++
  const noBlankLine = paras.length > 5 && glued / paras.length > 0.5 ? 1 : 0

  return {
    chars,
    paras: paras.length,
    parasPerK: +(paras.length / k).toFixed(1),
    paraMean: +pMean.toFixed(1),
    longParaRatio: +(longParas / (paras.length || 1)).toFixed(3),
    dialogRatio: +(dlgChars / (chars || 1)).toFixed(3),
    dialogPerK: +(dlgCount / k).toFixed(1),
    dialogParaRatio: +(dlgParas / (paras.length || 1)).toFixed(3),
    sentMean: +mean.toFixed(1),
    sentSd: +sd.toFixed(1),
    shortSentRatio: +(lens.filter((x) => x <= 10).length / (lens.length || 1)).toFixed(3),
    exclaimPerK: +(count(flat, /[！!]/g) / k).toFixed(2),
    questionPerK: +(count(flat, /[？?]/g) / k).toFixed(2),
    firstQuotePos: firstQuote < 0 ? chars : firstQuote,
    firstSysPos: firstSys < 0 ? chars : firstSys,
    headDialog,
    headPunch,
    tailQ,
    tailEllipsis,
    tailDialog,
    lastParaLen,
    rep4: +rep4.toFixed(4),
    clichePerK: +(cliche / k).toFixed(2),
    clicheHits,
    halfComma,
    halfQuote,
    markdown,
    dupParas,
    noBlankLine,
    // 写手自述混进正文（「我看了修改要求……」「主要改动：」）：2026-10-01 模拟作者发现评审完全没检出
    writerNotes: (body.match(/我(看了|已经|先|将|会)?(修改要求|按要求|按照要求|开始(按|改写)|改写如下)|主要改动[:：]|改动说明|以下是(改写|修改)后/g) || []).length,
  }
}

// 参与「与爆款分布比位置」的指标（方向 both = 落在 P10–P90 为佳；low = 越低越好；high = 越高越好）
export const BAND_KEYS = {
  parasPerK: 'both', paraMean: 'both', dialogRatio: 'both', dialogPerK: 'both', sentMean: 'both', sentSd: 'both',
  shortSentRatio: 'both', exclaimPerK: 'both', questionPerK: 'both', firstQuotePos: 'low', rep4: 'low', clichePerK: 'low',
  longParaRatio: 'low', tailQ: 'high',
}

export const LABELS = {
  parasPerK: '每千字段数', paraMean: '平均段长', dialogRatio: '对白占比', dialogPerK: '每千字对白句数', sentMean: '平均句长',
  sentSd: '句长波动', shortSentRatio: '短句占比', exclaimPerK: '每千字感叹号', questionPerK: '每千字问号',
  firstQuotePos: '第一句对白出现位置(字)', rep4: '重复用语率', clichePerK: '每千字AI套话', longParaRatio: '长段(>120字)占比',
  tailQ: '章末200字问号数', chars: '字数',
}

function pct(sorted, p) { const i = (sorted.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo) }

export function buildBands(metricList) {
  const bands = {}
  for (const key of [...Object.keys(BAND_KEYS), 'chars']) {
    const v = metricList.map((m) => m[key]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
    bands[key] = { p10: +pct(v, 0.1).toFixed(3), p25: +pct(v, 0.25).toFixed(3), p50: +pct(v, 0.5).toFixed(3), p75: +pct(v, 0.75).toFixed(3), p90: +pct(v, 0.9).toFixed(3), n: v.length }
  }
  return bands
}

/**
 * 与爆款分布对位：每项 0–1 分，总分 0–100。
 * both：落在 P25–P75 得 1，P10–P90 得 0.6，外面 0。low：≤P50 得 1，≤P90 得 0.6。high：≥P50 得 1，≥P10 得 0.6。
 */
export function bandScore(m, bands) {
  const items = []
  let sum = 0; let n = 0
  for (const [key, dir] of Object.entries(BAND_KEYS)) {
    const b = bands[key]; if (!b) continue
    const v = m[key]; let s = 0
    if (dir === 'both') s = v >= b.p25 && v <= b.p75 ? 1 : v >= b.p10 && v <= b.p90 ? 0.6 : 0
    else if (dir === 'low') s = v <= b.p50 ? 1 : v <= b.p90 ? 0.6 : 0
    else s = v >= b.p50 ? 1 : v >= b.p10 ? 0.6 : 0
    let hint = ''
    if (s < 1) {
      if (dir === 'both') hint = v < b.p25 ? `偏低（爆款中位 ${b.p50}）` : `偏高（爆款中位 ${b.p50}）`
      else if (dir === 'low') hint = `偏高（爆款中位 ${b.p50}）`
      else hint = `偏低（爆款中位 ${b.p50}）`
    }
    items.push({ key, label: LABELS[key] || key, value: v, score: s, hint })
    sum += s; n++
  }
  // 硬格式问题直接扣分
  const hard = []
  if (m.halfComma > 0) hard.push(`半角逗号 ${m.halfComma} 处（番茄「标点错乱」拒签项）`)
  if (m.halfQuote > 0) hard.push(`半角引号 ${m.halfQuote} 处`)
  if (m.markdown > 0) hard.push(`Markdown 符号 ${m.markdown} 处`)
  if (m.dupParas > 0) hard.push(`逐字重复的段落 ${m.dupParas} 处（番茄「大段落重复」会拒稿）`)
  if (m.noBlankLine) hard.push('段落之间没有空行（上传后会压成一整块 =「格式混乱」）')
  if (m.writerNotes > 0) hard.push(`正文里混进了 AI 的工作说明 ${m.writerNotes} 处（如「我看了修改要求」「主要改动：」），交稿前必须删掉`)
  const score = Math.max(0, Math.round((sum / (n || 1)) * 100) - hard.length * 10)
  return { score, items, hard }
}

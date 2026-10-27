// memes.mjs —— 网络梗知识库：写章时按题材挑少量梗给写手，让对白和吐槽「会玩梗」
//
// 数据：projects/memes/memes.json，由工作区 scripts/memes/build-kb.mjs 构建（开源 GengKu 931 条 + 采集员带来源的条目）。
// 设计：
//   - 每章只给 6 个候选梗，要求写手「最多自然用 1–2 个，用不上就不用」——梗塞多了比不玩梗更出戏。
//   - 有例句的条目（采集版）优先；按题材 fit 过滤；用「书 id + 章号」做种子，同一章重跑选到同一批，不同章轮换。
//   - 古言/历史/年代/仙侠等时代背景不对的题材默认不给现代网络梗（硬塞会穿越），除非风格是「脑洞」类或自定义里写了「梗」。
//   - 文件不存在或坏了 → 返回空，写章照常（不能因为梗库让整条链路崩）。
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './llm.mjs'

export const MEMES_FILE = process.env.WORKSHOP_MEMES || path.join(ROOT, 'projects', 'memes', 'memes.json')

let cache = { mtime: 0, list: [] }
export function loadMemes() {
  try {
    const st = fs.statSync(MEMES_FILE)
    if (st.mtimeMs !== cache.mtime) {
      const j = JSON.parse(fs.readFileSync(MEMES_FILE, 'utf8'))
      cache = { mtime: st.mtimeMs, list: Array.isArray(j.memes) ? j.memes.filter((m) => m && m.meme && m.meaning) : [] }
    }
  } catch { cache = { mtime: 0, list: [] } }
  return cache.list
}

// 风格 → 梗库题材标签
const FIT_OF = [
  [/豪门|总裁|现言|职场|婚恋|甜宠|言情|星光|双男主|女频/, ['女频言情', '豪门', '都市']],
  [/悬疑|灵异|谍战/, ['悬疑', '都市']],
  [/玄幻|仙侠|修真|奇幻/, ['玄幻']],
  [/科幻|末世/, ['科幻']],
  [/青春|校园/, ['校园', '都市']],
  [/都市|赘婿|战神|游戏|体育|日常|种田/, ['都市']],
]
// 时代背景与现代网络梗冲突的题材（脑洞类除外：它们本来就靠现代人视角吐槽）
const PERIOD = /古言|宫斗|宅斗|古风|历史|年代|民国|抗战|东方仙侠|传统玄幻/

// GengKu 里混进了约 48 条「搜索问句」（「XX是谁」「XX有啥梗」），它们不是梗，给写手只会出戏（scripts/memes/audit-kb.mjs 实测）
export const JUNK = /是怎么回事|是什么梗|什么梗|有啥梗|有什么梗|都有啥|是啥|是谁|啥意思|什么意思|出自哪|又是个啥|是个啥|啥叫|什么是|怎么火的|为啥|为什么/

/**
 * 玩梗模式（按书保存，book.memeMode）。2026-10-03 主办方：「梗知识库……可以提供可选的玩梗模式」
 *   off   = 不玩梗
 *   light = 默认：每章 6 个候选，最多自然用 1–2 个（时代题材默认不给）
 *   heavy = 玩梗模式：每章 10 个候选，要求用上 3–5 个；作者主动选了就连时代题材也给（作者自己要的穿越感）
 */
export const MEME_MODES = {
  off: { label: '不玩梗', desc: '正文里不放网络梗' },
  light: { label: '偶尔玩梗', desc: '每章最多自然用 1–2 个，用不上就不用' },
  heavy: { label: '玩梗模式', desc: '对白和吐槽大量玩梗，每章 3–5 个' },
}
export const normMemeMode = (m) => (MEME_MODES[m] ? m : 'light')

/** 这本书的风格要不要玩梗；off=不给 */
export function memePolicy(style) {
  const label = String(style?.label || '')
  if (style?.id === 'custom') return /梗|吐槽|搞笑|沙雕|网感|整活/.test(style.custom || '') ? 'on' : (PERIOD.test(style.custom || '') ? 'off' : 'on')
  if (PERIOD.test(label) && !/脑洞/.test(label)) return 'off'
  return 'on'
}

const fitsOf = (style) => {
  const label = `${style?.label || ''} ${style?.custom || ''}`
  for (const [re, f] of FIT_OF) if (re.test(label)) return f
  return ['都市']
}

// 简单可复现的伪随机（mulberry32）
function rng(seedStr) {
  let h = 2166136261
  for (const c of String(seedStr)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) }
  let a = h >>> 0
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * 挑本章候选梗。seed 用「书 id + 章号」：同章重跑一致，换章轮换，避免全书反复用同几个梗。
 * 返回 [{meme, meaning, usage, example}]（最多 k 个）
 */
export function pickMemes(style, seed, k = 6, mode = 'light') {
  mode = normMemeMode(mode)
  if (mode === 'off') return []
  if (mode === 'light' && memePolicy(style) === 'off') return []
  if (mode === 'heavy' && k === 6) k = 10
  const all = loadMemes()
  if (!all.length) return []
  const fits = fitsOf(style)
  const ok = (m) => !JUNK.test(m.meme) && (!m.fit?.length || m.fit.includes('通用') || m.fit.some((f) => fits.includes(f)))
  const withEx = all.filter((m) => m.example && ok(m))
  const hot = all.filter((m) => !m.example && ok(m) && ['SSS', 'SS', 'S'].includes(m.tier))
  const r = rng(seed)
  const draw = (arr, n) => { const a = arr.slice(); const out = []; while (a.length && out.length < n) out.push(a.splice(Math.floor(r() * a.length), 1)[0]); return out }
  // 默认：4 个带例句的（用法最稳）+ 2 个高热度的；玩梗模式：带例句的占六成
  const nEx = mode === 'heavy' ? Math.ceil(k * 0.6) : Math.min(4, k)
  const picked = [...draw(withEx, nEx), ...draw(hot, k)].slice(0, k)
  return picked.map((m) => ({ meme: m.meme, meaning: m.meaning, usage: m.usage || '', example: m.example || '' }))
}

/** 拼进写手 prompt 的一段；没有梗返回空串 */
export function memeBlock(memes, mode = 'light') {
  if (!memes?.length) return ''
  const rows = memes.map((m, i) => `${i + 1}. 「${m.meme}」：${m.meaning}${m.usage ? `；用在${m.usage}` : ''}${m.example ? `\n   例：${m.example}` : ''}`).join('\n')
  if (normMemeMode(mode) === 'heavy') return `【玩梗模式：本章要用的网络梗】\n作者开了「玩梗模式」：读者就是来看人物玩梗、互损、整活的。从下面挑 3–5 个最贴人物和场景的梗，放进对白、内心吐槽或旁人弹幕式反应里。\n规则：梗要服务情节（推进冲突、制造反差或给人物贴标签），不能为玩而玩；同一个梗全章最多出现 2 次；不要解释梗的意思；情绪最重的那一句台词保持认真，不玩梗；反派也可以玩梗，但要符合他的身份。\n${rows}\n\n`
  return `【本章可用的网络梗（可选）】\n读者嫌 AI「不会玩梗」。下面是当下真实在用的梗，挑最贴人物和场景的 1–2 个，自然放进对白或吐槽里；用不上就一个都别用。\n规则：只让会这样说话的人物说（年轻人、损友、嘴贫的配角），反派和长辈慎用；不要解释梗的意思；不要连着堆；不要放在情绪最重的那句台词上。\n${rows}\n\n`
}

/** 状态：给 /api/status 或测试看库是否加载 */
export function memeStats() { const l = loadMemes(); return { count: l.length, withExample: l.filter((m) => m.example).length, file: fs.existsSync(MEMES_FILE) } }

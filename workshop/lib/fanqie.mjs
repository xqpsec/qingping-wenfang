// 番茄「创建作品」页的结构化规格与校验（2026-10-04 真人闸门只读抓取，词表在 fanqie-spec.json）
// 作品信息 meta 的形状（存在 book.package.meta）：
//   { audience:'male'|'female', signMode:'serial'|'complete',
//     read:{ main:'主分类'(1个), theme:[≤2], role:[≤2], plot:[≤2] },
//     content:{ plot:[], emotion:[≤2], persona:[], world:[≤1] }   // 情节+人设合计 ≤4
//     heroes:['主角名1','主角名2'] }                                // 各 ≤5 字
// 标签只能用词表原词；服务端校验，AI 生成时宽松（丢弃非法词并记录），用户保存时严格（报错让他改）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'fanqie-spec.json'), 'utf8'))
export const LIMITS = SPEC.limits
const len = (s) => [...String(s || '')].length
const uniq = (a) => [...new Set(a)]
const strs = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[、,，\s]+/) : []).map((x) => String(x).trim()).filter(Boolean)

export const audienceKey = (v) => (v === 'female' || v === '女频' ? 'female' : 'male')
export const AUDIENCE_LABEL = (k) => SPEC.audiences[audienceKey(k)]
export const signModeKey = (v) => (v === 'complete' || v === '完本' || v === '完本模式' ? 'complete' : 'serial')
export const signModeLabel = (k) => SPEC.signModes.find((m) => m.id === signModeKey(k)).label

/** 某频道的阅读标签词表 */
export const readList = (aud) => SPEC.read[audienceKey(aud)]
/** 内容标签词表（男女频相同） */
export const contentList = () => SPEC.content

export function emptyMeta(aud = 'male') {
  return { audience: audienceKey(aud), signMode: 'serial', read: { main: '', theme: [], role: [], plot: [] }, content: { plot: [], emotion: [], persona: [], world: [] }, heroes: [] }
}

/**
 * 规整并校验作品信息。
 * - 非词表词 → 丢弃并记入 problems；超出数量上限 → 截断并记入 problems
 * - strict=true 时有任何 problems 直接抛错（用户保存时用，让他自己改）
 * 返回 { meta, problems }
 */
export function normalizeMeta(raw, { audience, strict = false, base = null } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const aud = audienceKey(r.audience || audience || base?.audience)
  const L = readList(aud), C = contentList()
  const problems = []
  const pick = (label, words, allowed, max) => {
    const out = []
    for (const w of uniq(strs(words))) {
      if (!allowed.includes(w)) { problems.push(`「${w}」不在番茄${AUDIENCE_LABEL(aud)}${label}词表里`); continue }
      out.push(w)
    }
    if (out.length > max) { problems.push(`${label}最多选 ${max} 个，多出的「${out.slice(max).join('、')}」已去掉`); out.length = max }
    return out
  }
  const rd = r.read || {}, ct = r.content || {}
  let main = String(rd.main ?? '').trim()
  if (main && !L.main.includes(main)) { problems.push(`主分类「${main}」不在番茄${AUDIENCE_LABEL(aud)}主分类里`); main = '' }
  const meta = {
    audience: aud,
    signMode: signModeKey(r.signMode),
    read: { main, theme: pick('阅读标签·主题', rd.theme, L.theme, SPEC.read.limits.theme), role: pick('阅读标签·角色', rd.role, L.role, SPEC.read.limits.role), plot: pick('阅读标签·情节', rd.plot, L.plot, SPEC.read.limits.plot) },
    content: { plot: pick('内容标签·情节', ct.plot, C.plot, 99), emotion: pick('内容标签·情感', ct.emotion, C.emotion, SPEC.content.limits.emotion), persona: pick('内容标签·人设', ct.persona, C.persona, 99), world: pick('内容标签·世界观', ct.world, C.world, SPEC.content.limits.world) },
    heroes: [],
  }
  // 情节+人设合计 ≤4：先保情节，再补人设
  const cap = SPEC.content.limits.plotPersona
  if (meta.content.plot.length + meta.content.persona.length > cap) {
    problems.push(`内容标签「情节+人设」合计最多 ${cap} 个，已保留前 ${cap} 个`)
    const plot = meta.content.plot.slice(0, cap)
    meta.content.plot = plot
    meta.content.persona = meta.content.persona.slice(0, cap - plot.length)
  }
  for (const h of strs(r.heroes).slice(0, 8)) {
    if (len(h) > LIMITS.hero) { problems.push(`主角名「${h}」${len(h)} 字，超过 ${LIMITS.hero} 字上限，已丢弃`); continue }
    if (!meta.heroes.includes(h)) meta.heroes.push(h)
  }
  if (meta.heroes.length > LIMITS.heroCount) { problems.push(`主角名最多 ${LIMITS.heroCount} 个，多出的已去掉`); meta.heroes.length = LIMITS.heroCount }
  if (strict && problems.length) throw new Error('作品信息不符合番茄规则：' + problems.join('；'))
  return { meta, problems }
}

/** 还缺什么（交付/提醒用）：不阻止保存，只提示 */
export function metaGaps(meta, intro = '') {
  const m = meta || emptyMeta()
  const gaps = []
  if (!m.read?.main) gaps.push('阅读标签的「主分类」还没选（必选，签约后不能改）')
  if (!m.heroes?.length) gaps.push('主角名还没填')
  const n = len(intro)
  if (n && n < LIMITS.introMin) gaps.push(`简介只有 ${n} 字，番茄要求至少 ${LIMITS.introMin} 字`)
  if (n > LIMITS.introMax) gaps.push(`简介 ${n} 字，超过番茄 ${LIMITS.introMax} 字上限`)
  return gaps
}

/** 所有已选标签拍平成一行（兼容旧的 package.tags 展示与导出） */
export function flatTags(meta) {
  if (!meta) return []
  const r = meta.read || {}, c = meta.content || {}
  return uniq([r.main, ...(r.theme || []), ...(r.role || []), ...(r.plot || []), ...(c.plot || []), ...(c.persona || []), ...(c.emotion || []), ...(c.world || [])].filter(Boolean))
}

/** 给 AI 的词表说明：只列对应频道的阅读标签词表 + 内容标签词表 */
export function specForPrompt(aud) {
  const L = readList(aud), C = contentList(), lim = SPEC.read.limits, cl = SPEC.content.limits
  return `【番茄「创建作品」页的真实选项（${AUDIENCE_LABEL(aud)}）。标签只能从下面的原词里选，逐字照抄，不许自造、不许改字】
阅读标签（签约后不能改）：主分类必选且只能 1 个；主题最多 ${lim.theme} 个；角色最多 ${lim.role} 个；情节最多 ${lim.plot} 个
  主分类：${L.main.join('、')}
  主题：${L.theme.join('、')}
  角色：${L.role.join('、')}
  情节：${L.plot.join('、')}
内容标签：情节+人设合计最多 ${cl.plotPersona} 个；情感最多 ${cl.emotion} 个；世界观最多 ${cl.world} 个
  情节：${C.plot.join('、')}
  情感：${C.emotion.join('、')}
  人设：${C.persona.join('、')}
  世界观：${C.world.join('、')}
主角名：最多 ${LIMITS.heroCount} 个，每个不超过 ${LIMITS.hero} 个字
简介：${LIMITS.introMin}–${LIMITS.introMax} 字，不能有低俗、暴力、血腥内容`
}

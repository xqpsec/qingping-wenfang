// packaging.mjs —— 包装编辑 agent：书名 / 简介 / 封面提示词
//
// 包装编辑要有的能力（按番茄新书的点击漏斗排）：
//   ① 对标爆款：从本地榜单库（data/knowledge/rank/now-*.jsonl，平台接口抓取）挑同分类、在读最高的书名和简介当参照，
//      先拆它们的句式，再套到本书，不是凭空起名
//   ② 卖点提炼：从设定集和已写章节里找「一句话能讲给朋友听」的反差，书名把它前置
//   ③ 命名公式：身份/场景标签 + 反差动作 + 后果/疑问（本地 240 本书名归纳），10–16 字，口语、冲突前置
//   ④ 简介三段式：身份+困境（具体数字）→ 金手指/反差 → 情绪承诺留钩；末句必须是未解决的冲突
//   ⑤ 平台规则自检：不剧透结局、不用隐喻象征、不碰真实人名品牌、不与榜单书重名
//   ⑥ 封面提示词：给 AI 生图用，主体+场景+色调+构图，竖版 3:4，留出书名位置，不让生图模型写字
//   ⑦ 试读评审：另一个 agent 扮演「划手机的番茄读者」，对候选书名打点击意愿，挑出最好的一个（成对比不出来就给分）
//   ⑧ 可修改：用户可以直接改字段，也可以给一句意见让它重写
import fs from 'node:fs'
import path from 'node:path'
import { chat, parseJson } from './llm.mjs'
import * as S from './store.mjs'
import { webSearch, asContext } from './search.mjs'
import { resolveStyle, styleById, styleOfBook, DEFAULT_ID } from './styles.mjs'
import { normalizeMeta, flatTags, specForPrompt, audienceKey, emptyMeta } from './fanqie.mjs'

/** 本书的目标读者频道：已保存的作品信息优先，其次取创作风格的频道 */
export function audienceOfBook(book) {
  if (book?.package?.meta?.audience) return audienceKey(book.package.meta.audience)
  try { return styleOfBook(book).audience === 'female' ? 'female' : 'male' } catch { return 'male' }
}

const RANK_DIR = path.join(process.env.WORKSHOP_KNOWLEDGE || 'data\\knowledge', 'rank')
/** 番茄书名硬限制：15 个字符以内，标点也算（按 Unicode 字符数，不是 UTF-16 长度） */
export const TITLE_MAX = 15
export const titleLen = (t) => [...String(t || '')].length
const CAT_OF = { 'urban-naodong': ['都市脑洞', '都市日常', '都市高武'] }
/** 风格 → 榜单分类（多风格：都市脑洞仍取那三个分类，其余取自己的分类名） */
export function catsForStyle(sel) {
  const st = resolveStyle(sel)
  return styleById(st.id)?.rankCats || [st.label]
}

/** 最新一份榜单快照里、本书分类在读最高的书（书名+简介），没有数据时返回空数组 */
export function hitSamples(genre = 'urban-naodong', n = 12) {
  if (!fs.existsSync(RANK_DIR)) return []
  const f = fs.readdirSync(RANK_DIR).filter((x) => /^now-\d{8}\.jsonl$/.test(x)).sort().at(-1)
  if (!f) return []
  const cats = CAT_OF[genre] || catsForStyle({ id: genre })
  const seen = new Set(); const rows = []
  for (const l of fs.readFileSync(path.join(RANK_DIR, f), 'utf8').split('\n')) {
    if (!l.trim()) continue
    let x; try { x = JSON.parse(l) } catch { continue }
    if (x.band !== '男' || !cats.includes(x.cat) || seen.has(x.title)) continue
    seen.add(x.title); rows.push(x)
  }
  rows.sort((a, b) => (b.read || 0) - (a.read || 0))
  return rows.slice(0, n).map((x) => ({ title: x.title, cat: x.cat, mold: x.mold, read: x.read, abstract: String(x.abstract || '').replace(/\s+/g, ' ').slice(0, 160) }))
}

const SYS = `你是番茄小说男频的资深包装编辑，专门负责书名、简介和封面。你的唯一目标是让划手机的读者在 3 秒内点进来。
你的方法：先拆解当前在读最高的同类书名和简介的句式，再把本书最强的反差卖点套进去。拒绝文艺、隐喻、象征和空话。`

function bookFacts(id) {
  const book = S.readBook(id)
  const concept = S.readText(id, 'concept.md')
  const bible = S.readText(id, 'bible.md').slice(0, 5000)
  const chs = book.chapters.slice(0, 5).map((c) => `第${c.n}章 ${c.title}：${c.summary || ''}`).join('\n')
  const first = S.readText(id, 'chapters', S.pad(1) + '.txt').slice(0, 1200)
  return { book, concept, bible, chs, first }
}

/** 作者当前在选择器里已选的标签，整理成给 AI 的参考（只保留词表内的词；全空返回空串） */
function currentMetaText(cur, aud) {
  if (!cur) return ''
  const { meta } = normalizeMeta(cur, { audience: aud })
  const j = (a) => (a && a.length ? a.join('、') : '无')
  if (!meta.read.main && !flatTags(meta).length) return ''
  return `【作者当前已选的标签（请以此为基础：合理的保留，缺的补上，明显不贴的可以替换，并在 meta 里给出完整结果）】\n阅读标签：主分类 ${meta.read.main || '未选'}｜主题 ${j(meta.read.theme)}｜角色 ${j(meta.read.role)}｜情节 ${j(meta.read.plot)}\n内容标签：情节 ${j(meta.content.plot)}｜人设 ${j(meta.content.persona)}｜情感 ${j(meta.content.emotion)}｜世界观 ${j(meta.content.world)}\n`
}

function packagePrompt(id, instruction, web = '', currentMeta = null) {
  const { book, bible, chs, first } = bookFacts(id)
  const hits = hitSamples(book.genre)
  const cur = book.package || {}
  const aud = audienceOfBook(book)
  return `【本书当前书名】${book.title}
${cur.intro ? `【当前简介】\n${cur.intro}\n` : ''}
【设定集（节选）】
${bible}

【已写章节摘要】
${chs || '（还没有章节）'}

【第一章开头】
${first || '（还没有）'}

${web ? `【联网搜索到的近期同类爆款与书名讨论（仅作参考，可能有噪声）】\n${web}\n\n` : ''}【同分类在读最高的书（书名｜在读人数｜简介开头），这是你要对标的爆款】
${hits.map((h) => `${h.title}｜${h.read}｜${h.abstract}`).join('\n') || '（本地榜单库不可用，按你对番茄的了解）'}

${currentMetaText(currentMeta, aud)}${instruction ? `【作者的修改意见，必须优先满足】\n${instruction}\n` : ''}
任务：
1. 先用 3 条拆出上面爆款书名的共同句式（例："XX，我YY" / "让你XX，你YY？" / "XX后，我YY了"），每条带一个例子。
2. 提炼本书最能让人点进来的一个反差卖点（一句话）。
3. 给 5 个候选书名：每个必须在 15 个字以内（含逗号、问号等标点，平台硬限制，超过一个字就不能用），建议 10–15 字，口语化，冲突/反差前置，至少 2 个用疑问或反问句式；不能与上面的书重名，不用隐喻象征，不剧透结局。每个写一句为什么能抓人。写完自己逐个数一遍字数。
4. 给推荐书名的简介：200–300 字，三段式（身份+困境，带具体数字 → 金手指/反差 → 情绪承诺），最后一句必须是没解决的冲突或悬念；开头可加一个【标签+标签】（参考爆款写法）。
5. 按下面「番茄真实选项」给出本书的完整作品信息 meta：目标读者 audience（本书是 ${aud === 'female' ? 'female（女频）' : 'male（男频）'}）；签约模式 signMode（serial 连载 / complete 完本，默认 serial）；阅读标签 read（主分类 main 必须 1 个，主题 theme / 角色 role / 情节 plot 各不超过 2 个）；内容标签 content（情节 plot + 人设 persona 合计不超过 4 个，情感 emotion 不超过 2 个，世界观 world 不超过 1 个）；主角名 heroes（1–2 个，每个不超过 5 个字，取设定集里真实的主角名）。所有标签词必须逐字取自下面的词表，宁缺毋滥，找不到贴切的词就少选，不许自造。
${specForPrompt(aud)}
6. 封面 AI 生图提示词：中文一版、英文一版。写清 主体人物（外形、动作、表情）+ 场景道具（体现本书设定）+ 色调光线 + 构图（竖版 3:4，人物居中偏下，上方 1/3 留空给书名）+ 画风（国漫厚涂/写实电影感 二选一）；明确写"画面中不要出现任何文字"。再给一行负面提示词。

只输出 JSON，不要别的：
{"patterns":["..."],"sellingPoint":"...","titles":[{"title":"...","why":"..."}],"recommend":0,"intro":"...","meta":{"audience":"male","signMode":"serial","read":{"main":"...","theme":["..."],"role":["..."],"plot":["..."]},"content":{"plot":["..."],"emotion":["..."],"persona":["..."],"world":["..."]},"heroes":["..."]},"coverPrompt":{"zh":"...","en":"...","negative":"..."}}`
}

/** 读者试读人格。都市脑洞（或没传风格）时与旧 READER_SYS 逐字相同 */
export function readerSystem(label = '都市脑洞') {
  if ((label || '都市脑洞') === '都市脑洞') return `你是一个每天在番茄小说刷 2 小时的男读者，25 岁，爱看都市脑洞、系统、搞笑。你在书城列表里只看书名，3 秒决定点不点。说真话，不客气。`
  const st = resolveStyle(label)
  return st.audience === 'female'
    ? `你是一个每天在番茄小说刷 2 小时的女读者，24 岁，爱看${label}。你在书城列表里只看书名，3 秒决定点不点。说真话，不客气。`
    : `你是一个每天在番茄小说刷 2 小时的男读者，25 岁，爱看${label}。你在书城列表里只看书名，3 秒决定点不点。说真话，不客气。`
}

/** 读者试读：给每个候选书名打点击意愿（0–100） */
async function readerVote(titles, styleLabel = '都市脑洞') {
  const user = `下面是书城列表里刷到的书名，给每个打一个"我会点进去"的意愿分 0–100，并用一句话说原因。
${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

只输出 JSON：{"votes":[{"i":1,"score":0,"why":"..."}]}`
  const r = await chat({ task: 'packageJudge', system: readerSystem(styleLabel), user, temperature: 0.3, maxTokens: 3000, json: true, tag: 'package-vote' })
  const j = parseJson(r.content)
  return { votes: Array.isArray(j.votes) ? j.votes : [], cost: r.cost }
}

/** 生成（或按意见重写）包装方案，结果存 book.json 的 package 字段与 package.json（含全部候选与历史） */
export async function generatePackage(id, instruction = '', { onStep = () => {}, currentMeta = null } = {}) {
  onStep('联网搜索同类爆款书名与简介写法')
  const book0 = S.readBook(id)
  const label0 = resolveStyle({ id: book0.genre, custom: book0.styleCustom }).label
  const web = asContext([...(await webSearch(`番茄小说 ${label0} 爆款 书名 2026`, { max: 5 })), ...(await webSearch(`番茄小说 ${(book0.title || '').slice(0, 8)} 同类 简介`, { max: 4 }))])
  onStep('包装编辑拆爆款、起书名、写简介')
  const r = await chat({ task: 'package', system: SYS, user: packagePrompt(id, instruction, web, currentMeta), temperature: 0.85, maxTokens: 6000, json: true, tag: 'package' })
  S.addCost(id, r.cost)
  const p = parseJson(r.content)
  const titles = (Array.isArray(p.titles) ? p.titles : []).map((t) => (typeof t === 'string' ? { title: t, why: '' } : t)).filter((t) => t?.title).map((t) => ({ ...t, title: String(t.title).replace(/[《》]/g, '').trim() }))
  if (!titles.length) throw new Error('包装编辑没有给出书名候选，请重试')
  // 番茄书名上限 15 字（含标点）：超长候选直接剔除，一个都不剩就报错让用户重试，不把超长书名推给用户
  const tooLong = titles.filter((t) => titleLen(t.title) > TITLE_MAX)
  if (tooLong.length) {
    onStep(`剔除 ${tooLong.length} 个超过 ${TITLE_MAX} 字的书名候选`)
    for (let i = titles.length - 1; i >= 0; i--) if (titleLen(titles[i].title) > TITLE_MAX) titles.splice(i, 1)
    if (!titles.length) throw new Error(`包装编辑给出的书名全都超过 ${TITLE_MAX} 字（番茄上限，含标点），请重试`)
    p.recommend = 0
  }
  let pick = Math.min(titles.length - 1, Math.max(0, Number(p.recommend) || 0))
  let voteErr = ''
  try {
    onStep('读者试读：给候选书名打点击意愿')
    const v = await readerVote(titles.map((t) => t.title), label0 === DEFAULT_ID ? '都市脑洞' : label0); S.addCost(id, v.cost)
    for (const x of v.votes) { const t = titles[Number(x.i) - 1]; if (t) { t.score = Number(x.score) || 0; t.readerWhy = x.why || '' } }
    const best = titles.reduce((b, t, i) => ((t.score ?? -1) > (titles[b].score ?? -1) ? i : b), pick)
    pick = best
  } catch (e) { voteErr = e.message }
  // 作品信息：只认番茄真实词表里的词，非法词/超量丢弃并记录（AI 偶尔会自造标签）
  const aud = audienceOfBook(book0)
  const nm = normalizeMeta(p.meta || {}, { audience: aud, base: { audience: aud } })
  if (!nm.meta.heroes.length) { try { const { protagonists } = await import('./delivery.mjs'); nm.meta.heroes = protagonists(S.bookPath(id)) } catch { /* 取不到主角名就留空，交给用户填 */ } }
  const result = {
    at: new Date().toISOString(), instruction, patterns: p.patterns || [], sellingPoint: p.sellingPoint || '', titles, recommend: pick,
    intro: String(p.intro || '').trim(), meta: nm.meta, metaProblems: nm.problems, tags: flatTags(nm.meta), coverPrompt: p.coverPrompt || {}, voteError: voteErr, cost: r.cost,
  }
  const hist = S.readJson(id, 'package.json', { history: [] })
  hist.history = [...(hist.history || []), result].slice(-20)
  hist.latest = result
  S.writeText(id, 'package.json', JSON.stringify(hist, null, 2))
  return result
}

/** 用户采用 / 手动修改：书名、简介、标签、封面提示词。书名只改显示名，不改目录（目录是书的编号） */
export function applyPackage(id, { title, intro, tags, meta, coverPrompt } = {}) {
  const book = S.readBook(id)
  const pkg = { ...(book.package || {}) }
  if (typeof title === 'string' && title.trim()) {
    const t = title.replace(/[《》]/g, '').trim()
    if (titleLen(t) < 4) throw new Error('书名太短')
    if (titleLen(t) > TITLE_MAX) throw new Error(`书名 ${titleLen(t)} 个字，超过番茄 ${TITLE_MAX} 字的上限（标点也算），请缩短 ${titleLen(t) - TITLE_MAX} 个字`)
    if (t !== book.title) pkg.titleHistory = [...(pkg.titleHistory || []), book.title].slice(-20)
    book.title = t
  }
  if (typeof intro === 'string') pkg.intro = intro.trim().slice(0, 1200)
  if (meta && typeof meta === 'object') {
    // 用户保存：严格校验，不符合番茄规则就报错，让他自己改（不偷偷丢词）
    const nm = normalizeMeta(meta, { audience: audienceOfBook(book), strict: true })
    pkg.meta = nm.meta
    pkg.tags = flatTags(nm.meta)
  } else if (Array.isArray(tags)) pkg.tags = tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 6) // 旧调用兼容：自由标签
  if (coverPrompt && typeof coverPrompt === 'object') pkg.coverPrompt = { zh: String(coverPrompt.zh || ''), en: String(coverPrompt.en || ''), negative: String(coverPrompt.negative || '') }
  pkg.updatedAt = new Date().toISOString()
  book.package = pkg
  S.saveBook(book)
  return book
}

/** 新书第一次打开时，用开书方案里自带的简介兜底（不花钱） */
export function introFromConcept(id) {
  const c = S.readText(id, 'concept.md')
  const m = c.match(/简介[:：]\s*([\s\S]*?)(?=\n(?:风格|书名|一句话脑洞)[:：]|$)/)
  return m ? m[1].trim() : ''
}

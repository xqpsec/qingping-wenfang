// styles.mjs —— 多创作风格：内置「都市脑洞」规则文件 + 31 张开源风格卡 + 作者自定义风格
//
// 风格卡来源：https://github.com/zenstory-ai/oh-story-claudecode （MIT）
//   路径 skills/story-long-write/references/genre-prose-cards/*.md，已复制到 projects/genres/cards/
//   同目录 ATTRIBUTION.md 附来源与 LICENSE 全文。
//
// 兼容性硬约束：老书 book.genre === 'urban-naodong' 必须仍得到「都市脑洞」，
//   且 styleRules(都市脑洞) 与旧 genreRules('urban-naodong') 逐字相同（回归测试盯着这条）。
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './llm.mjs'

export const DEFAULT_ID = 'urban-naodong'
export const CARDS_DIR = path.join(ROOT, 'projects', 'genres', 'cards')
const GENRES_DIR = path.join(ROOT, 'projects', 'genres')

/** featured 的 8 个：按这个顺序排在最前（番茄在推的男频/女频主力题材） */
const FEATURED = ['urban-naodong', '都市高武', '玄幻脑洞', '悬疑灵异', '豪门总裁', '现言脑洞', '古言脑洞', '科幻末世']

/** female 风格（卡片文件名）。其余归 male。双男主也走女频读者口径。 */
const FEMALE = new Set(['豪门总裁', '青春甜宠', '古言脑洞', '宫斗宅斗', '现言脑洞', '玄幻言情', '民国言情', '职场婚恋', '女频悬疑', '女频种田', '星光璀璨', '古风世情', '快穿', '年代', '双男主'])

/** tagline：给小白看的一句话读者承诺（≤16 字）。取自各卡片「## 正文提示词」首句的概括。 */
const TAGLINE = {
  'urban-naodong': '小人物拿到怪设定，越用越麻烦',
  '都市高武': '城市照常运转，武力值暗地里升',
  '玄幻脑洞': '烂大街设定玩出反常的用法',
  '悬疑灵异': '一件怪事，越查越离不开身',
  '豪门总裁': '权力不对等里，把关系谈成赢局',
  '现言脑洞': '都市日常里，撞上一件不合常理',
  '古言脑洞': '古代深宅里，用现代脑子破局',
  '科幻末世': '文明塌了，人还得想办法活下去',
  '东方仙侠': '凡人出身，把登天这条路走穿',
  '传统玄幻': '从最低处起，一层层往上打',
  '历史古代': '乱世里站队，一步错就是死',
  '历史脑洞': '带着怪设定回到某个朝代',
  '双男主': '两个男人之间，爱得要命也守着底线',
  '古风世情': '深宅时代里，把体面和情爱算清',
  '女频悬疑': '身边人不对劲，真相一层层剥开',
  '女频种田': '穷家小院，一件件挣出好日子',
  '宫斗宅斗': '后院没有硝烟，每一步都要活命',
  '年代': '旧年月里，靠双手把日子翻身',
  '快穿': '一关一关换身份，每关都得赢',
  '悬疑脑洞': '怪设定悬在头顶，真相藏在后面',
  '战神赘婿': '被人看轻的上门女婿，身份一亮',
  '抗战谍战': '两边都是刀口，说错一句就死',
  '星光璀璨': '娱乐圈名利场里挣一个位置',
  '民国言情': '乱世里的爱，浪漫也带着身不由己',
  '游戏体育': '赛场和副本里，靠赢一场场说话',
  '玄幻言情': '修真路上，爱和成道只能选一个',
  '职场婚恋': '公司和生活里，把选择权拿回来',
  '西方奇幻': '异世界冒险，规则怪但要讲得通',
  '都市修真': '地铁写字楼底下，另有修行一界',
  '都市日常': '普通日子里，把小事写得好笑',
  '都市种田': '在城里一点点把生活过起来',
  '青春甜宠': '校园心动，甜到让人想谈恋爱',
}

/** 从卡片文件读标题（frontmatter 的 genre，没有就取正文提示卡标题，再没有就用文件名） */
function cardLabel(file) {
  try {
    const raw = fs.readFileSync(path.join(CARDS_DIR, file), 'utf8')
    const m = raw.match(/^genre:\s*(.+)$/m)
    return (m ? m[1].trim() : '') || file.replace(/\.md$/, '')
  } catch { return file.replace(/\.md$/, '') }
}

/** 非都市脑洞的 31 个：id 就是中文文件名本身（排除 ATTRIBUTION 等非风格文件） */
const CARD_STYLES = fs.existsSync(CARDS_DIR)
  ? fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith('.md') && f !== 'ATTRIBUTION.md').sort().map((f) => f.replace(/\.md$/, '')).filter((n) => n !== '都市脑洞')
  : []

const base = (id) => ({
  id,
  label: id,
  audience: FEMALE.has(id) ? 'female' : 'male',
  featured: FEATURED.includes(id),
  tagline: TAGLINE[id] || '',
  rankCats: [id],
})

const URBAN = { id: DEFAULT_ID, label: '都市脑洞', audience: 'male', featured: true, tagline: TAGLINE['urban-naodong'], rankCats: ['都市脑洞', '都市日常', '都市高武'] }

/** 全部 32 个风格：featured 8 个按 FEATURED 顺序排最前，其余按文件名序 */
export const STYLES = [
  URBAN,
  ...FEATURED.filter((x) => x !== DEFAULT_ID).map((id) => base(id)),
  ...CARD_STYLES.filter((id) => !FEATURED.includes(id)).map((id) => base(id)),
]

const BY_ID = new Map(STYLES.map((s) => [s.id, s]))

/** 风格卡是否存在（找不到就退回都市脑洞，不让整条链路崩） */
export const hasCard = (label) => fs.existsSync(path.join(CARDS_DIR, `${label}.md`))

/**
 * 统一入口：sel 可以是 {id, custom} / 字符串 id / 空。
 * 未知或空 → 都市脑洞；id==='custom' → 自定义风格（custom 去首尾空白、截断 200 字，为空则回退都市脑洞）。
 */
export function resolveStyle(sel) {
  const obj = sel && typeof sel === 'object' ? sel : { id: sel }
  const id = String(obj.id ?? obj ?? '').trim()
  if (id === 'custom') {
    const custom = String(obj.custom ?? '').trim().slice(0, 200)
    // label 带上作者原话（截 40 字）：评审/写手/读者投票的提示词都用 label，只写「自定义风格」时评审不知道该按什么标准打分（2026-10-02 端到端实测发现）
    if (custom) return { id: 'custom', label: `自定义：${custom.slice(0, 40)}`, audience: 'male', custom }
  }
  const s = BY_ID.get(id)
  if (s) return { id: s.id, label: s.label, audience: s.audience, custom: '' }
  return { id: DEFAULT_ID, label: '都市脑洞', audience: 'male', custom: '' }
}

/** 从书对象取风格（老书 genre='urban-naodong' 必须仍得到都市脑洞） */
export function styleOfBook(book) {
  return resolveStyle({ id: book?.genre, custom: book?.styleCustom })
}

export function styleById(id) { return BY_ID.get(String(id || '')) || null }

const stripFrontmatter = (raw) => String(raw).replace(/^---[\s\S]*?---\s*/, '').trim()

/**
 * 风格规则文本（直接进 prompt）：
 *   都市脑洞 → 原 projects/genres/urban-naodong.md（与旧 genreRules 逐字相同）
 *   卡片风格 → cards/<label>.md，去掉 frontmatter 与「## 证据摘要」及之后的内容
 *   自定义   → 按作者原话写
 */
export function styleRules(style) {
  const st = typeof style === 'string' ? resolveStyle(style) : (style || resolveStyle())
  if (st.id === DEFAULT_ID && typeof style !== 'object') {
    return stripFrontmatter(fs.readFileSync(path.join(GENRES_DIR, `${DEFAULT_ID}.md`), 'utf8'))
  }
  if (st.id === DEFAULT_ID) return stripFrontmatter(fs.readFileSync(path.join(GENRES_DIR, `${DEFAULT_ID}.md`), 'utf8'))
  if (st.id === 'custom') {
    return `## 作者指定风格\n${st.custom}\n\n请严格按这个风格写：人物、场景、冲突、爽点和语气都服从它；它没说到的地方按番茄网文通用写法（开头 3 句进冲突、每章有兑现、章末留钩子）。`
  }
  const f = path.join(CARDS_DIR, `${st.label}.md`)
  if (!fs.existsSync(f)) return stripFrontmatter(fs.readFileSync(path.join(GENRES_DIR, `${DEFAULT_ID}.md`), 'utf8'))
  const raw = stripFrontmatter(fs.readFileSync(f, 'utf8'))
  // 卡片末尾的「## 证据摘要」是抽样统计（给维护者看的），不进 prompt
  const cut = raw.search(/^##\s*证据摘要/m)
  return (cut >= 0 ? raw.slice(0, cut) : raw).trim()
}

/** 给前端的精简列表 */
export function publicStyles() {
  return STYLES.map((s) => ({ id: s.id, label: s.label, tagline: s.tagline, featured: s.featured, audience: s.audience }))
}

import fs from 'node:fs'
import path from 'node:path'
import { styleOfBook } from './styles.mjs'
import { LIMITS as FQ_LIMITS, normalizeMeta, metaGaps, AUDIENCE_LABEL, signModeLabel, audienceKey } from './fanqie.mjs'

// 番茄「创建作品」页的字段限制（2026-10-04 真人闸门只读抓取：书本名称 ≤15，主角名 ≤5，作品简介 50–500）
export const FIELD_LIMITS = { title: FQ_LIMITS.title, intro: FQ_LIMITS.introMax, introMin: FQ_LIMITS.introMin, hero: FQ_LIMITS.hero }
const len = (s) => [...String(s || '')].length

/** 主角名：优先取角色卡里角色定位含「主角/男主/女主」的，其次取设定集里「主角：XXX」。最多 2 个，每个 ≤5 字 */
export function protagonists(source) {
  const ok = (n) => n && len(n) >= 1 && len(n) <= FIELD_LIMITS.hero
  const names = []
  const add = (n) => { n = String(n || '').trim(); if (ok(n) && !names.includes(n)) names.push(n) }
  try {
    const card = JSON.parse(fs.readFileSync(path.join(source, 'character-card.json'), 'utf8'))
    const list = Array.isArray(card.characters) ? card.characters : []
    for (const c of list) if (/主角|男主|女主|主人公/.test(String(c.role || ''))) add(c.name)
    if (!names.length && list[0]) add(list[0].name)
  } catch { /* 没有角色卡 */ }
  if (!names.length) {
    for (const f of ['bible.md', 'concept.md']) {
      try {
        const m = fs.readFileSync(path.join(source, f), 'utf8').match(/(?:主角|男主|主人公)[：:]\s*([\u4e00-\u9fa5·A-Za-z]{1,5})/)
        if (m) { add(m[1]); break }
      } catch { /* 没有该文件 */ }
    }
  }
  return names.slice(0, 2)
}

export function deliverBook(source, destination, { penName = '' } = {}) {
  const book = JSON.parse(fs.readFileSync(path.join(source, 'book.json'), 'utf8'))
  const pkg = book.package || {}
  const rows = [...(book.chapters || [])].sort((a, b) => a.n - b.n)
  const parts = rows.map(c => ({ n: c.n, text: fs.readFileSync(path.join(source, 'chapters', String(c.n).padStart(4, '0') + '.txt'), 'utf8').trim() }))
  if (!parts.length || parts.some(p => !p.text)) throw new Error('没有完整正文可交付')
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error('成果目录非空，保留已有成果')
  const stage = destination + '.preparing'
  if (fs.existsSync(stage)) throw new Error('成果正在整理，请稍后重试')
  fs.mkdirSync(stage, { recursive: true })
  try {
    const put = (name, text) => { const f = path.join(stage, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, 'utf8'); if (fs.readFileSync(f, 'utf8') !== text) throw new Error('成果校验失败') }
    put('全书正文.txt', parts.map(p => p.text).join('\n\n\n') + '\n')
    for (const p of parts) put(path.join('分章正文', String(p.n).padStart(4, '0') + '.txt'), p.text + '\n')
    const concept = fs.existsSync(path.join(source, 'concept.md')) ? fs.readFileSync(path.join(source, 'concept.md'), 'utf8') : ''
    const intro = pkg.intro || concept.match(/简介[:：]\s*([\s\S]*?)(?=\n(?:风格|书名|一句话脑洞)[:：]|$)/)?.[1]?.trim() || ''
    const cover = pkg.cover?.file
    let hasCover = false
    if (cover && path.basename(cover) === cover && /\.(png|jpe?g|webp)$/i.test(cover)) {
      const src = path.join(source, 'covers', cover)
      if (fs.existsSync(src)) { const dst = path.join(stage, '最终封面' + path.extname(cover)); fs.copyFileSync(src, dst); if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) throw new Error('封面校验失败'); hasCover = true }
    }
    let styleAud = 'male'
    try { styleAud = styleOfBook(book).audience === 'female' ? 'female' : 'male' } catch { /* 取不到就默认男频 */ }
    // 作品信息：优先用书里保存的结构化 meta（已按番茄词表校验）；老书没有 meta 时只给主角名与频道，标签请真人在页面里选
    const { meta } = normalizeMeta(pkg.meta || {}, { audience: styleAud })
    const hasMeta = !!pkg.meta
    const heroes = meta.heroes.length ? meta.heroes : protagonists(source)
    const audience = AUDIENCE_LABEL(meta.audience)
    const titleN = len(book.title), introN = len(intro)
    const readLine = (g) => (g && g.length ? g.join('、') : '（无）')
    const gaps = hasMeta ? metaGaps(meta, intro) : ['作品信息（阅读标签/内容标签）还没确认：请先在工坊「书名·简介·封面」里选好并保存']
    const missing = [
      !intro && '简介未设置',
      intro && introN > FIELD_LIMITS.intro && `简介 ${introN} 字，超过番茄 ${FIELD_LIMITS.intro} 字上限，请删减`,
      intro && introN < FIELD_LIMITS.introMin && `简介 ${introN} 字，番茄要求至少 ${FIELD_LIMITS.introMin} 字`,
      ...gaps.filter((g) => !/简介/.test(g) && !/主角名/.test(g)),
      !penName && '笔名待你填写',
      !hasCover && '最终封面尚未生成',
      titleN > FIELD_LIMITS.title && `书名 ${titleN} 字，超过番茄 ${FIELD_LIMITS.title} 字上限，请在网页修改`,
      !heroes.length && '没有找到主角名，请按书里的主角自己填',
    ].filter(Boolean)
    // 按番茄「创建作品」页从上到下的顺序排，逐项复制即可。阅读标签/内容标签是页面里的选择器，这里只给方向，不冒充页面上的选项。
    const sheet = [
      '【番茄小说 · 创建作品 填写单】按页面从上到下的顺序，逐项复制粘贴',
      '',
      `1. 书本名称（必填，页面上限 ${FIELD_LIMITS.title} 字，含标点）`,
      `   ${book.title}`,
      `   当前 ${titleN}/${FIELD_LIMITS.title} 字 ${titleN <= FIELD_LIMITS.title ? '✓' : '✗ 超了'}`,
      '',
      `2. 签约模式（必填，创建后不能改）：${signModeLabel(meta.signMode)}`,
      '',
      `3. 目标读者：${audience}`,
      '',
      ...(hasMeta ? [
        '4. 阅读标签（点页面「阅读标签」弹窗，按下面的原词勾选；签约后不能改）',
        `   主分类（必选 1 个）：${meta.read.main || '（还没选）'}`,
        `   主题（最多 2 个）：${readLine(meta.read.theme)}`,
        `   角色（最多 2 个）：${readLine(meta.read.role)}`,
        `   情节（最多 2 个）：${readLine(meta.read.plot)}`,
        '',
        '5. 内容标签（点页面「内容标签」弹窗，按下面的原词勾选）',
        `   情节：${readLine(meta.content.plot)}`,
        `   人设：${readLine(meta.content.persona)}`,
        `   情感（最多 2 个）：${readLine(meta.content.emotion)}`,
        `   世界观（最多 1 个）：${readLine(meta.content.world)}`,
      ] : [
        '4. 阅读标签：还没确认。请先在工坊「书名·简介·封面」里选好并保存，再重新整理成果',
        ...((pkg.tags || []).length ? [`   （这本书是旧版本生成的自由标签：${pkg.tags.map(String).filter(Boolean).join('、')}。它们不一定在番茄词表里，只作参考）`] : []),
        '',
        '5. 内容标签：同上',
      ]),
      '',
      `6. 主角名（每个上限 ${FIELD_LIMITS.hero} 字）`,
      `   主角名1：${heroes[0] || '（请自己填）'}`,
      `   主角名2：${heroes[1] || '（没有可不填）'}`,
      '',
      `7. 作品简介（页面要求 ${FIELD_LIMITS.introMin}–${FIELD_LIMITS.intro} 字；当前 ${introN} 字 ${introN >= FIELD_LIMITS.introMin && introN <= FIELD_LIMITS.intro ? '✓' : introN ? '✗ 字数不合规' : ''}）`,
      intro || '待完善',
      '',
      `8. 封面：${hasCover ? '同目录「最终封面」图片，点页面上的「选择封面」上传' : '尚未生成'}`,
      '',
      `笔名：${penName || '待填写'}（作家账号用的笔名，封面上已按它排版）`,
      `正文：全书正文.txt（整本），分章正文\\ 文件夹（一章一个文件）；共 ${parts.length} 章`,
      '',
      missing.length ? '上传前待处理：\n' + missing.map(x => '  - ' + x).join('\n') : '书名、简介、封面、主角名都已备齐，请你最终检查后上传。',
      'AI 申报由你按实际情况填写，本工具不会自动发布。',
      '',
    ].join('\n')
    put('番茄填写单.txt', sheet)
    put('简介.txt', (intro || '待完善') + '\n')
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true })
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw e
  }
  fs.renameSync(stage, destination)
  return { directory: destination, chapters: parts.length }
}

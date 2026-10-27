// live.mjs —— 开书等待过程的「实时看板」（2026-10-03）
// 把流式生成的半截文本变成用户看得懂的进度：步骤、思维摘要、设定卡片、已排章纲。纯函数、零依赖、零成本（不额外调模型）。
// 用户在 一位内测用户 开书时等了 10 分钟只看到一行「约 3 分钟」，原话「我都快等睡着了」。

/** 开书的固定步骤（界面步骤条用） */
export const START_STEPS = [
  { id: 'read', label: '读你的想法' },
  { id: 'bible', label: '搭世界观' },
  { id: 'outline', label: '排前 10 章' },
  { id: 'done', label: '完成' },
]

// 思维摘要里不该给用户看的句子：提到提示词/指令/模型身份/格式要求的「幕后话」
// 2026-10-03 真实网关 e2e：漏出过「用户要的是把开书方案扩写成…」→「用户」一律算幕后话
// 第二轮 e2e 又漏出「注意：书名…」「相邻不重复即可。」「这些要具体写出来。」「如果内容太长可以，手机阅读？」——都是在复述写作要求
const BACKSTAGE = /提示词|prompt|system|指令|系统提示|用户|格式|markdown|字数|token|我是|作为(一个)?(AI|助手|模型)|模型|供应商|服务商|不要提及|助手|^注意|即可[。！]?$|写出来|要求|手机阅读|内容太长|输出/i
const clean = (s) => String(s || '').replace(/[*#`>|_]+/g, '').replace(/^\s*[-•·]\s*/, '').replace(/\s+/g, ' ').trim()
// 碎片：以数字/标点开头（表格行、半截括号），或汉字太少（「10 信息遮断」「3《必送单》7字」）
// 括号不配对（半截引用）、以字母编号开头（「SS级：」列表项）也算碎片
const fragment = (s) => /^[\dA-Za-z)）」”"'、，,.:：;；!！?？-]/.test(s) || (s.match(/[\u4e00-\u9fa5]/g) || []).length < 6
  || (s.match(/[（(]/g) || []).length !== (s.match(/[）)]/g) || []).length

/**
 * 从思考流里取「最近一句完整的话」做思维摘要（≤42 字）。没有完整句子就返回空，界面保持上一句。
 * 优先取最后一句；它若是幕后话就往前找。
 */
export function thoughtOf(reasoning) {
  const tail = String(reasoning || '').slice(-1200)
  const sents = tail.split(/(?<=[。！？!?\n])/).map(clean).filter((s) => s.length >= 6)
  // 最后一段可能还没写完（没有句号结尾）：丢掉
  if (sents.length && !/[。！？!?]$/.test(sents.at(-1)) && !/\n$/.test(tail)) sents.pop()
  for (let i = sents.length - 1; i >= 0 && i >= sents.length - 6; i--) {
    const s = sents[i]
    if (BACKSTAGE.test(s) || fragment(s)) continue
    return s.length > 42 ? s.slice(0, 41) + '…' : s
  }
  return ''
}

// 标题前缀：「## 二、主角」「### 3. 反派」都认
const H = String.raw`^#{2,4}\s*(?:[一二三四五六七八九十]+[、.]|\d+[.、])?\s*`
// 某个标题之后第一行「像内容」的文字（跳过空行、表格行、纯标点行）
function afterHeading(t, words) {
  const m = new RegExp(H + `(?:${words})[^\\n]*\\n([\\s\\S]{0,600})`, 'm').exec(t)
  if (!m) return ''
  return m[1].split('\n').map(clean).find((l) => l.length >= 2 && !/^[|:：-]/.test(l) && !/^#/.test(l)) || ''
}
const nameOf = (line) => clean(line).replace(/^(主角|反派|姓名)[:：]\s*/, '').split(/[，,。（(:：\s]/)[0].slice(0, 12)

/**
 * 设定集半成品（或开书方案）→ 卡片字段：金手指、规则、主角、配角、反派。
 * 2026-10-03 真实设定集格式很杂：「### 金手指：天罚契约」「## 一、核心设定：讨债系统」「金手指：任意一份…」「## 二、主角」+「**陈默，32岁…**」都要认。
 */
export function bibleCard(text) {
  const t = String(text || '')
  const card = {}
  const gf = t.match(/金手指[:：]\s*\**([^\n]{2,80})/) || t.match(new RegExp(H + '核心设定[:：]\\s*([^\\n]{2,30})', 'm'))
  if (gf) { const v = clean(gf[1]); card.cheat = v.split(/[——。，,（(；;:：]/)[0].slice(0, 16) }
  const rule = t.match(/(?:一句话规则|用法|规则)\**[:：]\s*([^\n]{4,})/); if (rule) card.cheatRule = clean(rule[1]).slice(0, 60)
  // 主角：优先「主角：xxx」行（开书方案格式），其次「## 主角」标题下第一行
  const hl = (t.match(/^\**主角\**[:：]\s*([^\n]+)/m) || [])[1] || afterHeading(t, '主角')
  if (hl) { const line = clean(hl); const n = nameOf(line); if (n.length >= 2) card.hero = n; if (/[，,]/.test(line)) card.heroLine = line.slice(0, 60) }
  // 配角：「**1. 苏晚，34岁」「**1. 老周（周建国）**」
  const sides = [...t.matchAll(/^\**\s*\d+\s*[.、]\s*\**([^，,。*（(\n:：]{1,10})[，,（(*:：]/gm)].map((m) => clean(m[1])).filter((s) => s.length >= 2 && s !== card.hero)
  if (sides.length) card.cast = [...new Set(sides)].slice(0, 6)
  const vl = (t.match(/^\**反派\**[:：]\s*([^\n]+)/m) || [])[1] || afterHeading(t, '反派|对手|主要敌人')
  // 反派行常是「1. 马哥，催收员」列表：去掉编号再取名；名字里至少要有两个汉字（挡掉「1.」这类残片）
  if (vl) { const n = nameOf(String(vl).replace(/^\s*\d+\s*[.、]\s*/, '')); if ((n.match(/[\u4e00-\u9fa5]/g) || []).length >= 2 && !/^(谁|想要|阻力)/.test(n)) card.villain = n }
  card.sections = [...t.matchAll(/^#{2,3}\s*(.+)$/gm)].map((m) => clean(m[1]).slice(0, 16)).filter((s) => !/设定集$/.test(s)).slice(-8)
  return card
}

/** 正在写的小节（没有思考流的模型，用它当「正在琢磨：…」） */
export function currentSection(text) {
  const hs = [...String(text || '').matchAll(/^#{2,4}\s*(.+)$/gm)]
  return hs.length ? clean(hs.at(-1)[1]).slice(0, 24) : ''
}

/** 章纲半成品 → 已完整的行（章号 + 标题），只认字段齐全的行，和 pipeline.outlineRows 同口径 */
export function outlineDone(text, from = 1) {
  return String(text || '').split('\n').map((l) => l.trim().replace(/^第?(\d+)章?\s*[|｜]/, '$1|').replace(/｜/g, '|'))
    .filter((l) => /^\d+\|/.test(l) && l.split('|').length >= 8 && l.split('|')[7].trim().length > 4)
    .map((l) => { const f = l.split('|'); return { n: Number(f[0]), title: clean(f[1]).slice(0, 18) } })
    .filter((r) => r.n >= from)
}

/**
 * 进度追踪器：pipeline 每收到一次增量就调 feed()，内部按 intervalMs 节流后调用 emit(live)。
 * live 是给界面的最小 JSON：{ step, steps, pct, think, card, chapters, switched, eta }
 */
// bibleChars / outlineChars：一次设定集 / 10 章章纲大约生成多少字（思考折算后），按 2026-10-03 e2e 实测量级取
export function makeTracker(emit, { intervalMs = 1500, bibleChars = 6000, outlineChars = 9000, outlineTotal = 10, now = () => Date.now() } = {}) {
  const live = { step: 'read', steps: START_STEPS.map((s) => s.label), pct: 2, think: '', card: {}, chapters: [], outlineTotal, switched: false }
  let last = 0, thinkAt = 0
  const push = (force) => { const t = now(); if (!force && t - last < intervalMs) return; last = t; try { emit(structuredClone(live)) } catch { /* 界面回调出错不影响生成 */ } }
  return {
    live,
    phase(step, extra = {}) { Object.assign(live, { step, ...extra }); if (step === 'bible') live.pct = Math.max(live.pct, 5); if (step === 'outline') live.pct = Math.max(live.pct, 45); if (step === 'done') live.pct = 100; push(true) },
    setCard(card) { live.card = { ...live.card, ...card }; push(true) },
    feed({ content = '', reasoning = '', switched = false } = {}) {
      if (switched) { live.switched = true; push(true); return }
      // 进度按「已生成字数（思考 + 正文）」估：2026-10-03 真实 e2e 里模型先思考 30–55 秒才出正文，只看正文进度条会停住不动。
      // 思考字数打 6 折（思考不一定用满），封顶留余量：没写完不显示到头；百分比只增不减
      const gen = content.length + 0.6 * reasoning.length
      if (live.step === 'bible') {
        const card = bibleCard(content)
        live.card = { ...live.card, ...Object.fromEntries(Object.entries(card).filter(([, v]) => v && (!Array.isArray(v) || v.length))) }
        live.pct = Math.max(live.pct, Math.min(44, 5 + Math.round(39 * Math.min(1, gen / bibleChars))))
      } else if (live.step === 'outline') {
        const rows = outlineDone(content, live.outlineFrom || 1)
        live.chapters = rows.slice(0, outlineTotal)
        // 章纲：行数是真进度；行还没出来时按字数走到 80%
        const frac = Math.max(rows.length / outlineTotal, 0.8 * Math.min(1, gen / outlineChars))
        live.pct = Math.max(live.pct, Math.min(99, 45 + Math.round(54 * Math.min(1, frac))))
      }
      // 思维摘要每 3 秒最多换一句，太快用户读不过来
      const t = now()
      if (t - thinkAt >= 3000) {
        const th = thoughtOf(reasoning) || (content ? (currentSection(content) ? '正在写：' + currentSection(content) : '') : '')
        if (th && th !== live.think) { live.think = th; thinkAt = t }
      }
      push(false)
    },
  }
}

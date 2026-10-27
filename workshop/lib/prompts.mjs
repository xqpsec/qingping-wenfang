// prompts.mjs —— 各角色提示词。规则来源：projects/genres/urban-naodong.md + 拆书 A/B + RESEARCH-v01 三份调研
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './llm.mjs'
import { styleRules, resolveStyle, DEFAULT_ID } from './styles.mjs'
import { voiceConceptLine } from './voices.mjs'

// 文风（voices.mjs）：替换开书方案/设定集里「吐槽流 或 白描流」二选一那一行；voice 为空或 auto 时原样返回（逐字不变）
const OLD_STYLE_LINE = '风格：吐槽流 或 白描流（社交/直播/综艺/系统题选吐槽流）'
export function withVoiceConcept(prompt, voice) {
  const line = voiceConceptLine(voice)
  return line ? prompt.replace(OLD_STYLE_LINE, line) : prompt
}

export function genreRules(genreId = 'urban-naodong') {
  const f = path.join(ROOT, 'projects', 'genres', `${genreId}.md`)
  const raw = fs.readFileSync(f, 'utf8')
  return raw.replace(/^---[\s\S]*?---\s*/, '').trim()
}

export const HOOK_TYPES = ['决定', '发现', '误判', '代价', '动作截断', '信息遮断']
export const PAYOFF_TYPES = ['反差打脸', '识破谎言', '身份揭晓', '金手指荒诞效果', '旁观者破防', '以小博大', '吐槽名场面', '收获落袋', '装傻反杀', '信息差碾压']

const ARCHITECT_SYS = (label) => `你是番茄小说${label === '都市脑洞' ? '男频「都市脑洞」频道' : `男频「${label}」频道`}的王牌主编，带出过多本在读榜前十。你懂番茄读者：下沉、手机阅读、3 秒决定去留、${label === '都市脑洞' ? '要爽要笑要反差' : '要情绪、要冲突、要兑现'}。你设计的东西必须具体、有画面、一句话能复述，拒绝空泛和文艺。`

/** 主编人格。都市脑洞时与旧 SYS_ARCHITECT 逐字相同（回归测试盯着这条） */
export function architectSystem(label = '都市脑洞') { return ARCHITECT_SYS(label || '都市脑洞') }

export const SYS_ARCHITECT = architectSystem('都市脑洞')

export function conceptPrompt(idea, hitTitles, style) {
  const st = resolveStyle(style)
  const hits = Array.isArray(hitTitles) ? hitTitles : []
  const label = st.label
  // 都市脑洞（或没传风格）：与旧输出逐字相同
  if (st.id === DEFAULT_ID) {
    return `${idea ? `作者的想法：${idea}\n\n` : '作者没有想法，请你按当前榜单趋势自由发挥。\n\n'}当前番茄男频都市脑洞榜单书名（参考命名套路和热门母题，不要照抄）：
${hits.join('、')}

请设计 3 个差异明显的开书方案。每个方案必须满足：
- 脑洞 = 日常身份 × 反常元素，一句话能讲给朋友听，且设定本身会不断制造麻烦和笑点（不是单纯"主角很牛"）
- 金手指必须有代价或限制（榜单系统流 13/13 都有坑）
- 主角低起点，开局处境具体到数字
- 书名必须在 15 个字以内（含标点，平台硬限制），建议 10–15 字，口语化、反常理、冲突前置（参考榜单句式："XX，我YY" / "让你XX，你YY？" / "XX后，我YY了"）

严格按以下格式输出 3 个方案，方案之间用一行 ==== 分隔，不要输出别的：
书名：
一句话脑洞：
脑洞公式：日常身份 × 反常元素
主角：姓名、年龄、身份、开局处境（含具体数字）
金手指：是什么、怎么用、代价或限制
核心冲突：设定本身会反复制造什么麻烦
爽点来源：读者主要爽在哪（3 条）
前三章承诺：第1章入局发生什么 / 第2章加压 / 第3章兑现一个大爽点并抛出更大的坑
简介：250–350 字，三段式（身份+困境 → 金手指/反差 → 情绪承诺留钩）
风格：吐槽流 或 白描流（社交/直播/综艺/系统题选吐槽流）`
  }
  // 其他风格：通用版（去掉都市脑洞专属的「日常身份 × 反常元素 / 系统流 / 脑洞公式」话术）
  const customNote = st.id === 'custom' ? `作者指定的风格：${st.custom}\n（下面的方案必须完全长在这个风格上：人物、场景、冲突、爽点、语气都服从它）\n\n` : ''
  const hitLine = hits.length ? `当前番茄「${label}」榜单书名（参考命名套路和热门母题，不要照抄）：\n${hits.join('、')}\n\n` : ''
  return `${customNote}${idea ? `作者的想法：${idea}\n\n` : '作者没有想法，请你按当前榜单趋势自由发挥。\n\n'}${hitLine}请设计 3 个差异明显的开书方案。写的是「${label}」，每个方案必须满足：
- 核心卖点一句话能讲给朋友听，且会持续制造冲突
- 若有金手指/特殊设定必须有代价；没有就写无
- 主角开局处境具体（最好到数字），起点低但不窝囊
- 书名必须在 15 个字以内（含标点，平台硬限制），建议 10–15 字，口语化、反常理、冲突前置（参考榜单句式："XX，我YY" / "让你XX，你YY？" / "XX后，我YY了"）

严格按以下格式输出 3 个方案，方案之间用一行 ==== 分隔，不要输出别的：
书名：
一句话卖点：
主角：姓名、年龄、身份、开局处境（含具体数字）
核心设定：是什么、怎么用、代价或限制
核心冲突：设定本身会反复制造什么麻烦
爽点来源：读者主要爽在哪（3 条）
前三章承诺：第1章入局发生什么 / 第2章加压 / 第3章兑现一个大爽点并抛出更大的坑
简介：250–350 字，三段式（身份+困境 → 反差/情绪 → 情绪承诺留钩）
风格：吐槽流 或 白描流（社交/直播/综艺/系统题选吐槽流）`
}


export function biblePrompt(concept) {
  return `下面是选定的开书方案：
${concept}

请把它扩写成全书设定集（后续每章写作都会带着它），要求具体、可执行，不写空话：

## 核心设定
（金手指的完整规则：触发条件、效果、代价、限制、成长方式，前期/中期/后期各能做到什么。规则要让读者一句话能复述）
## 主角
（姓名、年龄、外形一句、性格关键词3个、说话方式和口头禅、欲望、软肋、开局处境与数字）
## 主要配角（4–6 人）
（每人：姓名、身份、和主角的关系、功能（推剧情/衬托/制造冲突）、一个记忆点：外形反差/口头禅/小癖好）
## 反派与阻力（前 30 章）
（每个：是谁、想要什么、为什么和主角撞上、会怎么被打脸）
## 世界与现实锚点
（城市、地点、行业细节、物价、时间，越具体越好）
## 长线主线
（全书主目标，分 3 个阶段，每个阶段的目标、主要冲突、阶段高潮）
## 文风要求
（吐槽流/白描流，叙述人称，语感示例 2 句）`
}

/** 设定集 prompt + 文风：auto 时与 biblePrompt 逐字相同 */
export function biblePromptV(concept, voice) {
  const base = biblePrompt(concept)
  const line = voiceConceptLine(voice)
  if (!line) return base
  const label = line.replace(/^风格：/, '').replace(/（.*$/, '')
  return base.replace('（吐槽流/白描流，叙述人称，语感示例 2 句）', `（作者指定文风：${label}。写出叙述人称、句子长短、对白多少，并给 2 句符合「${label}」的语感示例）`)
}

export function outlinePrompt(bible, from, to, prevOutline) {
  return `全书设定：
${bible}

${prevOutline ? `已有细纲（最后几章）：\n${prevOutline}\n\n` : ''}请写第 ${from}–${to} 章的章纲（节拍表）。番茄节奏要求：
- 每章至少 1 个小爽点；每 3 章一个中爽点；第 3 章必须有一个大爽点（黄金三章：1 入局 → 2 加压 → 3 兑现并抛出更大的坑，三章共享同一个核心问题）
- 压抑最长不超过 2 章；高潮后一章写余波（旁人反应、收获落袋）
- 爽点类型轮换，可选：${PAYOFF_TYPES.join('、')}
- 章末钩子类型轮换，相邻两章不能相同，可选：${HOOK_TYPES.join('、')}
- 每章都要推进主线或人物关系，不许原地踏步

每章严格一行，用 | 分隔 8 个字段，不要表头，不要别的文字：
章号|章名(4-12字,有冲突感)|本章目标|压(主角被什么具体地压着)|扬(主角怎么具体地解决/反转)|爽点类型|章末钩子类型|章末最后一幕(具体画面或一句话)`
}

export function planPrompt({ bible, outlineRow, recap, prevTail, chapterNo, openHooks }) {
  return `全书设定：
${bible}

前情摘要：
${recap || '（这是第一章）'}

${prevTail ? `上一章结尾原文：\n${prevTail}\n\n` : ''}未回收的伏笔/悬念：${openHooks || '无'}

本章（第 ${chapterNo} 章）章纲：${outlineRow}

请把本章拆成 4–6 个场景节拍，写作者照着就能写。每个节拍一行：
节拍序号. 场景（地点+人物）｜发生什么（具体动作/对白要点）｜读者情绪（紧张/憋屈/好笑/爽/好奇）｜约多少字
最后一行写：章末最后三行要落在：（具体写出最后一幕）
全章约 2500 字。第一个节拍必须在开头 3 句内进入冲突或怪事${chapterNo === 1 ? '，前 300 字内让读者看到本书的脑洞' : '，直接承接上一章结尾，不要回顾前情'}。`
}

export function writerSystem(genreText, label = '都市脑洞') {
  const urban = (label || '都市脑洞') === '都市脑洞'
  return `你是番茄小说${urban ? '男频都市脑洞频道' : `「${label}」频道`}的签约大神作者，你的书常年在读榜前十。你写的是给手机读者看的网文，不是文学作品。

${genreText}

## 输出格式（硬性要求）
- 第一行：第N章 章名
- 正文每段之间空一行；一段只说一件事，大多数段 1–3 句
- 对白用中文双引号“”，标点全部用中文全角标点，不要出现英文逗号、英文引号
- 不要任何 Markdown 符号（不要 #、*、-、>），不要写"本章完"、作者的话、小标题
- 正文 2400–2900 个汉字，不能少于 2300 字

## ${urban ? '文体硬指标（本地 39 本番茄都市脑洞爆款第一章的实测中位数，照这个写）' : '文体参考指标（网文通用；与上面风格要求冲突时以风格要求为准）'}
- 每段平均约 24 个字，绝大多数段 10–35 字；超过 80 字的段落全章最多 2 个
- 全章约 100–120 段
- 对白约占全文 20%，全章至少 30 句对白；第一句对白在开头 150 字内出现
- 句子平均 20 字左右，长短交错
- 每千字约 5 个感叹号、6 个问号（吐槽、反问、惊呼要有）
- 章末 200 字内要有一个问号或悬而未决的动作
- 不要重复前文已经写过的句子或段落，结尾不要把前面的台词原样再写一遍
- 数字、距离、时间前后必须一致`
}

export function characterCardText(card) {
  const rows = (card?.characters || []).filter((x) => x?.name).map((x) => [
    `人物：${x.name}${x.role ? `｜身份：${x.role}` : ''}`,
    x.goal ? `目标：${x.goal}` : '', x.traits ? `性格：${x.traits}` : '', x.behavior ? `行为模式：${x.behavior}` : '',
    x.bottomLine ? `底线：${x.bottomLine}` : '', x.weakness ? `弱点：${x.weakness}` : '', x.relation ? `关系：${x.relation}` : '',
    x.decisionPriority ? `决策优先级：${x.decisionPriority}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
  return rows || '（作者还没有填写人物卡；不要擅自给核心人物增加与前文冲突的性格或动机。）'
}

// 情绪浓度（2026-10-03 用户原话「第一章没有激情，很平淡」）：作者按书选，默认「稳」= 不加任何东西
export const HEAT_LEVELS = {
  calm: { label: '稳', desc: '按原样写，节奏平稳' },
  hot: { label: '燃', desc: '冲突更早、情绪更满' },
  blast: { label: '炸', desc: '开局即高潮，章章有爆点' },
}
export function heatBlock(level, chapterNo = 2) {
  if (level === 'hot') return `【情绪浓度：燃】（作者要求：不要写得平淡）
- 开头 3 句内必须出现冲突、危机或反常，不要用环境描写、回忆、起床开场
- 主角每次受压都要有明确的情绪反应（憋屈、愤怒、不甘），并在本章内至少反击一次
- 至少 1 处高情绪对白：一句话把矛盾挑破，或一句让对方当场噎住的狠话
- 删掉一切过渡和寒暄，每 300 字内必须有一个推进或小反转
${chapterNo === 1 ? '- 这是第一章：前 500 字内让读者知道主角最大的困境或最大的底牌\n' : ''}- 情绪要靠动作、对白和他人反应写出来，不要用形容词和感叹句堆砌

`
  if (level === 'blast') return `【情绪浓度：炸】（作者要求：要强刺激、高能）
- 第一句就是冲突现场或惊人事实，直接把读者扔进最紧张的时刻
- 本章至少 2 个情绪爆点（打脸、反转、身份揭露、狠话对决），爆点必须有围观者或对手的反应放大
- 主角憋屈不超过 500 字，之后必须翻盘或亮出底牌
- 对白要锋利，允许针锋相对、阴阳怪气；关键台词单独成段
${chapterNo === 1 ? '- 这是第一章：开篇 300 字内必须出现一个让人非看下去不可的钩子\n' : ''}- 章末停在最高张力处（危机刚爆发或底牌刚亮一半）；不要用形容词和感叹号硬凑高潮，靠事件本身

`
  return ''
}

// memeText：lib/memes.mjs 的 memeBlock() 产出；为空时 prompt 与旧版逐字相同（回归测试盯着）
// heatText：heatBlock() 产出；为空时同样逐字不变
export function writerPrompt({ bible, characterCard, plan, recap, prevTail, chapterNo, outlineRow, anchors, memeText = '', heatText = '', voiceText = '', deticText = '' }) {
  return `【全书设定】
${bible}

【人物事实卡（优先于临时发挥）】
${characterCardText(characterCard)}

【人物一致性硬规则】
- 人物行动必须符合目标、行为模式、底线和决策优先级；剧情需要不能单独成为动机。
- 如确需改变性格或立场，必须在正文中写出触发事件和渐进过程，不能突然转弯。
- 不要为了制造冲突让主角无理由犯蠢、失忆或违背底线。

【前情摘要】
${recap || '（这是第一章）'}
${prevTail ? `\n【上一章结尾原文（紧接着往下写）】\n${prevTail}\n` : ''}
【本章章纲】${outlineRow}

【本章节拍】
${plan}

${anchors.length ? `【语感参考：番茄在读榜爆款原文片段】（只学它的口语感、节奏、段落长短、对白比例和吐槽方式；绝对不要照抄句子、人名、情节）\n${anchors.map((a, i) => `——片段${i + 1}——\n${a}`).join('\n')}\n\n` : ''}${voiceText}${memeText}${heatText}${deticText}现在写第 ${chapterNo} 章正文。记住：开头 3 句进冲突；每一段都在推进；爽点要有旁人反应放大；最后三行让读者非点下一章不可；2400–2900 字。`
}

export function fixPrompt({ bible, recap, prevTail, text }) {
  return `【全书设定（节选）】
${bible.slice(0, 5000)}

【前情摘要】${recap || '（第一章）'}
${prevTail ? `【上一章结尾】\n${prevTail}\n` : ''}
【待查章节】
${text}

只找会让读者出戏的硬伤：
1. 本章内部前后矛盾（数字、距离、时间、人物位置、谁说了什么）
2. 与设定或前文矛盾（人名、身份、规则、已发生的事）
3. 同一句话或同一段内容重复出现
4. 明显的错别字、病句

每个问题输出一行，格式严格为：
原句：<从正文逐字复制的一小段，10–40 字，必须能在正文里原样找到> => 改为：<修改后的这一小段>
要删除重复内容就写 => 改为：（留空）
只列真正要改的句子；没问题的句子一律不要列出来。
「改为」后面只能是要替换进正文的小说文字，禁止出现任何括号批注或说明（如「（无问题，保留）」「（注：…）」「（需核对）」），这些字会被原样印进正文。
整章都没有问题就只输出：无
不要输出任何解释。`
}

export function summaryPrompt(text, chapterNo) {
  return `下面是小说第 ${chapterNo} 章正文。请提取后续写作需要记住的信息，严格按格式输出：
摘要：（150 字内，写清发生了什么、结果如何）
人物变化：（谁的状态/关系/认知变了，一行一个）
新增事实：（新出现的设定、物品、数字、地点、承诺，一行一个）
未回收悬念：（本章留下或仍未解决的悬念，一行一个）
爽点类型：（本章主要爽点属于哪类）
章末钩子类型：（决定/发现/误判/代价/动作截断/信息遮断 之一）

正文：
${text}`
}

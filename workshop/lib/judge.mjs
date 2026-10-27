// judge.mjs —— LLM 评审（便宜模型），两种用法：
//   rubricJudge(text)       绝对打分：10 个维度，1–10 分，每项必须引原文作证据
//   pairJudge(a, b)         成对比较：双向换序各判一次，只有两次一致才算胜，否则平局
// 依据：memory/RESEARCH-v01-小说评判体系-20260930.md（窄维度+锚点、只喂纯正文、成对为主、分差近才换序）
import { chat, parseJson } from './llm.mjs'
import { stripHeading, stripMeta } from './metrics.mjs'

export const DIMS = [
  ['hook_open', '开篇抓力', '前500字是否出现具体主角+具体处境+违反常理的事或当面冲突，且主角当场有反应。1=前800字还在铺环境/讲设定；5=有处境但异常出现得晚；10=第一段就让人想问"为什么"'],
  ['conflict', '冲突与压迫', '主角是否被具体的人/事压着（丢钱、丢脸、丢命、丢机会），压力是否具体可感。1=没人为难主角；5=有压力但抽象；10=压力具体到数字/物件/当众场面'],
  ['payoff', '爽点兑现', '压抑是否在本章被主角用具体行动释放，且方式出乎意料又合理，有旁人反应放大。1=全章无释放；5=有释放但平淡或靠运气；10=打脸/反转让人想拍大腿，旁观者反应到位'],
  ['novelty', '脑洞新鲜度', '核心设定是否新鲜、能一句话复述、且设定本身制造冲突。1=烂大街设定无变体；5=熟悉外壳+小变体；10=一听就想看，设定天然产生麻烦和笑点'],
  ['protagonist', '主角魅力', '主角是否有鲜明性格、主动做选择、说话有意思，让人想代入或想看他怎么办。1=被动工具人；5=能用但没记忆点；10=有独特态度和口吻，一句话就立住'],
  ['density', '节奏与信息密度', '每一段是否都在推进（新信息/新障碍/新选择），有没有重复、说教、总结、心理分析废话。1=大段水/解释；5=偶有拖沓；10=没有一句可删'],
  ['dialogue', '对白与画面', '对白是否有性格、有潜台词、推动剧情；描写是否具体可见（物件、动作、数字）而非形容词。1=对白搬运信息/形容词堆砌；10=对白能听出是谁说的，画面像镜头'],
  ['humor', '网文味/口语感', '是否是番茄读者爱看的口语化、接地气、有梗有吐槽的语感，而非文学腔、翻译腔或AI腔。1=像作文或AI；5=通顺但寡淡；10=读着顺嘴、有笑点、有情绪'],
  ['logic', '逻辑与可信', '人物动机、行为、设定是否自洽，反派是否降智，现实细节是否可信。1=明显硬伤；10=无硬伤且细节增强可信度'],
  ['cliff', '章末追读欲', '看完最后三行，读者是不是必须立刻点下一章。1=自然结束可以关掉；5=有点好奇；10=悬念+代价同时压上，不点难受'],
]

/** 评审人格。都市脑洞时与旧 SYS 逐字相同（回归测试盯着这条） */
// label 可带文风后缀「题材｜文风：冷峻克制」（pipeline 用 judgeLabel 拼）；不带后缀时与旧版逐字相同
export const VOICE_SEP = '｜文风：'
export function judgeSystem(label = '都市脑洞') {
  const [base, voice] = String(label || '都市脑洞').split(VOICE_SEP)
  label = base || '都市脑洞'
  const urban = label === '都市脑洞'
  return `你是番茄小说${urban ? '男频都市脑洞频道' : `「${label}」频道`}的资深签约编辑，也是一个每天读 50 本新书、手指随时准备划走的老读者。
你只关心一件事：这章能不能留住番茄读者、让他们追下去。你不看文笔是否优美，只看好不好看、爽不爽、想不想往下读。${urban ? '' : `
按「${label}」读者的期待打分，不要拿都市脑洞的标准（脑洞、吐槽、系统）去要求其他题材。`}
你打分很严格：番茄榜单前十的爆款首章大约 7–8 分，普通签约书 5–6 分，AI 味重、寡淡、太文学的稿子 3–4 分。不要客气。${voice ? `
作者指定了「${voice}」文风：「网文味」和对白按这个文风的标准评，不要因为它不搞笑、不热血就扣分；但寡淡、拖沓照样扣。` : ''}`
}

const SYS = judgeSystem('都市脑洞')

function clip(text, n = 9000) {
  const t = stripHeading(stripMeta(text))
  return t.length > n ? t.slice(0, n) + '\n……（后略）' : t
}

export async function rubricJudge(text, opts = {}) {
  const { chapterNo = 1, context = '', styleLabel = '都市脑洞' } = opts
  const dims = DIMS.map(([k, n, d]) => `- ${k}（${n}）：${d}`).join('\n')
  const user = `${context ? `【前情提要】${context}\n\n` : ''}【待评章节：第${chapterNo}章】
${clip(text)}

先用 3–5 句话写你作为读者的真实阅读感受（哪里想划走、哪里被抓住）。然后严格按下面的行格式输出，每行一项，不要用 JSON，不要用引号：
${DIMS.map(([k]) => `${k}=分数|一句理由`).join('\n')}
read_next=0到100的整数|100个番茄读者看完这章有多少人会点下一章
best=本章最好的一处
worst=本章最伤追读的一处问题
fix1=最能提升追读的修改建议（具体到哪一段改成什么样）
fix2=...
fix3=...

维度说明：
${dims}`
  const r = await chat({ ...(opts.role ? { role: opts.role } : { task: 'rubric' }), system: judgeSystem(styleLabel), user, temperature: 0.2, maxTokens: 8000, tag: 'judge-rubric' })
  return { ...parseRubric(r.content), cost: r.cost, raw: r.content }
}

export function parseRubric(s) {
  const get = (k) => { const m = String(s).match(new RegExp(`^\\s*[-*]?\\s*${k}\\s*[=＝:：]\\s*(.+)$`, 'm')); return m ? m[1].trim() : '' }
  const scores = {}
  let sum = 0; let n = 0
  for (const [k] of DIMS) {
    const v = get(k); const m = v.match(/(\d+(?:\.\d+)?)/)
    if (m) { const sc = Math.min(10, Number(m[1])); scores[k] = { s: sc, why: v.split(/[|｜]/).slice(1).join('|').trim() }; sum += sc; n++ }
  }
  if (n < 6) throw new Error('评审输出无法解析：' + String(s).slice(0, 120))
  const avg = sum / n
  const readNext = Number((get('read_next').match(/\d+/) || [0])[0])
  const total = Math.round(avg * 7 + readNext * 0.3)
  return { total, avg: +avg.toFixed(2), readNext, scores, best: get('best'), worst: get('worst'), fixes: [get('fix1'), get('fix2'), get('fix3')].filter(Boolean) }
}

async function onePair(first, second, context, sameBook = true, styleLabel = '都市脑洞') {
  const user = `${context ? `【前情提要】${context}\n\n` : ''}${sameBook ? '下面是同一本书同一章的两个版本。' : '下面是两本不同小说的第一章。'}你是番茄读者，只能选一个读下去。
【版本甲】
${clip(first, 6000)}

【版本乙】
${clip(second, 6000)}

比较：开篇抓不抓人、爽点够不够、主角有没有魅力、有没有水、对白好不好看、章末想不想点下一章。字数长短不是优点。
先用两三句说理由，最后一行严格写：结论=甲 或 结论=乙，再加 |1到3（1=差不多，3=明显更好）。例：结论=乙|2`
  const r = await chat({ ...(PAIR_ROLE ? { role: PAIR_ROLE } : { task: 'pair' }), system: judgeSystem(styleLabel), user, temperature: 0.1, maxTokens: 6000, tag: 'judge-pair' })
  const clean = String(r.content).replace(/[*_`#>【】\[\]（）()「」“”"]/g, '')
  const all = [...clean.matchAll(/结论\s*[=＝:：]?\s*(?:版本)?\s*([甲乙])\s*(?:[|｜/，,\s]\s*(\d))?/g)]
  let m = all[all.length - 1]
  if (!m) { const tail = clean.slice(-60); const t = [...tail.matchAll(/(?:选|胜|赢|更好)[^甲乙]{0,4}(?:版本)?([甲乙])|([甲乙])(?:版本)?\s*(?:胜|更好|赢)/g)].pop(); if (t) m = [t[0], t[1] || t[2]] }
  if (!m) throw new Error('成对评审无法解析：' + clean.slice(-80))
  return { winner: m[1] === '乙' ? 1 : 0, margin: Number(m[2]) || 1, reason: clean.replace(/结论[\s\S]*$/, '').trim().slice(0, 200), cost: r.cost }
}
// 留空 = 按界面上「成对择优评审」的分配；校准脚本可用 setPairRole 临时指定 agent
export let PAIR_ROLE = ''
export function setPairRole(r) { PAIR_ROLE = r }

/** 双向换序：返回 {winner: 0|1|-1(平), reasons} */
export async function pairJudge(a, b, { context = '', sameBook = true, styleLabel = '都市脑洞' } = {}) {
  const [x, y] = await Promise.all([onePair(a, b, context, sameBook, styleLabel), onePair(b, a, context, sameBook, styleLabel)])
  const w1 = x.winner; const w2 = 1 - y.winner // 第二次换序后映射回原编号
  const cost = x.cost + y.cost
  // raw：两次各自的结论（按原编号 0=a 1=b），给 judge-audit 统计「先出场的版本是否更容易赢」
  const raw = [w1, w2]
  if (w1 === w2) return { winner: w1, margin: Math.min(x.margin, y.margin), reasons: [x.reason, y.reason], cost, raw }
  return { winner: -1, margin: 0, reasons: [x.reason, y.reason], cost, raw }
}

// tics.mjs —— 「AI 腔」口癖检测 + 定点改写补丁（零 token 检测；改写只送被标出的句子）
//
// 依据（2026-10-04，全部可复算）：
//   ① workshop/tic-compare.mjs：番茄 5 个男频脑洞分类 119 章爆款 vs 我方 23 章，每千汉字口癖密度。
//      差距最大的几项：「两秒/三秒」计时停顿 爆款中位 0 / 我方 2.37；「盯着…看」0 / 0.61；「没说话」0 / 0.94；
//      「很轻/很淡」0 / 0.44；全章感叹号 爆款 6.09 / 我方 0；语气词 3.08 / 1.65。
//   ② oh-story-claudecode（MIT）story-deslop 的 blocking 规则：不是…是…、是…不是…、破折号、否定排比、章尾预告/总结。
//      规则来源：公开的「去 AI 味」写作经验整理（不随仓库提供）
//   ③ 外部口径（经济观察报 2026-07-04 作者原话）：「大量短句、不是……而是……、过多破折号」是圈内公认 AI 文特征。
// 只扫引号外的叙述（台词按人物口吻，不机械改）；系统弹窗【…】整行跳过。
import { stripAnnot } from './annot.mjs'

const QUOTE = /“[^”\n]*”|「[^」\n]*」|【[^】\n]*】/g

/** 每条：id、名称、正则、每章允许保留几处（爆款 P90 折算到 2500 字，向下取整，最少 0）、改法提示 */
export const TIC_RULES = [
  { id: 'seconds', name: '计时停顿（看了两秒/过了三秒）', re: /(?:[一两二三四五六七八九十半几]|零点[一二三四五])秒/g, keep: 1, how: '删掉秒数，用一个具体动作或对方的反应代替停顿' },
  { id: 'stare', name: '凝视套话（盯着…看/盯着他）', re: /盯着[^，。！？\n]{0,10}(?:看了?[一两三半几]?[秒会]|没说话|没动)|(?:看|盯)了[一两三半几]?秒/g, keep: 0, how: '换成人物此刻真正在做的事或心里冒出的一句吐槽' },
  { id: 'silent', name: '沉默套话（没说话/没接话/没吭声）', re: /没(?:说话|接话|吭声|出声|作声|回答|接茬)/g, keep: 0, how: '写他做了什么（喝水、看手机、骂了一句），不要写他没做什么' },
  { id: 'pause', name: '停顿套话（顿了顿/愣了一下/沉默了）', re: /顿了顿|停顿了一下|愣了一下|怔了一下|沉默了(?:一会儿?|几秒|两秒)?/g, keep: 1, how: '删掉，或换成一个有信息量的反应' },
  { id: 'soft', name: '弱化状语（很轻/很淡/很平/很稳）', re: /(?:声音|语气|笑|说得?)?很(?:轻|淡|平|稳)(?=[。，])/g, keep: 0, how: '直接写他说了什么、怎么说的具体样子' },
  { id: 'notis', name: '否定-肯定对举（不是A，是B）', re: /不是[^，。！？\n“”]{1,14}[，,]\s*(?:而)?是[^，。！？\n“”]{1,16}/g, keep: 0, how: '直接说 B，删掉「不是 A」那一半' },
  { id: 'isnot', name: '反序对举（是A，不是B）', re: /(?<![不就也还只可但倒像若要])是[^，。！？\n“”]{1,12}[，,]\s*(?:而)?不是[^。！？\n“”]{1,16}/g, keep: 0, how: '只留肯定的那一半' },
  { id: 'dash', name: '破折号', re: /——/g, keep: 1, how: '改成逗号、句号或冒号，或拆成两句' },
  { id: 'negparade', name: '否定排比（没有X，没有Y）', re: /(?:没有[^。！？\n，]{1,12}，){2}/g, keep: 0, how: '写他有什么、做了什么' },
  { id: 'cliche', name: 'AI 套词（嘴角勾起/眼中闪过/一丝/深吸一口气）', re: /嘴角勾起|眼中闪过|眸光|指节泛白|深吸一口气|心头一震|一抹|一丝(?!不苟)|不易察觉|空气仿佛|命运的齿轮/g, keep: 0, how: '换成具体、口语的说法' },
]
// 章尾 600 字窗口专查（oh-story trailer-ending / trailer-summary）
export const TRAILER = /没人知道|谁也不知道|谁也没想到|殊不知|才刚刚开始|拉开(?:序幕|帷幕)|即将(?:开始|来临|降临)|这一(?:夜|天|刻)[^。！？\n]{0,6}注定|这一切[^。！？\n]{0,6}(?:意味着|说明)|新的(?:篇章|旅程|人生)[^。！？\n]{0,6}(?:开始|展开)/g

/** 去掉章名行，按句切分；返回 [{s, inNarr}]，台词与弹窗的句子 inNarr=false */
function sentences(text) {
  const body = String(text).replace(/\r/g, '').replace(/^\s*第[0-9一二三四五六七八九十百零]+章[^\n]*\n/, '')
  const out = []
  for (const line of body.split('\n')) {
    const l = line.trim(); if (!l) continue
    if (/^【[^】]*】$/.test(l)) continue
    for (const s of l.split(/(?<=[。！？…])(?![”」])/)) { const t = s.trim(); if (t) out.push(t) }
  }
  return out
}
const narr = (s) => s.replace(QUOTE, (m) => '\u3000'.repeat(m.length))

/** 统计 + 列出要改的句子（超过每章允许保留数的那部分；同一句命中多条只列一次） */
export function scanTics(text) {
  const sents = sentences(text)
  const han = (String(text).match(/[\u4e00-\u9fa5]/g) || []).length
  const counts = {}; const flagged = new Map()
  for (const r of TIC_RULES) {
    let seen = 0
    for (const s of sents) {
      const n = (narr(s).match(r.re) || []).length
      if (!n) continue
      counts[r.id] = (counts[r.id] || 0) + n
      seen += n
      if (seen > r.keep && s.length >= 6 && !flagged.has(s)) flagged.set(s, r)
    }
  }
  // 章尾窗口
  const tail = String(text).slice(-600)
  for (const s of sentences(tail)) if ((narr(s).match(TRAILER) || []).length) { counts.trailer = (counts.trailer || 0) + 1; if (!flagged.has(s)) flagged.set(s, { id: 'trailer', name: '章尾预告/总结腔', how: '用动作或对白收尾，删掉总结和预告' }) }
  // 情绪平：全章叙述+台词感叹号 0 且语气词极少（爆款中位 6.09 / 3.08 每千字）
  const k = Math.max(0.3, han / 1000)
  const exclaim = +(((String(text).match(/[！!]/g) || []).length) / k).toFixed(2)
  const particles = +(((String(text).match(/[啊呢吧嘛呗哈哟嘞咯]/g) || []).length) / k).toFixed(2)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { han, counts, total, perK: +(total / k).toFixed(2), exclaimPerK: exclaim, particlesPerK: particles, flat: exclaim < 1 && particles < 1.5, flagged: [...flagged].map(([s, r]) => ({ s, id: r.id, name: r.name, how: r.how })) }
}

/** 写手 prompt 附加段：把最常见的 AI 腔写成禁用清单（写之前就避开，比事后改便宜） */
export function deticBlock() {
  return `【去 AI 腔（硬性，编辑一眼看出 AI 写的就是这些）】
- 叙述里不要写「看了两秒」「过了三秒」「盯着他看」「没说话」「没接话」「顿了顿」「愣了一下」「声音很轻/很平」：人物停下来时写他具体做了什么，或心里冒出的一句话
- 不要写「不是A，是B」「是A，不是B」这种对举句，直接说B；破折号全章最多 1 个
- 不要「嘴角勾起」「眼中闪过」「一丝」「深吸一口气」这类套词；比喻用日常现成的说法，一章最多 3 个
- 主角性子再冷，配角、反派、围观的人也要有情绪：惊呼、骂人、抱怨、起哄，对白里要有「啊、吧、呢、嘛、卧槽、好家伙」这种口气，感叹号放在台词里
- 章尾停在动作、对白或刚冒出来的新麻烦上，不写总结、感悟和「没人知道……」式预告
- 删掉套话省下的字数，用来写具体动作、对白和配角反应；全章字数要求不变

`
}

/**
 * 安全应用定点改写：一句一句替换，原句必须是被标出的完整句（防止模型只抄半句导致后半句重复，2026-10-04 A/B 实测抓到）。
 * 替换后若段内出现 ≥6 字的紧邻重复片段，或改后句里含有替换点后方原文的开头，就放弃这一条。
 * 返回 { text, applied, rejected }
 */
export function applyDetic(text, flagged, patches) {
  const want = new Set(flagged.map((f) => f.s))
  const norm = (s) => s.replace(/\s/g, '')
  let t = String(text); let applied = 0; const rejected = []
  for (const p of patches) {
    const from = p.from.trim()
    const sent = [...want].find((s) => norm(s) === norm(from)) || [...want].find((s) => norm(s).startsWith(norm(from)) && norm(from).length >= norm(s).length * 0.8)
    if (!sent) { rejected.push({ ...p, why: '不是被标出的完整句' }); continue }
    const at = t.indexOf(sent); if (at < 0) { rejected.push({ ...p, why: '正文里找不到原句' }); continue }
    const isDel = /^[（(]?\s*(留空|删除|删去|空)?\s*[）)]?$/.test(p.to.trim())
    const to = isDel ? '' : stripAnnot(p.to).trim() // 剥审稿批注（2026-10-07 事故）
    if (!isDel && !to) { rejected.push({ ...p, why: '只有批注、没有改写' }); continue }
    const after = t.slice(at + sent.length, at + sent.length + 40)
    const nextHead = norm(after).slice(0, 8)
    if (to && nextHead.length >= 6 && norm(to).includes(nextHead)) { rejected.push({ ...p, why: '改后句吞进了后文，会重复' }); continue }
    const cand = t.slice(0, at) + to + t.slice(at + sent.length)
    const line = cand.slice(cand.lastIndexOf('\n', at) + 1, (cand.indexOf('\n', at) + 1 || cand.length + 1) - 1)
    if (/([\u4e00-\u9fa5，]{6,})\1/.test(line.replace(/\s/g, ''))) { rejected.push({ ...p, why: '替换后段内出现紧邻重复' }); continue }
    t = cand; applied++; want.delete(sent)
  }
  return { text: t, applied, rejected }
}

/** 定点改写 prompt：只给被标出的句子，要求逐句给出替换（复用 fix 的「原句=>改为」格式与 applyPatches） */
export function deticPrompt(text, flagged, { bible = '' } = {}) {
  const list = flagged.slice(0, 24).map((f, i) => `${i + 1}. 【${f.name}｜改法：${f.how}】原句：${f.s}`).join('\n')
  return `${bible ? `【人物与文风（节选）】\n${bible.slice(0, 1500)}\n\n` : ''}【本章正文】
${text}

下面这些句子是 AI 腔，编辑一眼就能看出来。请逐句改写成真人网文作者会写的样子：保留原句的信息和剧情作用，只换说法；口语、具体、带人物情绪；改后长度和原句差不多，不要扩写，不要新增情节。台词以外不要用破折号。
${list}

每句输出一行，格式严格为：
原句：<从上面逐字复制的原句> => 改为：<改写后的句子>
如果某句删掉也不影响剧情，可以写 => 改为：（留空）
「改为」后面只能是要替换进正文的小说文字，禁止出现任何括号批注或说明（如「（无问题，保留）」「（注：…）」），这些字会被原样印进正文。
不要输出任何解释。`
}

// annot.mjs —— 审稿批注泄漏检测与清除（零成本，纯正则）
// 事故（2026-10-07 主办方抓到）：逻辑自检 / 去 AI 腔两步让模型输出「原句：… => 改为：…」，
// 模型把没问题的句子也列出来，写成「改为：原句（无问题，保留）」，applyPatches 当成真修改写进了定稿正文。
// 这类括号批注一旦发表就是事故级，所以：①补丁应用前先剥掉 ②定稿前再兜底一次 ③体检把残留列为缺项。
//
// 判定只认审稿口吻，避免误伤正文里正常的括号（「（小声）」「（笑）」「（未完待续）」）：
//   a) 括号内以「注：」开头；或
//   b) 括号内全部由批注词和标点组成（无问题，保留 / 无矛盾 / 需核对 / 原文无问题）。

const PAREN = /[（(]([^（）()\n]{1,200})[）)]/g
const WORDS = /无问题|没有问题|没问题|无矛盾|没有矛盾|无硬伤|无错误|无需修改|无需改动|不需修改|不需要修改|不用改|保持原样|原样保留|保持不变|保留原句|保留原文|保留|需核对|需确认|待核对|待确认|已修正|已修改|已改正|前后一致|数值一致|与前文|与上文|与设定|与前章|一致|原文|原句|此句|该句|此处/g
const isAnnot = (inner) => {
  const s = inner.trim()
  if (/^注[:：]/.test(s)) return true
  if (!s.match(WORDS)) return false
  return s.replace(WORDS, '').replace(/[，,、；;。.:：\s]/g, '') === ''
}

/** 找出正文里的审稿批注，返回 [{ text, line }]（line 从 1 起） */
export function findAnnot(text) {
  const out = []
  String(text || '').split('\n').forEach((l, i) => {
    for (const m of l.matchAll(PAREN)) if (isAnnot(m[1])) out.push({ text: m[0], line: i + 1 })
  })
  return out
}

/** 剥掉审稿批注，并去掉剥完留下的行尾空白 */
export function stripAnnot(text) {
  return String(text || '').replace(PAREN, (m, inner) => (isAnnot(inner) ? '' : m)).replace(/[ \t\u3000]+$/gm, '')
}

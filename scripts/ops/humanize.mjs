// humanize.mjs —— 一键「过检测」改写流水线（零 token、零 API、零费用、永久脚本）
//
// ═══ 存在理由 ═══════════════════════════════════════════════════════════════
// 付费服务「降得快」能把中文改得更自然、降 AI 味，但每次调用都花钱、会改语义、
// 会动章节标题、会幻觉章号。2026-09-30 用它做了四档采样（level 1/4/5、v4.0），
// 逐句蒸馏出它到底改了什么，把**不改语义**的那部分固化成本脚本 —— 之后零成本。
//
// ═══ 蒸馏结论：服务做了什么（证据见 tmp/jdk/report-*.md）═════════════════════
//   ① 短句并长、节奏拉长      句均长 21.5→24.4，句长波动 15.4→17.4
//   ② 间接引语 → 直接引语     引号 26→72（三倍）← 检测器最显眼的信号
//   ③ 问句/叹号回填           问号 5→12，叹号 3→7
//   ④ 套路连接词删掉          逗号句号比下降
//   ⑤ 同义替换 + 扩写补全     汉字 2881→3323  ← 会改语义，**不抄**
//   ⑥ 改标题 / 幻觉章号 / 删整句 ← 有害，**剥离保护**
//
// ═══ ⚠ 2026-09-30 实测推翻的一条旧假设（朱雀读数为证）══════════════════════
//   旧假设：「把句均长拉上去、贴爆款画像（27.2/17.9%/3.0）就更像人」。
//   实测：这样改出来的稿子朱雀读 **人工 0% / 疑似AI 83.43% / AI 16.57%**，比原稿更像 AI。
//   真因：**参差是分布，不是均值**。句长分布实测——
//        原稿      sd=14.0（最长句 100、≤10字 21、≥35字 9）
//        只合并    sd=14.3，但短句比 24%→6% → 节奏变均匀 = AI 签名
//        切长句    sd=10.5（最长句 100→53）→ 把参差切没了，方向完全反了
//   ✅ 正确策略：**保住短句尾巴（≤10字不动）+ 只造长句（合并后 ≥35 字）+ 一刀不切**。
//   待补：端到端朱雀读数（额度耗尽未取）；改前先做「原稿 / 错版 / v3」三版对照。
//
// ═══ 流水线 ═════════════════════════════════════════════════════════════════
//   标题剥离（保护）→ R6 节奏整形（造长保短）→ R7 段落参差 → R8 间接引语直引化
//   → R1 套路词（仅句首）→ R2 主语省略 → R3 短断言缓冲 → R4 破整齐三连
//   → R5 半角标点 → 保真校验
//
// ═══ 不变量（每条都机器校验）═════════════════════════════════════════════════
//   · 标题一字不改
//   · 数字串、人名、既有引号内容零漂移
//   · 汉字只允许从「套路词白名单」里删；其余删除 = 拒绝写盘
//   · 幂等：T(T(x)) = T(x)
//
// ═══ 用法 ═══════════════════════════════════════════════════════════════════
//   node scripts/ops/humanize.mjs <文件>... [--apply] [--out 目录] [--report <路径>]
//   默认 dry-run 只打印前后指标；--apply 才写盘（写到 <原名>_humanized.<原扩展名>）
//   退出码：0 成功 · 5 保真校验失败（已拒绝写盘）
import fs from 'node:fs'
import path from 'node:path'

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const files = []
let outDir = '', reportPath = ''
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--out') { outDir = argv[++i]; continue }
  if (a === '--report') { reportPath = argv[++i]; continue }
  if (a === '--apply') continue
  if (a.startsWith('--')) continue
  files.push(a)
}
const apply = argv.includes('--apply')
// --skip r8,r6  /  --only r5 ：消融用。规则名 r1–r8（r6 含 r7 段落参差）
const listArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1].toLowerCase().split(',') : null }
const ONLY = listArg('--only'), SKIP = listArg('--skip') ?? []
for (const k of ['--only', '--skip']) { const i = argv.indexOf(k); if (i >= 0) files.splice(files.indexOf(argv[i + 1]), 1) }
const on = (r) => (ONLY ? ONLY.includes(r) : !SKIP.includes(r))
if (!files.length) { console.error('用法：humanize.mjs <文件>... [--apply] [--out 目录] [--report 路径]'); process.exit(2) }

const han = (t) => (t.match(/[\u4e00-\u9fff]/g) ?? []).length

// ── 套路词白名单（只有这些允许被删）────────────────────────────────────────
const CUES = [
  '然而', '因此', '与此同时', '毫无疑问', '值得一提的是', '事实上', '总之', '综上所述',
  '忽然间', '刹那间', '转瞬间', '此刻', '顿时', '瞬间',
]
// ── 人名（保真校验用；每本书按需扩充）─────────────────────────────────────
const NAMES = [
  '陈石', '周细', '贾通', '柳青禾', '董满', '马大柱', '顾三甲', '苏佩玖', '邢让', '柴老蔫',
  '林小满', '崔福生', '吴玉梅', '沈砚秋', '霍延', '许知行', '陈默', '张远', '苏婉', '林峰', '王浩', '李强',
]

// ═══ R6 短句并长（最大头：句均长 7–12 → 22–26）════════════════════════════
// 三级递进：先保守合并，若节奏仍碎片化再放宽，逐级逼近爆款画像
// （本地 60 个爆款首章实测：句均长 27.2 / 短句比 17.9% / 句长波动 20.1）
const MERGE_LEVELS = [[10, 40], [10, 55], [12, 68]]
function mergeOnce(text, MAX, SHORT) {
  const parts = text.split(/(?<=[。！？…”])/).filter((s) => s.length)
  const out = []
  let run = 0
  for (let i = 0; i < parts.length; i += 1) {
    let cur = parts[i]
    while (run < 2 && i + 1 < parts.length) {
      const next = parts[i + 1].trim()
      if (!next) break
      if (parts[i].includes('\n') || parts[i + 1].includes('\n')) break   // 不跨段落合并
      if (/^[“「"]/.test(next)) break            // 对话开头不并
      if (/[！？]$/.test(cur)) break              // 情绪/提问不并
      if (!/。$/.test(cur)) break                 // 只有句号能变逗号
      const n = han(next), c = han(cur)
      if (n === 0) break
      if (n <= 10) break                         // ★ 保住短句尾巴 —— 参差的一极
      if (n > 22) break                          // 不吞中长句
      if (c + n < 35) break                      // ★ 只造长句（≥35）—— 参差的另一极
      if (c + n > 70) break
      cur = cur.replace(/。$/, '，') + parts[i + 1]
      i += 1; run += 1
    }
    out.push(cur); run = 0
  }
  return out.join('')
}
// ═══ R6b 长句切分（只合并 = 节奏变均匀 = 更像 AI；必须配合切分制造参差）═══
// 判据：句长波动是唯一验证过的翻盘变量（0%→100% 那次靠的就是它）。
function splitLong(text) {
  return text.split(/(?<=[。！？…”])/).map((s) => {
    if (han(s) < 50) return s                       // 只切真正超长的
    if (!/[，,]/.test(s)) return s
    const tail = s.match(/[。！？…”]+$/)?.[0] ?? ''
    const body = s.slice(0, s.length - tail.length)
    const commas = [...body.matchAll(/[，,]/g)]
    if (commas.length < 2) return s
    // ★ 在约 72% 处切：留长句 + 短尾巴，两极化 → 标准差上升
    const target = body.length * 0.72
    let best = commas[0]
    for (const c of commas) if (Math.abs(c.index - target) < Math.abs(best.index - target)) best = c
    return body.slice(0, best.index) + '。' + body.slice(best.index + 1) + tail
  }).join('')
}

// ═══ R7 段落参差（段长波动同样是翻盘变量；原稿全是单句段 = 匀速病）═══════
// 确定性规则（保证幂等）：连续 3 个「单句且 ≤16 字」的段并成一段，随后跳过 2 段。
function varyParas(text) {
  const ps = text.split(/\n\s*\n/)
  const out = []
  let i = 0, skip = 0
  const isShort = (p) => {
    const t = p.trim()
    return t && !t.includes('\n') && han(t) <= 16 && t.split(/(?<=[。！？…])/).filter(Boolean).length === 1
  }
  while (i < ps.length) {
    if (skip > 0) { out.push(ps[i]); skip -= 1; i += 1; continue }
    if (isShort(ps[i]) && i + 2 < ps.length && isShort(ps[i + 1]) && isShort(ps[i + 2])) {
      out.push(ps[i].trim() + ps[i + 1].trim() + ps[i + 2].trim())
      i += 3; skip = 2
    } else { out.push(ps[i]); i += 1 }
  }
  return out.join('\n\n')
}

function rhythmMerge(text) {
  let cur = text
  for (const [SHORT, MAX] of MERGE_LEVELS) cur = mergeOnce(cur, MAX, SHORT)
  cur = varyParas(cur)
  return cur === text ? cur : rhythmMerge(cur)   // 迭代到稳定 = 幂等
}

// ═══ R8 间接引语 → 直接引语（引号暴增是检测器最显眼的信号）═══════════════
function directSpeech(text) {
  // 形态：…说/问/答/道/喊/叫 + 无引号内容 + 句末
  return text.replace(/(说|问道|问|答道|答|喊道|喊|叫道|叫|道)([^“”"。！？\n]{8,}?)([。！？])/g,
    (m, verb, body, end) => {
      if (/：“$/.test(verb)) return m
      // 问句补问号；答句补句号
      const close = (verb.includes('问') && end === '。') ? '？' : end
      return `${verb}：“${body}${close}”`
    })
}

// ═══ R1 套路词 ═════════════════════════════════════════════════════════════
// ⚠ 只删**句首连接语**，绝不删句中实词 —— 教训：把「碰到这股热流的瞬间」里的
//   「瞬间」删掉会变成「碰到这股热流的」，语法被删坏（2026-09-30 实测）。
//   判据：必须处于句/段起始或标点之后，且后面紧跟逗号。
function dropCues(text) {
  let t = text
  for (const w of CUES) {
    t = t.replace(new RegExp('(^|[。！？…”\\n])\\s*' + w + '[，,]?', 'g'), '$1')
  }
  return t
}

// ═══ R2 主语省略：同一主语连续 3 次以上 → 中间那次换「他」═════════════════
function varySubjects(text) {
  const parts = text.split(/(?<=[。！？…”])/)
  let run = 0, last = ''
  for (let i = 0; i < parts.length; i += 1) {
    const m = parts[i].match(/^[\s“”"]*([一-龥]{2,3})(?=[，。把被从在又还也就说问走看])/)
    const head = m ? m[1] : ''
    if (head && head === last) {
      run += 1
      if (run >= 2) {
        const to = parts[i].replace(/^([\s“”"]*)([一-龥]{2,3})/, '$1他')
        if (to !== parts[i]) { parts[i] = to; run += 1; last = ''; continue }
      }
    } else run = 0
    last = head
  }
  return parts.join('')
}

// ═══ R3 短断言缓冲 ═════════════════════════════════════════════════════════
function softenMaxims(text) {
  return text.split(/\n\s*\n/).map((para) => {
    const t = para.trim()
    if (!t || /[，、；]/.test(t)) return para
    if (t.split(/(?<=[。！？…])/).filter(Boolean).length !== 1) return para
    const n = [...t.replace(/[。！？…]/g, '')].length
    if (n >= 5 && n <= 12 && /(就是|才是|便是|都是|不是|算|归)[^。！？]{0,8}[。！？]$/.test(t)) return '说到底，' + t
    return para
  }).join('\n\n')
}

// ═══ R4 破整齐三连 ═════════════════════════════════════════════════════════
function breakParallel(text) {
  return text.replace(/[一-龥]{2,6}，[一-龥]{2,6}，[一-龥]{2,6}/g, (m) => {
    const p = m.split('，'), l = p.map((x) => han(x))
    return (l[0] === l[1] && l[1] === l[2] && l[0] <= 6) ? [p[0], p[1] + '了', p[2]].join('，') : m
  })
}

// ═══ R5 半角标点（平台「标点错乱」红线）════════════════════════════════════
function fixPunct(text) {
  let depth = 0
  let t = text.replace(/"/g, () => (depth++ % 2 === 0 ? '“' : '”'))
  t = t.replace(/,/g, '，').replace(/;/g, '；')
  t = t.replace(/:/g, (m, off, s) => (/https?:$/.test(s.slice(0, off)) ? ':' : '：'))
  return t
}

// ═══ 指标 ═════════════════════════════════════════════════════════════════
function stats(t) {
  const s = t.split(/(?<=[。！？…])/).map((x) => x.trim()).filter(Boolean)
  const lens = s.map((x) => han(x)).filter((n) => n > 0)
  const mean = lens.reduce((a, b) => a + b, 0) / (lens.length || 1)
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length || 1))
  const comma = (t.match(/，/g) ?? []).length, period = (t.match(/。/g) ?? []).length
  return {
    汉字: han(t), 句数: lens.length, 句均长: +mean.toFixed(1), 句长波动: +sd.toFixed(1),
    短句比: `${Math.round(100 * lens.filter((n) => n <= 10).length / (lens.length || 1))}%`,
    逗号句号比: +(comma / (period || 1)).toFixed(2),
    引号: (t.match(/“/g) ?? []).length, 问号: (t.match(/？/g) ?? []).length, 叹号: (t.match(/！/g) ?? []).length,
  }
}

// ═══ 保真校验 ═════════════════════════════════════════════════════════════
function fingerprint(t) {
  return {
    数字: (t.match(/[0-9０-９一二三四五六七八九十百千万两]+[两钱石方块天丈尺寸级分角元次]/g) ?? []).sort().join('|'),
    人名: [...new Set((t.match(new RegExp(NAMES.join('|'), 'g')) ?? []))].sort().join('|'),
  }
}

// ═══ 流水线单趟 ═══════════════════════════════════════════════════════════
function pipeline(body) {
  let t = body
  if (on('r6')) t = rhythmMerge(t)
  if (on('r8')) t = directSpeech(t)
  if (on('r1')) t = dropCues(t)
  if (on('r2')) t = varySubjects(t)
  if (on('r3')) t = softenMaxims(t)
  if (on('r4')) t = breakParallel(t)
  if (on('r5')) t = fixPunct(t)
  return t
}

// 走到不动点：整体反复套用直到不再变化 → 天然幂等 T(T(x)) = T(x)
function pipelineToStable(body) {
  let cur = body
  for (let i = 0; i < 8; i += 1) {
    const next = pipeline(cur)
    if (next === cur) return cur
    cur = next
  }
  return cur
}

// ═══ 主流程 ═══════════════════════════════════════════════════════════════
const rows = []
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')

  // ① 标题剥离（保护：标题一字不改）
  const m = src.match(/^(#[^\n]*\n+)/)
  const title = m ? m[1] : ''
  let body = src.slice(title.length)

  // ② 流水线（走到不动点）
  body = pipelineToStable(body)
  const out = title + body

  // ③ 幂等自检（再跑一遍必须零变化）
  const idempotent = pipelineToStable(body) === body

  // ④ 保真校验
  const fA = fingerprint(src), fB = fingerprint(out)
  const drift = Object.keys(fA).filter((k) => fA[k] !== fB[k])
  const lostCues = CUES.filter((w) => src.includes(w) && !out.includes(w))
  // 允许删除的汉字 = 套路词白名单里实际删掉的那些
  const allowedLoss = lostCues.reduce((n, w) => n + w.length * (src.split(w).length - 1), 0)
  const actualLoss = Math.max(0, han(src) - han(out))
  const extraLoss = Math.max(0, actualLoss - allowedLoss)
  const ok = drift.length === 0 && extraLoss === 0

  const a = stats(src), b = stats(out)
  rows.push({ file: path.basename(f), a, b, idempotent, drift, lostCues, extraLoss, ok })

  console.log(`\n=== ${path.basename(f)}`)
  console.log(`  前：汉字 ${a.汉字} · 句均长 ${a.句均长} · 波动 ${a.句长波动} · 短句比 ${a.短句比} · 逗号句号比 ${a.逗号句号比} · 引号 ${a.引号} · ？${a.问号} · ！${a.叹号}`)
  console.log(`  后：汉字 ${b.汉字} · 句均长 ${b.句均长} · 波动 ${b.句长波动} · 短句比 ${b.短句比} · 逗号句号比 ${b.逗号句号比} · 引号 ${b.引号} · ？${b.问号} · ！${b.叹号}`)
  console.log(`  保真：${ok ? '✓ 通过' : '✗ 失败'}${drift.length ? ` · 漂移项 ${drift.join('/')}` : ''}${extraLoss ? ` · 超额删除 ${extraLoss} 字` : ''} · 幂等 ${idempotent ? '✓' : '✗'}`)

  if (apply && ok) {
    // --out 是目录 → 沿用文件名；--out 是文件路径（含扩展名或不是已存在目录）→ 直接用它
    let dest
    if (!outDir) dest = f.replace(/(\.[^.]+)$/, '_humanized$1')
    else if (/[\\/][^\\/]+\.[A-Za-z0-9]+$/.test(outDir)) dest = outDir
    else dest = path.join(outDir, path.basename(f))
    fs.writeFileSync(dest, out, 'utf8')
    console.log(`  已写：${dest}`)
  } else if (apply && !ok) {
    console.log('  ✗ 保真未通过，拒绝写盘')
    process.exitCode = 5
  }
}

if (reportPath) {
  fs.writeFileSync(reportPath, JSON.stringify(rows, null, 2), 'utf8')
  console.log(`\n报告已写：${reportPath}`)
}

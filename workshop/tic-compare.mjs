// tic-compare.mjs —— 「AI 腔」句式口癖：我方章节 vs 番茄爆款章节，逐项比每千字密度（零 token）
// 目的：找出我们和爆款差得最远的那几种句式，作为提示词/闸门的改进依据（不拍脑袋）。
// 用法：node workshop/tic-compare.mjs <我方目录或文件>... [--corpus=262,1140,...] [--json=out.json]
import fs from 'node:fs'
import path from 'node:path'
import { stripMeta, stripHeading } from './lib/metrics.mjs'

// 每条：名称 → 正则（全局）。都在去掉空白后的正文上数，按每千汉字折算。
export const TICS = {
  '不是X，是Y（否定-肯定对举）': /不是[^，。！？“”\n]{1,14}[，,]\s*(?:而)?是[^，。！？“”\n]{1,14}/g,
  '「两秒/三秒/半秒」计时停顿': /(?:[一两二三四五六七八九十半几]|零点[一二三四五])秒/g,
  '「看了X秒/盯着…看」凝视': /(?:看了|盯了|盯着[^，。！？]{0,8}看了)[一两二三半几]秒|盯着[^，。！？]{1,10}(?:看|没说话)/g,
  '「像/仿佛/如同…一样」比喻': /(?:像|仿佛|好像|宛如|如同|犹如)[^，。！？“”]{2,18}(?:一样|似的|般)?/g,
  '「没说话/没接话/没吭声」': /没(?:说话|接话|吭声|出声|回答|作声)/g,
  '「顿了顿/停了一下/愣了一下」': /顿了顿|停了一下|停顿了|愣了一下|愣住|怔了一下|沉默了/g,
  '「他知道/她知道/他意识到」心理旁白': /[他她我]?(?:知道|意识到|明白|清楚)[，：:]?(?=[^。！？]{4,})/g,
  '「很轻/很淡/很平」状语': /很(?:轻|淡|平|低|稳)[。，]/g,
  '破折号——': /——/g,
  '「……」独立成段/省略号': /…{1,}/g,
  '感叹号': /[！!]/g,
  '问号': /[？?]/g,
  '语气词（啊呢吧嘛呗哈）': /[啊呢吧嘛呗哈哟嘞咯]/g,
  '口语/吐槽词（卧槽我去好家伙离谱绝了）': /卧槽|我去|好家伙|离谱|绝了|麻了|无语|服了|牛逼|尼玛|我靠|啥玩意|咋|整得|老六|破防|社死/g,
  '「XX的人才会/以前是…的人」概括旁白': /(?:的人才会|是那种|这种人|这个人向来)/g,
}

// 段落层面
function paraStats(body) {
  const paras = body.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  const one = paras.filter((p) => p.split(/(?<=[。！？…])/).filter((s) => s.trim()).length <= 1)
  const tiny = paras.filter((p) => p.replace(/\s/g, '').length <= 8)
  const dialog = paras.filter((p) => /^[“「]/.test(p))
  return { paras: paras.length, oneSentRatio: one.length / (paras.length || 1), tinyRatio: tiny.length / (paras.length || 1), dialogParaRatio: dialog.length / (paras.length || 1) }
}

export function ticProfile(raw) {
  const body = stripHeading(stripMeta(raw))
  const flat = body.replace(/\s/g, '')
  const han = (flat.match(/[\u4e00-\u9fa5]/g) || []).length
  const k = Math.max(0.3, han / 1000)
  const out = { han }
  for (const [name, re] of Object.entries(TICS)) out[name] = +(((flat.match(re) || []).length) / k).toFixed(2)
  return { ...out, ...paraStats(body) }
}

function median(a) { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) / 2; return (s[Math.floor(i)] + s[Math.ceil(i)]) / 2 }
function pct(a, p) { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo) }

function listFiles(t) {
  if (!fs.existsSync(t)) return []
  if (fs.statSync(t).isDirectory()) return fs.readdirSync(t).filter((x) => /\.(txt|md)$/.test(x)).sort().map((f) => path.join(t, f))
  return [t]
}

if (process.argv[1] && path.basename(process.argv[1]) === 'tic-compare.mjs') {
  const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d }
  const CORPUS = 'data\\knowledge\\chapters'
  const cats = arg('corpus', '262').split(',')
  const hitFiles = fs.readdirSync(CORPUS).filter((f) => cats.some((c) => f.startsWith(c + '-')) && f.endsWith('.txt')).map((f) => path.join(CORPUS, f))
  const ourFiles = process.argv.slice(2).filter((a) => !a.startsWith('--')).flatMap(listFiles)
  const hp = hitFiles.map((f) => ticProfile(fs.readFileSync(f, 'utf8'))).filter((p) => p.han > 800)
  const op = ourFiles.map((f) => ticProfile(fs.readFileSync(f, 'utf8'))).filter((p) => p.han > 800)
  const keys = Object.keys(hp[0]).filter((k) => k !== 'han' && k !== 'paras')
  const rows = keys.map((key) => {
    const h = hp.map((p) => p[key]), o = op.map((p) => p[key])
    const hm = median(h), om = median(o)
    const ratio = hm > 0 ? om / hm : (om > 0 ? Infinity : 1)
    const outside = o.filter((v) => v > pct(h, 0.9) || v < pct(h, 0.1)).length / (o.length || 1)
    return { key, hitP10: +pct(h, 0.1).toFixed(2), hitMedian: +hm.toFixed(2), hitP90: +pct(h, 0.9).toFixed(2), oursMedian: +om.toFixed(2), ratio: Number.isFinite(ratio) ? +ratio.toFixed(2) : 'inf', outsideP10P90: +outside.toFixed(2) }
  }).sort((a, b) => b.outsideP10P90 - a.outsideP10P90)
  console.log(`爆款 ${hp.length} 章（题材 ${cats.join(',')}） vs 我方 ${op.length} 章；单位：每千汉字（段落类为比例）`)
  console.log('指标'.padEnd(34), '爆款P10', '爆款中位', '爆款P90', '我方中位', '倍数', '我方落在P10–P90外的比例')
  for (const r of rows) console.log(r.key.padEnd(30), String(r.hitP10).padStart(7), String(r.hitMedian).padStart(8), String(r.hitP90).padStart(8), String(r.oursMedian).padStart(8), String(r.ratio).padStart(6), String(r.outsideP10P90).padStart(8))
  const out = arg('json', '')
  if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), cats, nHits: hp.length, nOurs: op.length, ours: ourFiles, rows }, null, 1), 'utf8')
}

// cover.mjs —— 封面生图：用包装方案里的封面提示词调生图模型，再裁成平台尺寸（默认番茄 600×800）并压上书名与笔名。
// 生图模型配置在 agents.json 的 agents.image（OpenAI 兼容 /images/generations）；尺寸与笔名在设置里（settings.json：coverWidth / coverHeight / penName）。
// 生图模型不负责写字（中文常写错），文字由本机 System.Drawing 压上，保证书名一个字不错。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as S from './store.mjs'
import { loadConfig, loadEnv } from './agents.mjs'
import { settings } from './pipeline.mjs'
import { CALL_LOG, precheck, liveQuota, spentTotal } from './llm.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 单价（元/张）：2026-10-03 示例图片服务用量实测 image-model 每张 $0.20（6 张共 $1.20），按项目统一汇率 ×7.2 = ¥1.44。
// 以前写 0，封面不扣内测额度、账本也漏记。
export const DEFAULT_IMAGE_AGENT = { name: '封面生图 · image-model（示例图片服务）', baseUrl: 'https://api.example.com/v1', model: 'image-model', keyEnv: 'IMAGE_API_KEY', pricePerImage: 1.44 }

function imageAgent() {
  const a = loadConfig().agents.image || DEFAULT_IMAGE_AGENT
  const env = loadEnv()
  const key = (a.apiKey || '').trim() || env[a.keyEnv] || process.env[a.keyEnv] || ''
  if (!key) throw new Error(`封面生图没有配置 API Key：在 projects/.env 里填 ${a.keyEnv || 'IMAGE_API_KEY'}`)
  return { ...a, key }
}

/** 生成封面。返回 { file, raw, prompt, ms } ；book.json 的 package.cover 记录当前采用的封面 */
export async function generateCover(id, { extra = '', onStep = () => {} } = {}) {
  const book = S.readBook(id); const cp = book.package?.coverPrompt || {}
  const set = settings()
  const W = Number(set.coverWidth) || 600, H = Number(set.coverHeight) || 800
  const base = cp.en || cp.zh
  if (!base) throw new Error('还没有封面提示词：先在「书名·简介·封面」生成包装方案并保存')
  const aiText = textMode(set) === 'ai'
  const prompt = aiText
    ? `${base}${extra ? '\n' + extra : ''}\n${aiTextPrompt(W, H, book.title, set.penName)}${cp.negative ? '\nAvoid: ' + cp.negative : ''}`
    : `${base}${extra ? '\n' + extra : ''}\nVertical book cover illustration for a Chinese web novel, portrait ${W}:${H} composition, leave the top third relatively clean for the title. Absolutely no text, no letters, no watermark.${cp.negative ? '\nAvoid: ' + cp.negative : ''}`
  const a = imageAgent()
  onStep(`生图模型（${a.model}）出图中${aiText ? '（模型自己写书名）' : ''}，通常 1–4 分钟，超时前请不要重复点`)
  const { buf, ms } = await callImage(a, { prompt })
  const dir = S.bookPath(id, 'covers'); fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const raw = path.join(dir, `raw-${stamp}.png`); fs.writeFileSync(raw, buf)
  onStep(aiText ? `裁成 ${W}×${H}（文字由生图模型直接画出）` : `裁成 ${W}×${H} 并压上书名、笔名`)
  const out = path.join(dir, `cover-${stamp}-${W}x${H}.png`)
  // 笔名只用用户自己在设置里填的那个（不是 agent 或模型起的），没填就不压笔名；封面标 noPen，页面提示用户补填后「只重新压字」
  const composed = composeCover({ src: raw, out, width: W, height: H, title: book.title, penName: set.penName || '', noText: aiText })
  const b = S.readBook(id); b.package = { ...(b.package || {}), cover: { file: path.basename(out), raw: path.basename(raw), at: new Date().toISOString(), size: `${W}x${H}`, model: a.model, noPen: !set.penName, composed, textMode: aiText ? 'ai' : 'overlay', coverTitle: book.title, coverPen: set.penName || '' } }; S.saveBook(b)
  return { file: out, raw, prompt, ms }
}

/** 封面文字模式：ai = 生图模型自己写书名和笔名（默认）；overlay = 本机压字（一个字不会错，但样子普通） */
export function textMode(set = settings()) { return set.coverTextMode === 'overlay' ? 'overlay' : 'ai' }

// 让生图模型自己写字的提示词。文字放在中间 90% 安全区，裁成 600×800（3:4）时才不会被切掉。
export function splitCoverTitle(title) {
  const t = String(title || '').trim()
  if (t.length <= 9) return [t]
  const candidates = Array.from({ length: t.length - 1 }, (_, i) => i + 1).filter(i => !(/[A-Za-z0-9]/.test(t[i - 1]) && /[A-Za-z0-9]/.test(t[i])))
  if (!candidates.length) return [t]
  const m = candidates.sort((a, b) => Math.abs(a - t.length / 2) - Math.abs(b - t.length / 2))[0]
  return [t.slice(0, m), t.slice(m)]
}
function aiTextPrompt(W, H, title, penName) {
  const t = String(title || '').trim()
  const lines = splitCoverTitle(t)
  const titleDesc = lines.length > 1 ? `分两行：${lines.map((l, k) => `第${k + 1}行“${l}”`).join('，')}` : `一行“${t}”`
  return `这是一张中文网络小说的竖版封面成品图，构图比例 ${W}:${H}。封面上方用大号、醒目、有质感的书法艺术字写书名，书名内容必须严格是：${t}（${titleDesc}），一个字都不能多、不能少、不能错，字形清晰锐利。${penName ? `右下角用小号白色字写作者笔名：${penName} 著，同样一个字都不能错。` : '不要画笔名或作者名。'}除了这些文字，画面上不要出现任何其他文字、乱码、水印或 logo。所有文字必须完整放在画面水平和垂直方向各 90% 的安全区内，不要贴边。`
}

async function callImage(a, { prompt, image } = {}) {
  const price = Number(a.pricePerImage) || 0
  precheck() // 内测用户：到期/停用/额度用完先拦
  const q = liveQuota()
  if (q.budget && price && spentTotal() + price > q.budget) throw new Error(`生成一张封面约需 ${Math.round(price * 100)} 积分，剩余积分不够。稿件和已有封面仍可查看和导出`)
  const base = a.baseUrl.replace(/\/$/, '')
  const t0 = Date.now()
  let res
  try {
  if (image) {
    const fd = new FormData()
    fd.append('model', a.model); fd.append('prompt', prompt); fd.append('size', '1024x1536'); fd.append('n', '1')
    fd.append('image', new Blob([image], { type: 'image/png' }), 'cover.png')
    res = await fetch(base + '/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${a.key}` }, body: fd, signal: AbortSignal.timeout(480000) })
  } else {
    res = await fetch(base + '/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.key}` }, body: JSON.stringify({ model: a.model, prompt, size: '1024x1536', n: 1 }), signal: AbortSignal.timeout(480000) })
  }
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('封面请求超时，结果未确认；已有封面和稿件保持不变。网关可能已处理或计费，请先核对服务商记录，再决定是否手动重试；不会自动重复生图。')
    throw e
  }
  const txt = await res.text()
  const ms = Date.now() - t0
  fs.appendFileSync(CALL_LOG, JSON.stringify({ at: new Date().toISOString(), task: 'cover', agent: 'image', agentName: a.name, model: a.model, ms, ok: res.ok, cost: res.ok ? price : 0, tag: image ? 'cover-edit' : 'cover' }) + '\n', 'utf8')
  if (!res.ok) throw new Error(`封面生图失败 HTTP ${res.status}：${txt.slice(0, 200)}`)
  const d = JSON.parse(txt).data?.[0] || {}
  let buf
  if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64')
  else if (d.url) buf = Buffer.from(await (await fetch(d.url)).arrayBuffer())
  else throw new Error('生图接口没有返回图片')
  return { buf, ms }
}

/** 改了书名/笔名后更新封面。overlay 封面：本机重新压字（免费）。ai 封面：把上一张原图交给生图模型编辑文字（花一张图的钱，约 2 分钟） */
export function recomposeCover(id) {
  const b = S.readBook(id); const c = b.package?.cover; if (!c?.raw) throw new Error('还没有生成过封面')
  if (c.textMode === 'ai') throw new Error('这张封面的文字是生图模型画的，改字需要重新编辑一次图（花一张图的钱），请用「改字」')
  const set = settings(); const W = Number(set.coverWidth) || 600, H = Number(set.coverHeight) || 800
  const out = S.bookPath(id, 'covers', `cover-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${W}x${H}.png`)
  const composed = composeCover({ src: S.bookPath(id, 'covers', c.raw), out, width: W, height: H, title: b.title, penName: set.penName || '' })
  b.package.cover = { ...c, file: path.basename(out), size: `${W}x${H}`, at: new Date().toISOString(), noPen: !set.penName, composed, coverTitle: b.title, coverPen: set.penName || '' }; S.saveBook(b)
  return out
}

/** AI 写字封面改字：用图片编辑接口，只改书名和笔名，保持画面不变 */
export async function retextCover(id, { onStep = () => {} } = {}) {
  const b = S.readBook(id); const c = b.package?.cover; if (!c?.raw) throw new Error('还没有生成过封面')
  const set = settings(); const W = Number(set.coverWidth) || 600, H = Number(set.coverHeight) || 800
  const title = String(b.title || '').trim(); const pen = set.penName || ''
  const changes = []
  if (title !== (c.coverTitle || '')) changes.push(`把封面上的书名改成：${title}（严格按这几个字，一个字都不能错）`)
  if (pen !== (c.coverPen || '')) changes.push(pen ? `把右下角的作者笔名改成：${pen} 著` : '去掉右下角的作者笔名')
  if (!changes.length) return { file: coverFile(id), unchanged: true }
  const a = imageAgent()
  const prompt = `${changes.join('；')}。保持插画、构图、配色、文字的字体和特效风格完全不变，其余位置不要新增任何文字，文字必须清晰、完整，位于画面中间 90% 的安全区内。`
  onStep(`生图模型（${a.model}）正在改封面文字，通常 1–3 分钟，请不要重复点`)
  const { buf, ms } = await callImage(a, { prompt, image: fs.readFileSync(S.bookPath(id, 'covers', c.raw)) })
  const dir = S.bookPath(id, 'covers'); const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const raw = path.join(dir, `raw-${stamp}.png`); fs.writeFileSync(raw, buf)
  const out = path.join(dir, `cover-${stamp}-${W}x${H}.png`)
  const composed = composeCover({ src: raw, out, width: W, height: H, noText: true })
  const nb = S.readBook(id); nb.package.cover = { ...nb.package.cover, file: path.basename(out), raw: path.basename(raw), at: new Date().toISOString(), size: `${W}x${H}`, noPen: !pen, composed, textMode: 'ai', coverTitle: title, coverPen: pen }; S.saveBook(nb)
  return { file: out, raw, ms }
}

/** 返回 true = 已压上书名/笔名；false = 本机没有压字能力（非 Windows），直接用生图原图并标明未压字 */
function composeCover(job) {
  if (process.platform !== 'win32') { fs.copyFileSync(job.src, job.out); return false }
  const jf = job.out + '.job.json'
  fs.writeFileSync(jf, JSON.stringify({ ...job, titleLines: splitCoverTitle(job.title) }), 'utf8')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'cover-compose.ps1'), '-Job', jf], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  fs.rmSync(jf, { force: true })
  if (r.status !== 0 || !fs.existsSync(job.out)) throw new Error('封面裁剪/压字失败：' + (r.stderr || r.stdout || '').slice(0, 300))
  return true
}

export function coverFile(id) {
  const c = S.readBook(id).package?.cover
  const f = c?.file ? S.bookPath(id, 'covers', c.file) : ''
  return f && fs.existsSync(f) ? f : ''
}

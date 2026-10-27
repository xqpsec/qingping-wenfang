// preview-live.mjs —— 把真实 e2e 录到的看板帧，用页面里同一份 CSS 和 liveHtml() 渲染成静态预览页，再用无头 Edge 截图
// 用法：node preview-live.mjs <e2e 帧文件.json> <输出目录>
// 不起服务、不调模型；只读 ui/index.html（保证预览与真实页面同一份代码）
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [framesFile, outDir] = process.argv.slice(2)
const html = fs.readFileSync(path.join(HERE, 'ui', 'index.html'), 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const fnSrc = html.slice(html.indexOf('function liveHtml'), html.indexOf("document.addEventListener('click', (e) => { if (e.target?.id === 'btnNotify')"))
const { frames } = JSON.parse(fs.readFileSync(framesFile, 'utf8'))
const withLive = frames.filter((f) => f.live && f.running)
// 取三个有代表性的时刻：搭世界观中段、排章纲中段、最后一帧
const pick = [withLive[Math.floor(withLive.length * 0.3)], withLive[Math.floor(withLive.length * 0.75)], withLive.at(-1)].filter(Boolean)
const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p))
fs.mkdirSync(outDir, { recursive: true })
const shots = []
// 帧是旧版过滤器录的：用当前 live.mjs 的规则重新过滤一遍摘要与反派名，预览才和现在的代码一致
const LV = await import('./lib/live.mjs')
let lastOk = ''
for (const f of withLive) {
  const t = f.live.think ? LV.thoughtOf(f.live.think.replace(/…$/, '') + (/[。！？?!]$/.test(f.live.think) ? '' : '。')) : ''
  if (t) lastOk = f.live.think; f.live.think = t ? f.live.think : lastOk
  const v = f.live.card?.villain; if (v && (v.match(/[\u4e00-\u9fa5]/g) || []).length < 2) delete f.live.card.villain
}
pick.forEach((f, i) => {
  const j = { label: '开书', elapsed: f.t, startedAt: 1, live: f.live }
  const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css} body{padding:16px;max-width:980px}</style><body>
<div id="busy" class="busy live"></div>
<script>const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const lvSeen = { job: 0, keys: new Set() };
${fnSrc}
document.getElementById('busy').innerHTML = liveHtml(${JSON.stringify(j)})</script></body></html>`
  const pf = path.join(outDir, `live-${i + 1}.html`); fs.writeFileSync(pf, page, 'utf8')
  const png = path.join(outDir, `live-${i + 1}-${f.t}s.png`)
  const r = spawnSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=1500', '--window-size=1000,640', `--screenshot=${png}`, 'file:///' + pf.replace(/\\/g, '/')], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  shots.push({ png, ok: fs.existsSync(png), err: r.error?.message || '' })
})
console.log(JSON.stringify(shots, null, 1))

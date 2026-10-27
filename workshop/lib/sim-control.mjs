import fs from 'node:fs'
import path from 'node:path'

export function readControl(file) {
  if (!file) return { revision: 0, mode: 'run', messages: [] }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { revision: -1, mode: 'pause', messages: [] } }
}
export function stopped(file, root, desktop) {
  return readControl(file).mode === 'stop' || [root, desktop].some(d => fs.existsSync(path.join(d, 'STOP.txt')))
}
export function controlContext(state) {
  return (state.messages || []).slice(-12).map(m => String(m.text || '').slice(0, 2000)).join('\n')
}
export function validateLimits({ steps, budget, minutes }) {
  // 2026-10-03 主办方定：质量优先，成本不是第一约束。上限仍保留（防止写错数字烧穿钱包），但放宽到足够一本书打磨用。
  if (!Number.isInteger(steps) || steps < 1 || steps > 400) throw new Error('步数须为 1–400')
  if (!Number.isFinite(budget) || budget <= 0 || budget > 100) throw new Error('预算须为 0–100 元，不含 0')
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) throw new Error('时间须为 1–240 分钟')
}
export async function searchPublic(query) {
  let q = String(query || '').trim().slice(0, 180)
  // Product-name ambiguity must not flood competitor evidence with unrelated results.
  if (/星月/.test(q) && !/site:/.test(q)) q += ' site:xingyuexiezuo.com'
  if (!q) throw new Error('搜索词为空')
  const r = await fetch('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(12000) })
  if (!r.ok) throw new Error('搜索服务 HTTP ' + r.status)
  const xml = (await r.text()).slice(0, 120000)
  return { query: q, at: new Date().toISOString(), url: r.url, xml, expectedDomain: /site:([a-z0-9.-]+)/i.exec(q)?.[1] || '' }
}

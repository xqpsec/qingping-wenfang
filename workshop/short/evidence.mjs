import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { channel } from './channels.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RULES = path.resolve(HERE, '..', 'data', 'platform-rules')
const norm = (s) => String(s || '').replace(/\s+/gu, '')

function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/)
  let header
  try { header = JSON.parse(lines.shift() || '') } catch { return [] }
  const body = lines.join('\n').trim()
  const blocks = body.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
  const parts = blocks.length > 1 ? blocks : body.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  return parts.map((text, n) => ({ id: `${header.id}#${n + 1}`, level: header.level, source: header.source, text }))
}

export function readEvidence() {
  if (!fs.existsSync(RULES)) return []
  return fs.readdirSync(RULES).filter((x) => x.endsWith('.txt')).sort().flatMap((x) => parseFile(path.join(RULES, x)))
}

export function buildEvidencePack(channelId) {
  const c = channel(channelId)
  const terms = new Set([channelId, c.name, ...(String(c.genres || '').split(/[、，,\/]/u)), '番茄短故事', '短故事'])
  const activity = channelId === 'fanqie-jinpin' ? ['IP金品共创', '11种热门品类', '2万字'] : channelId === 'fanqie-short' ? ['千字万金', '超短', '中短'] : []
  for (const x of activity) terms.add(x)
  const all = readEvidence()
  const score = (e) => [...terms].reduce((n, t) => n + (t && e.text.includes(t) ? 1 : 0), 0)
  const selected = all.filter((e) => score(e) > 0).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
  const out = []; let used = 0
  for (const e of selected) {
    const line = `[${e.id}|${e.level}|${e.source}] ${e.text}`
    if (used + line.length > 3000) continue
    out.push(line); used += line.length + 1
  }
  return out.join('\n')
}

export function verifyClaims(claims, pack) {
  const entries = new Map()
  for (const line of String(pack || '').split(/\r?\n/)) {
    const m = line.match(/^\[([^|]+)\|([^|]+)\|([^\]]+)\]\s([\s\S]*)$/)
    if (m) entries.set(m[1], { id: m[1], level: m[2], source: m[3], text: m[4] })
  }
  const verified = [], unverified = []
  for (const item of Array.isArray(claims) ? claims : []) {
    const e = entries.get(item?.evidenceId)
    const quote = norm(item?.quote)
    if (e && quote && norm(e.text).includes(quote)) verified.push(item)
    else unverified.push(item)
  }
  return { verified, unverified }
}

export function sanitizeClaims(value, pack) {
  if (!value || typeof value !== 'object') return { value, unverified: [] }
  const claims = Array.isArray(value.platformClaims) ? value.platformClaims : []
  const checked = verifyClaims(claims, pack)
  const scrub = (x) => {
    if (typeof x === 'string') return checked.unverified.reduce((s, c) => s.replaceAll(String(c.claim || ''), '').replaceAll(String(c.quote || ''), ''), x)
    if (Array.isArray(x)) return x.map(scrub)
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrub(v)]))
    return x
  }
  const clean = scrub({ ...value, platformClaims: checked.verified })
  return { value: clean, unverified: checked.unverified }
}

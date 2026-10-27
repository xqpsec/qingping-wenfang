import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveAgent } from '../lib/agents.mjs'
import * as P from './pipeline.mjs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const quoteCount = (s) => (String(s).match(/["“”「」『』]/g) || []).length
export function hardGateRegression(before, after) {
  const previousFails = new Set((before.deliveryFails || []).map((x) => x.id))
  const newDeliveryFailure = (after.deliveryFails || []).some((x) => !previousFails.has(x.id))
  return newDeliveryFailure || (before.deliveryOk && !after.deliveryOk) ||
    (!(before.aiBlocking || []).length && (after.aiBlocking || []).length > 0) ||
    (!(before.degenBlocking || []).length && (after.degenBlocking || []).length > 0) ||
    (before.pass && !after.pass)
}
function runSection({ mode, input, output, report }) {
  let args, env = process.env
  // --skip r8,r4（2026-10-04 实测）：
  //   R8「间接引语→直接引语」把叙述包成 说：“…”，并嵌套进已有对白（r2 稿 10 节全中，评审逻辑分 2/10）
  //   R4「破整齐三连」往等长三分句中间硬塞「了」（「我不知道了，它还能撑多久」），纯噪声
  if (mode === 'rules') args = [path.join(ROOT, 'scripts/ops/humanize.mjs'), input, '--apply', '--out', output, '--report', report, '--skip', 'r8,r4']
  else {
    const a = resolveAgent({ task: 'polish' })
    if (!a.key) throw new Error('润色模型未配置')
    args = [path.join(ROOT, 'scripts/ops/humanize-llm.mjs'), '--in', input, '--out', output, '--report', report, '--tries', '3', '--model', a.model, '--force']
    env = { ...process.env, HUMANIZE_BASE_URL: a.baseUrl, HUMANIZE_API_KEY: a.key }
  }
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: mode === 'rules' ? 120000 : 1200000, windowsHide: true })
  let data = null
  try { data = JSON.parse(fs.readFileSync(report, 'utf8')) } catch { /* missing report */ }
  const fidelity = mode === 'rules' ? data?.[0]?.ok === true : (r.status === 0 || r.status === 3)
  return { ok: fidelity && fs.existsSync(output), text: fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim() : '', code: r.status, cost: data?.llmCost || 0, report: data }
}
export async function polishShort(id, { mode, onStep = () => {}, gateCheck = P.gates, run = runSection } = {}) {
  const meta = P.readMeta(id), dir = P.shortDir(id)
  mode ||= meta.polishMode || 'rules'
  if (!['rules', 'llm'].includes(mode)) throw new Error('invalid polish mode')
  const versions = path.join(dir, 'versions'); fs.mkdirSync(versions, { recursive: true })
  const stem = `polish-${Date.now()}`
  const file = path.join(dir, '正文.md')
  const beforeGate = gateCheck(id), original = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(path.join(versions, stem + '-before.md'), original, 'utf8')
  const secs = P.splitSections(original), details = []
  for (let k = 0; k < secs.length; k++) {
    onStep(`润色：第${k + 1}节（${mode}）`)
    const input = path.join(versions, `${stem}-${k + 1}-in.txt`), output = path.join(versions, `${stem}-${k + 1}-out.txt`), report = path.join(versions, `${stem}-${k + 1}-report.json`)
    fs.writeFileSync(input, secs[k].text + '\n', 'utf8')
    let r
    try { r = await run({ mode, input, output, report, text: secs[k].text }) }
    catch (e) { r = { ok: false, error: String(e.message).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]') } }
    const src = secs[k].text
    // 保真闸门：润色不许增删引号（对白边界是事实，改了就会把叙述变成台词）
    const quoteGuard = r.ok && r.text && quoteCount(r.text) !== quoteCount(src)
    if (quoteGuard) r = { ...r, ok: false, error: `引号数 ${quoteCount(src)}→${quoteCount(r.text)}，本节保留原文` }
    const got = r.ok && r.text ? r.text : src
    let prefix = 0, suffix = 0
    while (prefix < Math.min(src.length, got.length) && src[prefix] === got[prefix]) prefix++
    while (suffix < Math.min(src.length, got.length) - prefix && src[src.length - 1 - suffix] === got[got.length - 1 - suffix]) suffix++
    details.push({ section: k + 1, ok: !!r.ok, changed: src !== got, changeRatio: (Math.max(src.length, got.length) - prefix - suffix) / Math.max(1, src.length, got.length), code: r.code, cost: r.cost || 0, error: r.error })
    secs[k].text = got
  }
  fs.writeFileSync(file, P.joinSections(secs), 'utf8')
  let afterGate, rolledBack = false
  try { afterGate = gateCheck(id); rolledBack = hardGateRegression(beforeGate, afterGate) }
  catch { rolledBack = true; afterGate = { pass: false, error: 'gate-check-failed' } }
  fs.writeFileSync(path.join(versions, stem + '-candidate.md'), fs.readFileSync(file, 'utf8'), 'utf8')
  if (rolledBack) fs.writeFileSync(file, original, 'utf8')
  fs.writeFileSync(path.join(versions, stem + '-after.md'), fs.readFileSync(file, 'utf8'), 'utf8')
  meta.polish = { at: new Date().toISOString(), mode, completed: true, rolledBack, sections: details.map((d) => ({ ...d, rolledBack: rolledBack && d.changed })), beforeGate, afterGate, versions: stem, ratioDefinition: '去除共同前后缀后差异区间长度/较长文本长度（非编辑距离）' }
  meta.cost = +((meta.cost || 0) + details.reduce((n, d) => n + d.cost, 0)).toFixed(5)
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  return meta.polish
}

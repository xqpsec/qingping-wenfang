// polish.mjs —— 人工润色器接入（可选，默认关闭）
//   rules：scripts/ops/humanize.mjs  零成本规则改写（节奏整形/直引化/删套话），保真校验不过就不出稿
//   llm  ：scripts/ops/humanize-llm.mjs  LLM 定点改写 + 审稿 + 腾讯 TMS AIGC 检测；用「人味润色」任务分配的 agent
// 润色结果只放在 work/<章>/polished.txt 当候选，不自动替换定稿，由作者在章节页对比后点「采用」
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT } from './llm.mjs'
import { resolveAgent } from './agents.mjs'
import * as S from './store.mjs'

const OPS = path.join(ROOT, 'scripts', 'ops')
export const POLISH_MODES = { off: '关闭', rules: '规则版（免费）', llm: 'LLM 版（花钱，含 AIGC 检测）' }

function run(args, env, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    const t = setTimeout(() => { p.kill(); out += '\n（超时，已终止）' }, timeoutMs)
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.slice(-3000) }) })
  })
}

/** 润色某章定稿，返回 { ok, mode, text, note } 并写 work/<章>/polished.txt + polish.json */
export async function polishChapter(id, n, mode) {
  if (!POLISH_MODES[mode] || mode === 'off') throw new Error('润色模式未开启')
  const src = S.readText(id, 'chapters', S.pad(n) + '.txt')
  if (!src) throw new Error(`第${n}章还没有定稿`)
  const lines = src.replace(/^\uFEFF/, '').split('\n')
  const head = /^第\s*\S+\s*章/.test(lines[0]) ? lines[0].trim() : ''
  const body = (head ? lines.slice(1) : lines).join('\n').trim()
  const dir = S.bookPath(id, 'work', S.pad(n)); fs.mkdirSync(dir, { recursive: true })
  const fin = path.join(dir, 'polish-in.txt'), fout = path.join(dir, 'polish-out.txt'), frep = path.join(dir, 'polish-report.json')
  fs.rmSync(fout, { force: true })
  let res, cost = 0
  if (mode === 'rules') {
    // 规则版不认「第N章」标题，只送正文
    fs.writeFileSync(fin, body + '\n', 'utf8')
    res = await run([path.join(OPS, 'humanize.mjs'), fin, '--apply', '--out', fout, '--skip', 'r8,r4'], {}, 120000)
  } else {
    const a = resolveAgent({ task: 'polish' })
    if (!a.key) throw new Error(`「${a.name}」没有配置 API Key（用于：人味润色）`)
    fs.writeFileSync(fin, (head ? head + '\n\n' : '') + body + '\n', 'utf8')
    // --force：作者主动点的润色，原稿已过检测也要真的改表达，否则交回一字未改的原稿
    res = await run([path.join(OPS, 'humanize-llm.mjs'), '--in', fin, '--out', fout, '--report', frep, '--tries', '3', '--model', a.model, '--force'],
      { HUMANIZE_BASE_URL: a.baseUrl, HUMANIZE_API_KEY: a.key }, 20 * 60000)
    try { cost = JSON.parse(fs.readFileSync(frep, 'utf8')).llmCost || 0 } catch { /* 没报告 */ }
  }
  fs.rmSync(fin, { force: true })
  const got = fs.existsSync(fout) ? fs.readFileSync(fout, 'utf8').trim() : ''
  fs.rmSync(fout, { force: true })
  if (cost) S.addCost(id, cost)
  const summary = res.out.trim().split('\n').slice(-4).join(' ').slice(0, 400)
  if (!got) {
    const why = res.code === 5 ? '保真校验没通过，为了不改坏原文，没有出稿' : `润色脚本退出码 ${res.code}`
    S.writeText(id, `work/${S.pad(n)}/polish.json`, JSON.stringify({ at: new Date().toISOString(), mode, ok: false, why, log: summary }, null, 2))
    throw new Error(`${why}：${summary}`)
  }
  let text = got
  if (head && !text.startsWith(head)) text = head + '\n\n' + text.replace(/^第\s*\S+\s*章[^\n]*\n+/, '')
  // 段间空一行（番茄上传格式）
  text = text.split('\n').map((x) => x.trim()).filter(Boolean).join('\n\n') + '\n'
  S.writeText(id, `work/${S.pad(n)}/polished.txt`, text)
  const same = text.replace(/\s/g, '') === src.replace(/^\uFEFF/, '').replace(/\s/g, '')
  const note = same ? '这一章已经很自然，润色后没有需要改的地方' : mode === 'llm' ? (res.code === 0 ? 'AIGC 检测通过' : '未完全通过 AIGC 检测，给出的是最好的一版') : '规则改写，保真校验通过'
  S.writeText(id, `work/${S.pad(n)}/polish.json`, JSON.stringify({ at: new Date().toISOString(), mode, ok: true, code: res.code, note, cost, log: summary }, null, 2))
  return { ok: true, mode, note, cost }
}

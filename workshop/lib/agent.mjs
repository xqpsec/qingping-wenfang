// agent.mjs —— 智能代理（Beta）：用户给一句指令，代理自己按「写章 → 看评审 → 必要时改写 → 包装」推进，直到目标完成就自动停。
//
// 设计纪律（用户 2026-10-02 定的）：
//   ① 先给指令、先看计划、点「确认开始」才动手，不会一打开就空转烧钱
//   ② 随时可以：暂停（当前这一步做完停下，以后可继续）/ 立即中止（掐断正在进行的模型请求，已写好的草稿保留，以后可继续）/ 插入引导（下一步决策时优先照办）
//   ③ 做完目标自动结束；没有定时器、没有后台循环，结束后进程里什么都不剩
//   ④ 硬上限：目标章数、预算（元）、最多步数，任何一个到了就停并说明原因
//   ⑤ 代理只能调工坊自己的功能（写章/改写/包装/封面），不碰任何外部平台、不替用户填笔名、不替用户做 AI 申报
//   ⑥ 改写稿的采用与否由代码按评审对比结论定（只有「改后更好」才采用，其余一律保留原稿），不交给模型拍板
import fs from 'node:fs'
import path from 'node:path'
import * as S from './store.mjs'
import * as PL from './pipeline.mjs'
import * as PK from './packaging.mjs'
import { chat, parseJson, spentTotal, abortCtl } from './llm.mjs'

const stateFile = () => path.join(path.dirname(PL.settingsFile()), 'agent-run.json')
const MAX_STEPS = 40
const nowIso = () => new Date().toISOString()

let live = null // { ctl, bookId } —— 本进程里正在跑的代理；进程重启后文件里的 running 一律视为被中断

export function readState() {
  let st
  try { st = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return { status: 'idle' } }
  if (st.status === 'running' && !live) { st.status = 'interrupted'; st.note = '后台重启或崩溃时被打断，草稿都在，可以点「继续」' }
  return st
}
/** 循环内保存：先把磁盘上用户刚点的 暂停/中止/引导 合并进来，再落盘（否则内存里的旧副本会把它们覆盖掉） */
function persist(st) {
  let f = {}; try { f = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { /* 无 */ }
  st.pauseRequested = !!f.pauseRequested || !!st.pauseRequested; st.stopRequested = !!f.stopRequested || !!st.stopRequested
  const seen = new Map()
  for (const g of [...(f.guidance || []), ...(st.guidance || [])]) { const k = g.at + '|' + g.text; seen.set(k, { ...g, consumed: !!(seen.get(k)?.consumed || g.consumed) }) }
  st.guidance = [...seen.values()]
  const logSeen = new Set((st.log || []).map((x) => x.at + x.text))
  st.log = [...(st.log || []), ...(f.log || []).filter((x) => !logSeen.has(x.at + x.text))].sort((a, b) => (a.at < b.at ? -1 : 1)).slice(-80)
  return save(st)
}
function save(st) { st.updatedAt = nowIso(); fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile() + '.tmp', JSON.stringify(st, null, 2), 'utf8'); fs.renameSync(stateFile() + '.tmp', stateFile()); return st }
const addLog = (st, text, kind = 'info') => { st.log = [...(st.log || []), { at: nowIso(), kind, text: String(text).slice(0, 400) }].slice(-80) }
const cap = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d))

const SYS = `你是清平文坊里的「智能代理」，替作者把一本网文往前推进。你只能从给定的动作里选一个，输出 JSON，不要别的。
原则：作者的指令和中途引导优先；够用就停，不为凑数多做；评审分低（<55）的章节最多改写一次；不要重复同一个动作；拿不准时选保守的。`

/** 第一步：只出计划，不动手。用户看完点「确认开始」才会真的跑 */
export async function plan(bookId, { instruction, chapters = 1, budget = 1.5, allowPackage = true, allowCover = false } = {}, { onStep = () => {} } = {}) {
  if (!String(instruction || '').trim()) throw new Error('先写一句你希望代理做什么（例如：接着往下写 3 章，每章写完看评审，低于 60 分的改一次）')
  const b = S.readBook(bookId)
  const st = {
    status: 'awaiting-approval', bookId, bookTitle: b.title, instruction: String(instruction).trim().slice(0, 1000),
    chapters: cap(chapters, 0, 10, 1), budget: cap(budget, 0.1, 50, 1.5), allowPackage: !!allowPackage, allowCover: !!allowCover,
    createdAt: nowIso(), steps: 0, wrote: 0, spent: 0, guidance: [], log: [],
  }
  onStep('代理在拟计划（几秒钟）')
  const r = await chat({ task: 'agent', system: SYS, user: `${bookBrief(bookId)}\n\n作者指令：${st.instruction}\n目标：这次最多写 ${st.chapters} 章；预算 ¥${st.budget}；${st.allowPackage ? '允许' : '不允许'}生成书名/简介包装；${st.allowCover ? '允许' : '不允许'}生成封面。\n请用 3–6 条短句写出你打算怎么做（每条一行，不要编号以外的格式），最后一行写「完成标准：……」。直接输出文字。`, temperature: 0.3, maxTokens: 800, tag: 'agent-plan' })
  S.addCost(bookId, r.cost)
  st.plan = r.content.trim().slice(0, 1200)
  addLog(st, '计划已生成，等你确认')
  return save(st)
}

function bookBrief(id) {
  const b = S.readBook(id)
  const words = b.chapters.reduce((a, c) => a + (c.chars || 0), 0)
  const rows = PL.outlineRows(id)
  const next = rows[b.chapters.length]
  return `书：《${b.title}》；已写 ${b.chapters.length} 章 / ${words} 字；章纲共 ${rows.length} 章${next ? `，下一章：${String(next).slice(0, 80)}` : '，章纲已写完（再写会自动续章纲）'}\n各章：${b.chapters.slice(-8).map((c) => `第${c.n}章${c.score != null ? ` ${c.score}分` : ' 未评分'}${c.scoreStale ? '(旧)' : ''}`).join('，') || '无'}\n包装：${b.package?.updatedAt ? '已有' : '还没有'}；封面：${b.package?.cover?.file ? '已有' : '还没有'}`
}

/** 路由里先同步检查（不用等后台任务跑起来才报错） */
export function assertCanStart(resume = false) {
  const st = readState()
  if (live) throw new Error('代理已经在运行')
  if (!resume && st.status !== 'awaiting-approval') throw new Error('还没有待确认的代理计划：先在上面写指令并点「让代理拟计划」')
  if (resume && !['paused', 'stopped', 'interrupted', 'error'].includes(st.status)) throw new Error('当前没有可以继续的代理任务')
}

/** 用户点「确认开始」/「继续」：把代理跑起来。返回一个 promise（由 server 的 runJob 托管），跑完或被打断时 resolve */
export async function run({ instruction, resume = false } = {}, { onStep = () => {} } = {}) {
  const st = readState()
  if (!resume && st.status !== 'awaiting-approval') throw new Error('还没有待确认的代理计划：先在上面写指令并点「让代理拟计划」')
  if (resume && !['paused', 'stopped', 'interrupted', 'error'].includes(st.status)) throw new Error('当前没有可以继续的代理任务')
  if (live) throw new Error('代理已经在运行')
  if (instruction && String(instruction).trim()) { st.instruction = String(instruction).trim().slice(0, 1000); addLog(st, '确认前改过指令') }
  const ctl = new AbortController(); live = { ctl, bookId: st.bookId }
  abortCtl.signal = ctl.signal
  const base = spentTotal() - (st.spent || 0) // 续跑时把之前花的算进来
  Object.assign(st, { status: 'running', startedAt: st.startedAt || nowIso(), pauseRequested: false, stopRequested: false, note: '' })
  addLog(st, resume ? '继续运行' : '用户确认，开始运行', 'ctl'); save(st)
  const bookId = st.bookId
  const doneCh = new Set((st.revisedChapters || []))
  let failStreak = 0, lastAction = ''
  try {
    while (true) {
      const cur = readState() // 读盘：暂停/中止/引导都是 server 写进文件的
      cur.spent = +(spentTotal() - base).toFixed(4)
      if (cur.stopRequested || ctl.signal.aborted) { return end(cur, 'stopped', '已按你的要求立即中止，已写好的内容都保留，可以点「继续」接着做') }
      if (cur.pauseRequested) { return end(cur, 'paused', '已暂停（上一步已做完）。可以补充引导后点「继续」') }
      if (cur.spent >= cur.budget) { return end(cur, 'done', `预算 ¥${cur.budget} 用完，自动停止（已花 ¥${cur.spent}）`, true) }
      if (cur.steps >= MAX_STEPS) { return end(cur, 'done', `达到最多 ${MAX_STEPS} 步，自动停止`, true) }
      Object.assign(st, { pauseRequested: cur.pauseRequested, stopRequested: cur.stopRequested, guidance: cur.guidance, spent: cur.spent })
      let d
      try { d = await decide(st, lastAction) } catch (e) { if (e.aborted || ctl.signal.aborted) { persist(st); continue } throw e }
      st.steps++
      const act = d.action
      addLog(st, `第 ${st.steps} 步：${d.think || ''} → ${describe(d)}`, 'step'); persist(st)
      if (act === 'finish') { return end(readState(), 'done', `代理认为已完成：${d.think || '目标达成'}`, true) }
      try {
        onStep(`第 ${st.steps} 步：${describe(d)}`)
        await exec(st, d, doneCh, onStep)
        failStreak = 0
      } catch (e) {
        if (e.aborted || ctl.signal.aborted) { persist(st); continue }
        failStreak++
        addLog(st, `这一步失败：${String(e.message).split('\n')[0].slice(0, 200)}`, 'error')
        if (failStreak >= 2) { persist(st); return end(readState(), 'error', `连续 2 步失败，已停下：${String(e.message).split('\n')[0].slice(0, 160)}`) }
      }
      lastAction = act; st.revisedChapters = [...doneCh]; st.spent = +(spentTotal() - base).toFixed(4); persist(st)
    }
  } finally {
    abortCtl.signal = null; live = null
  }
}

function end(st, status, note, finished = false) {
  st.status = status; st.note = note; st.endedAt = nowIso(); st.pauseRequested = false; st.stopRequested = false
  addLog(st, note, finished ? 'done' : 'ctl')
  save(st); return { status, note }
}

const describe = (d) => ({ write_next: '写下一章', revise: `改写第 ${d.n} 章`, package: '生成并采用书名/简介/封面提示词', cover: '生成封面', finish: '结束' }[d.action] || d.action)

/** 让模型在允许的动作里挑下一步；再由代码做合法性与硬规则兜底 */
async function decide(st, lastAction) {
  const b = S.readBook(st.bookId)
  const guide = (st.guidance || []).filter((g) => !g.consumed)
  const wroteLeft = st.chapters - st.wrote
  const allowed = [wroteLeft > 0 ? 'write_next' : null, 'revise', st.allowPackage && !b.package?.updatedAt ? 'package' : null, st.allowCover && b.package?.coverPrompt && !b.package?.cover?.file ? 'cover' : null, 'finish'].filter(Boolean)
  const user = `${bookBrief(st.bookId)}\n\n作者指令：${st.instruction}\n本次还要写 ${Math.max(0, wroteLeft)} 章（已写 ${st.wrote}）；已改写过的章：${(st.revisedChapters || []).join('、') || '无'}；上一步动作：${lastAction || '无'}。\n${guide.length ? `作者中途给你的引导（必须优先照办）：\n${guide.map((g) => '- ' + g.text).join('\n')}\n` : ''}可选动作：${allowed.join(' / ')}。\n- write_next：写下一章\n- revise：改写某一章，要给 n 和 instruction（具体改法，引用要删/改的原句）。只改评审分 <55 或指令/引导点名要改的章，每章最多一次\n- package：生成并采用包装\n- cover：生成封面\n- finish：目标已达成或没什么可做了\n只输出 JSON：{"think":"一句话理由","action":"...","n":章号或null,"instruction":"改写意见或空"}`
  let d
  try { const r = await chat({ task: 'agent', system: SYS, user, temperature: 0.2, maxTokens: 1500, json: true, tag: 'agent-decide' }); S.addCost(st.bookId, r.cost); d = parseJson(r.content) } catch (e) { if (e.aborted) throw e; d = {} }
  if (guide.length) { st.guidance = (st.guidance || []).map((g) => (g.consumed ? g : { ...g, consumed: true })); }
  // 兜底：动作非法时按确定性规则走
  let action = String(d.action || '')
  if (!allowed.includes(action)) action = wroteLeft > 0 ? 'write_next' : allowed.includes('package') ? 'package' : 'finish'
  if (action === 'revise') {
    const n = Number(d.n)
    const ch = b.chapters.find((c) => c.n === n)
    if (!ch || (st.revisedChapters || []).includes(n)) action = wroteLeft > 0 ? 'write_next' : 'finish'
    else return { think: String(d.think || ''), action, n, instruction: String(d.instruction || '').slice(0, 1500) }
  }
  // 硬规则：同一个动作连着来两次又没有新引导，直接收尾，防止原地打转
  if (action === lastAction && action !== 'write_next') action = 'finish'
  return { think: String(d.think || '').slice(0, 160), action }
}

async function exec(st, d, doneCh, onStep) {
  const id = st.bookId
  if (d.action === 'write_next') {
    if (process.env.WORKSHOP_NO_WRITE === '1') { st.wrote = st.chapters; addLog(st, '打磨模式不写新章，跳过「写下一章」', 'result'); return }
    const n = (S.readBook(id).chapters.at(-1)?.n || 0) + 1
    const row = await PL.writeChapter(id, n, { onStep: (s) => onStep(`第 ${n} 章：${s}`) })
    st.wrote++; addLog(st, `第 ${n} 章写好了：${row?.chars || '?'} 字，评审 ${row?.score ?? '—'} 分`, 'result')
  } else if (d.action === 'revise') {
    const rev = await PL.reviseChapter(id, d.n, d.instruction, { onStep })
    doneCh.add(d.n)
    // 采用与否由代码定：只有评审对比明确「改后更好」才采用，其余都保留原稿
    const lvl = rev?.compare?.advice?.level
    if (lvl === 'better') { PL.adoptRevision(id, d.n); addLog(st, `第 ${d.n} 章：改后更好，已采用（${rev.compare.advice.text}）`, 'result') }
    else { PL.discardRevision(id, d.n); addLog(st, `第 ${d.n} 章：对比结论「${rev?.compare?.advice?.text || '无法判断'}」，保留原稿，改写稿已归档`, 'result') }
  } else if (d.action === 'package') {
    const r = await PK.generatePackage(id, '', { onStep })
    const t = r.titles[r.recommend] || r.titles[0]
    PK.applyPackage(id, { title: t.title, intro: r.intro, meta: r.meta, tags: r.tags, coverPrompt: r.coverPrompt })
    addLog(st, `包装已采用：书名《${t.title}》（${PK.titleLen(t.title)} 字）。笔名需要你自己在「书名·简介·封面」里填`, 'result')
  } else if (d.action === 'cover') {
    const CV = await import('./cover.mjs')
    const r = await CV.generateCover(id, { onStep })
    addLog(st, `封面已生成${PL.settings().penName ? '' : '（没有笔名：你填好自己的笔名后点「只重新压书名/笔名」即可）'}：${path.basename(r.file)}`, 'result')
  }
}

// ── 用户控制（server 路由调用；都只写状态文件，由运行中的循环在下一个边界读取）──
export function guide(text) {
  const st = readState()
  if (!['running', 'paused', 'stopped', 'interrupted', 'awaiting-approval'].includes(st.status)) throw new Error('当前没有进行中的代理任务')
  const t = String(text || '').trim().slice(0, 500); if (!t) throw new Error('引导内容不能为空')
  st.guidance = [...(st.guidance || []), { at: nowIso(), text: t, consumed: false }]
  addLog(st, `你的引导：${t}`, 'ctl'); return save(st)
}
export function pause() {
  const st = readState(); if (st.status !== 'running') throw new Error('代理没有在运行')
  st.pauseRequested = true; addLog(st, '你点了暂停：当前这一步做完后停下', 'ctl'); return save(st)
}
export function stop() {
  const st = readState(); if (st.status !== 'running') throw new Error('代理没有在运行')
  st.stopRequested = true; addLog(st, '你点了立即中止', 'ctl'); save(st)
  live?.ctl.abort() // 掐断正在进行的模型请求
  return readState()
}
export function discardPlan() {
  const st = readState()
  if (st.status === 'running') throw new Error('代理正在运行，先暂停或中止')
  try { fs.rmSync(stateFile(), { force: true }) } catch { /* 无 */ }
  return { status: 'idle' }
}

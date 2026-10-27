import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateLimits } from './lib/sim-control.mjs'
import { deliverBook } from './lib/delivery.mjs'
import { publicStyles } from './lib/styles.mjs'
import { checkBook, nextChance } from './lib/book-check.mjs'
import { stripAnnot } from './lib/annot.mjs'
import { CHANNELS as SHORT_CHANNELS, GENRES as SHORT_GENRES } from './short/channels.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.QINGPING_WORKSPACE || process.cwd()
const DEFAULT_SOURCE = path.join(HERE, 'data', 'author-sandbox')
const DEFAULT_BOOKS = path.resolve(HERE, '..', 'projects', 'workshop-books')
const DEFAULT_SHORTS = path.resolve(HERE, '..', 'projects', 'workshop-shorts')
const configFile = (dir) => path.join(dir, 'workspace.json')
function readWorkspaceConfig(dataDir) {
  try { return JSON.parse(fs.readFileSync(configFile(dataDir), 'utf8')) } catch { return {} }
}
function writeWorkspaceConfig(dataDir, value) {
  fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(configFile(dataDir) + '.tmp', JSON.stringify(value, null, 2), 'utf8'); fs.renameSync(configFile(dataDir) + '.tmp', configFile(dataDir))
}
function booksRoot(workspace) {
  const p = path.resolve(String(workspace || ''))
  return fs.existsSync(path.join(p, 'books')) ? path.join(p, 'books') : p
}
function bookNames(workspace) {
  const dir = booksRoot(workspace); if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'book.json')))
}
function chapterCount(workspace, book) {
  const dir = path.join(booksRoot(workspace), book, 'chapters')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}\.txt$/i.test(f) && fs.statSync(path.join(dir, f)).size > 0).length : 0
}
function copyBook(sourceBooks, book, targetBooks) {
  const src = path.join(booksRoot(sourceBooks), book), dst = path.join(targetBooks, book)
  if (!fs.existsSync(path.join(src, 'book.json'))) throw new Error('源工作区找不到所选书稿：' + book)
  fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.cpSync(src, dst, { recursive: true })
}
function safeBookId(value) {
  const id = String(value || '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  if (!id) throw new Error('新书名不能为空')
  return id
}
function createTestBook(targetBooks, spec = {}) {
  const title = String(spec.title || '').trim().slice(0, 80)
  const idea = String(spec.idea || '').trim().slice(0, 1200)
  const genre = String(spec.genre || '都市脑洞').trim().slice(0, 40)
  if (!title) throw new Error('请填写新书名')
  if (!idea) throw new Error('请填写新书的一句话设定')
  const id = safeBookId(title)
  const dir = path.join(targetBooks, id)
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true })
  const now = new Date().toISOString()
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ id, title, genre, platform: 'tomato', stage: 'new', chapters: [], createdAt: now, updatedAt: now, cost: 0 }, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'concept.md'), `# ${title}\n\n题材：${genre}\n\n一句话设定：${idea}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'bible.md'), `# ${title}·设定集\n\n题材：${genre}\n核心设定：${idea}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'outline.md'), `# ${title}·章纲\n\n- 第1章：围绕「${idea}」制造首个可验证冲突。\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'progress.log'), `新建测试书：${now}\n`, 'utf8')
  return id
}
// 可选书库：助理沙箱（桌面助理一直在写的那批）和「我的书库」都列出；同名也分别列出，用「来源:书名」作为唯一 ID
function library(libraryRoot = DEFAULT_BOOKS, sandboxRoot = DEFAULT_SOURCE) {
  const m = new Map()
  for (const [root, label] of [[sandboxRoot, '助理沙箱'], [libraryRoot, '我的书库']]) {
    if (!fs.existsSync(root)) continue
    for (const name of bookNames(root)) m.set(label + ':' + name, { name, root, label, chapters: chapterCount(root, name) })
  }
  return m
}
function uniqueName(root, name) {
  let n = name, i = 2
  while (fs.existsSync(path.join(root, n))) n = name + '-' + i++
  return n
}
function bookHash(dir) {
  if (!fs.existsSync(dir)) return ''
  const hash = crypto.createHash('sha256')
  function visit(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(root, entry.name)
      if (entry.isSymbolicLink()) throw new Error('书稿目录不支持符号链接')
      if (entry.isDirectory()) visit(f)
      else if (entry.isFile()) { hash.update(path.relative(dir, f)); hash.update(fs.readFileSync(f)) }
    }
  }
  visit(dir); return hash.digest('hex')
}
function safeHash(dir) { try { return bookHash(dir) } catch { return '' } }
// 把沙箱里写完的书同步回书库：续写的书只有在原稿这期间没被别人改过时才覆盖（并先备份），否则另存为新名字；新书直接入库
function syncBack(control, pick, libraryRoot) {
  const sb = path.join(control.sandbox, 'books', pick)
  if (control.sourceBook && control.sourceRoot) {
    const dst = path.join(control.sourceRoot, control.sourceBook)
    if (safeHash(dst) === control.sourceHash) {
      const bak = path.join(control.backupRoot, '_书稿备份', control.sourceBook + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
      fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.cpSync(dst, bak, { recursive: true })
      fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(sb, dst, { recursive: true })
      return '续写的内容已同步回书库「' + control.sourceBook + '」，原稿备份在：' + bak
    }
    const alt = uniqueName(control.sourceRoot, control.sourceBook + '-续写'); fs.cpSync(sb, path.join(control.sourceRoot, alt), { recursive: true })
    return '原稿在你续写期间被改动过，为避免覆盖，续写结果另存为书库里的「' + alt + '」。'
  }
  const name = uniqueName(libraryRoot, pick); fs.mkdirSync(libraryRoot, { recursive: true }); fs.cpSync(sb, path.join(libraryRoot, name), { recursive: true })
  return '新书已存入书库「' + name + '」，下次可选它继续写。'
}
// 桌面成果：一本书只有一个以书名命名的文件夹。再次交付同一本书时，章数更多（或相等）的新版本替换现有版本，
// 被替换下来的旧版本收进 _旧版本 子文件夹（不删除）；如果新版本反而章数更少，就保留现有的，把新版本收进 _旧版本。
function chaptersIn(dir) {
  const d = path.join(dir, '分章正文')
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^\d{4}\.txt$/.test(f)).length : 0
}
export const deskName = (title) => String(title || '').replace(/[\\/:*?"<>|\r\n]+/g, '').trim().replace(/[. ]+$/, '').slice(0, 60) || '未命名'
const titleOf = (bookDir) => { try { return String(JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8')).title || path.basename(bookDir)) } catch { return path.basename(bookDir) } }
// ── 签约台账（data/customer-lab/signing.json）：主办方登记投稿/签约/被拒，书的好坏最终以这个为准 ──
// 一本书番茄长篇只有 2万/5万/8万 三次机会；每次投稿把当时的体检快照存下来，结果回来后可以对比「签上的」和「被拒的」差在哪。
const signFile = (dataDir) => path.join(dataDir, 'signing.json')
export function readSigning(dataDir) { try { const j = JSON.parse(fs.readFileSync(signFile(dataDir), 'utf8')); return j && j.books && typeof j.books === 'object' ? j : { books: {} } } catch { return { books: {} } } }
function writeSigning(dataDir, j) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(signFile(dataDir) + '.tmp', JSON.stringify(j, null, 2), 'utf8'); fs.renameSync(signFile(dataDir) + '.tmp', signFile(dataDir)) }
export function signStatus(entry) {
  const h = entry?.history || []
  const rejections = h.filter((e) => e.event === 'rejected').length
  const last = h.at(-1)?.event || ''
  const status = last === 'signed' ? 'signed' : last === 'submit' ? 'pending' : last === 'rejected' ? 'rejected' : 'unsubmitted'
  const label = status === 'signed' ? '已签约' : status === 'pending' ? '已投稿，等编辑结果' : status === 'rejected' ? `被拒 ${rejections} 次` + (rejections >= 3 ? '（三次机会已用完）' : '') : '未投稿'
  const notes = h.filter((e) => e.event === 'rejected' && e.note).map((e) => `${String(e.at).slice(0, 10)}（${e.tier || '?'}档）：${e.note}`)
  return { status, rejections, label, notes }
}
// 打磨/续写时给 DeepSeek 的签约背景：被拒原话 + 零成本体检缺项（按这些优先改）
function signBrief(entry, check) {
  const s = signStatus(entry)
  const lines = []
  if (s.status === 'rejected' || s.notes.length) lines.push(`这本书投稿签约被拒过 ${s.rejections} 次。编辑原话：\n` + (s.notes.join('\n') || '（主办方没填原话）') + '\n被拒后最该改的是编辑最先看的部分：开篇前 3 章、书名、简介、封面。')
  if (check?.gaps?.length) lines.push('签约体检（零成本计数，对应官方明文拒签项）发现这些缺项，请优先改掉：\n' + check.gaps.map((g) => '- ' + g).join('\n'))
  return lines.join('\n\n')
}
// 沙箱累计花费（calls.ndjson），给收尾补全当预算基线
function sumCalls(sandbox) {
  try { return +fs.readFileSync(path.join(sandbox, 'calls.ndjson'), 'utf8').trim().split('\n').filter(Boolean).reduce((a, l) => { try { const x = JSON.parse(l); return a + (x.ok === false ? 0 : x.cost || 0) } catch { return a } }, 0).toFixed(5) } catch { return 0 }
}
const pkgOf = (sandbox, id) => { try { return JSON.parse(fs.readFileSync(path.join(sandbox, 'books', id, 'book.json'), 'utf8')).package || {} } catch { return {} } }
const redidPackage = (sandbox, id, since) => Date.parse(pkgOf(sandbox, id).updatedAt || 0) > since
const redidCover = (sandbox, id, since) => Date.parse(pkgOf(sandbox, id).cover?.at || 0) > since
function checkText(title, check, sign, next) {
  const m = check.metrics
  return `《${title}》签约体检（${new Date().toLocaleString('zh-CN')}；零成本计数，不是质量证明）\n\n签约状态：${sign.label}\n下次机会：${next ? `${next.tier}字档` + (next.ready ? '（字数已够）' : `，还差 ${next.short} 字`) : '三次机会已用完'}\n正文：${m.chapters} 章 / ${m.chars} 字\n书名 ${m.titleLen} 字｜简介 ${m.introLen} 字｜标签 ${m.tags} 个｜封面 ${m.cover ? '有' : '无'}\n开篇前 3 章：段落平均 ${m.paraAvg} 字（头部作品约 25）｜AI 腔口癖 ${m.ticsPerK}/千字｜破折号 ${m.dashPerK}/千字｜「不是…而是」${m.notButPerK}/千字\n\n缺项（建议投稿前清零）：\n${check.gaps.map((g) => '- ' + g).join('\n') || '- 无'}\n${sign.notes.length ? '\n编辑的拒签原话：\n' + sign.notes.map((n) => '- ' + n).join('\n') + '\n' : ''}\n说明：书好不好，最终只认编辑的签约结果。体检只把官方明文写出的拒签项（格式混乱、结构失常、AI 粗制滥造、包装不全）先挡掉；评审打分波动 6–14 分，不拿来当签约依据。\n`
}
export function deliverToDesktop(bookDir, root, opts) {
  const title = titleOf(bookDir)
  const name = deskName(title)
  const dest = path.join(root, name)
  const archive = path.join(root, '_旧版本')
  const tag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  fs.mkdirSync(root, { recursive: true })
  const occupied = fs.existsSync(dest) && fs.readdirSync(dest).length > 0
  if (!occupied) { fs.rmSync(dest, { recursive: true, force: true }); return { ...deliverBook(bookDir, dest, opts), note: '' } }
  const oldCount = chaptersIn(dest)
  const stageDir = path.join(root, '.new-' + tag)
  try {
    const r = deliverBook(bookDir, stageDir, opts)
    fs.mkdirSync(archive, { recursive: true })
    if (r.chapters < oldCount) {
      fs.renameSync(stageDir, path.join(archive, `${name}-${tag}-${r.chapters}章`))
      return { directory: dest, note: `这次只有 ${r.chapters} 章，少于桌面上现有的 ${oldCount} 章，所以没有替换；这次的结果收在 _旧版本` }
    }
    fs.renameSync(dest, path.join(archive, `${name}-${tag}-${oldCount}章`))
    fs.renameSync(stageDir, dest)
    return { directory: dest, note: `已替换桌面上原有的版本（${oldCount} 章 → ${r.chapters} 章），旧版本收在 _旧版本` }
  } catch (e) { fs.rmSync(stageDir, { recursive: true, force: true }); throw e }
}
// 短篇交付：沙箱 shorts/<id>/ 里写完（有 正文.md）的每一篇 → 桌面「<成果目录>\短篇\<标题>」，附正文 txt（去掉 md 标记、剥审稿批注）+ 投稿包 + 质量报告。
// writeBack 给了目录就把整篇复制回工坊真实的短篇库（同 id 已存在则不覆盖）。返回 [{ id, title, release, directory }]
export function deliverShorts(sandbox, root, { writeBack = '' } = {}) {
  const dir = path.join(sandbox, 'shorts')
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const id of fs.readdirSync(dir)) {
    const src = path.join(dir, id)
    if (!fs.existsSync(path.join(src, '正文.md'))) continue
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8')) } catch { }
    const title = meta.idea?.title || meta.package?.title || id
    let dest = path.join(root, '短篇', deskName(title))
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) dest += '-' + id
    fs.mkdirSync(dest, { recursive: true })
    const body = stripAnnot(fs.readFileSync(path.join(src, '正文.md'), 'utf8')).replace(/^#+\s*/gm, '').replace(/\*\*(.+?)\*\*/g, '$1')
    fs.writeFileSync(path.join(dest, '正文.txt'), body, 'utf8')
    for (const f of ['投稿包.md', '质量报告.md', '设定.md']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f))
    const release = meta.quality?.release || meta.refine?.release || ''
    if (writeBack && !fs.existsSync(path.join(writeBack, id))) fs.cpSync(src, path.join(writeBack, id), { recursive: true })
    out.push({ id, title, release, directory: dest })
  }
  return out
}
// 笔名：真人作者自己的笔名，由主办方在控制台里选/填，代理绝不自己起。常用的记下来，下次直接下拉选。
function readPens(dataDir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'pennames.json'), 'utf8')); return { names: Array.isArray(j.names) ? j.names.map(String).filter(Boolean).slice(0, 12) : [], last: String(j.last || '') } } catch { return { names: [], last: '' } }
}
function rememberPen(dataDir, name) {
  if (!name) return
  const cur = readPens(dataDir)
  const names = [name, ...cur.names.filter(n => n !== name)].slice(0, 12)
  fs.writeFileSync(path.join(dataDir, 'pennames.json'), JSON.stringify({ names, last: name }, null, 2), 'utf8')
}
// 唤醒修复工程师：子进程跑最新磁盘代码（见 createLab 里 wakeNow 的说明）
export function spawnWake(args, { exe = process.execPath, script = path.join(HERE, 'wake-fixer.mjs'), runProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.WORKSHOP_SANDBOX
    const kid = runProcess(exe, [script, ...args], { cwd: HERE, windowsHide: true, env })
    let out = '', err = ''
    kid.stdout?.on('data', (d) => { out += d })
    kid.stderr?.on('data', (d) => { err += d })
    kid.on('error', reject)
    kid.on('close', () => {
      const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'))
      try { if (line) return resolve(JSON.parse(line)) } catch {}
      reject(new Error((err.trim() || out.trim() || '唤醒脚本没有输出').split(/\r?\n/).pop()))
    })
  })
}
// 质量优先的任务分配（写进每个运行自己的沙箱）：writer=Claude 写稿/设定/改写/包装，gpt=另一家做评审与章纲，cheap 只做摘要类杂活
export const QUALITY_ASSIGN = { concept: 'writer', bible: 'writer', outline: 'gpt', plan: 'gpt', write1: 'writer', write2: 'cheap', write3: 'writer', write4: 'cheap', pair: 'gpt', fix: 'gpt', rubric: 'gpt', summary: 'cheap', revise: 'writer', polish: 'writer', package: 'writer', packageJudge: 'gpt' }
// 质量优先档的默认额度：按工作量算，不卡死。主办方 2026-10-03：质量优先，成本不重要（上限仍在，防写错数字）。
export function qualityDefaults(units, isNew) {
  return { steps: Math.min(400, 60 + units * 12), budget: Math.min(100, Math.max(isNew ? 8 : 5, Math.round((units * 2.5 + 3) * 10) / 10)), minutes: Math.min(240, 40 + units * 8) }
}
export function createLab({ runProcess = spawn, dataDir = path.join(HERE, 'data', 'customer-lab'), libraryRoot = DEFAULT_BOOKS, sandboxRoot = DEFAULT_SOURCE, finalize = false, deskRoot = path.join(os.homedir(), 'Desktop', '清平文坊-客户成果'), queueFile = path.join(HERE, 'data', 'qa-queue.json'), wake = null, shortsRoot = DEFAULT_SHORTS } = {}) {
  const lib_ = () => library(libraryRoot, sandboxRoot)
  fs.mkdirSync(dataDir, { recursive: true })
  // 唤醒 GPT 修复工程师（可注入，测试不真的建任务）：force=true 跳过「攒满 10 条」阈值，仍保留「已有修复任务在跑就不叠加」
  // 2026-10-06：不能 import()——ES 模块会被缓存在这个常驻进程里，wake-fixer.mjs 修好后工作台仍用旧代码建任务（旧中文标题 → Connection error）。
  // 每次唤醒都起一个新子进程跑最新的 wake-fixer.mjs，输出最后一行 JSON。
  const wakeNow = wake || (() => spawnWake(['--force', '--json', '--dir=' + path.dirname(queueFile)]))
  const readQueue = () => { try { return JSON.parse(fs.readFileSync(queueFile, 'utf8')) } catch { return { items: [], triaged: [], wakes: [] } } }
  const writeQueue = (q) => { fs.writeFileSync(queueFile + '.tmp', JSON.stringify(q, null, 2), 'utf8'); fs.renameSync(queueFile + '.tmp', queueFile) }
  // DeepSeek 每一步记下的问题实时写进 <控制文件>.issues.ndjson（user-sim.mjs 写），这里读出来给页面
  const readIssues = (ctx) => { try { return fs.readFileSync(ctx.controlFile.replace(/\.json$/, '.issues.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
  const escalated = new Set()
  const bookRow = (id, v, sign) => {
    const dir = path.join(v.root, v.name)
    let check = null; try { check = checkBook(dir) } catch (e) { check = { metrics: {}, gaps: ['体检失败：' + e.message] } }
    const entry = sign.books[id]; const s = signStatus(entry)
    // 卡片显示 book.json 里当前采纳的书名（包装会改书名，文件夹名不跟着改）；不同时把文件夹名一并给出
    return { id, name: check.title || v.name, folder: v.name, label: v.label, chapters: v.chapters, chars: check.metrics.chars || 0, metrics: check.metrics, gaps: check.gaps, sign: s, history: (entry?.history || []).slice(-6), next: nextChance(check.metrics.chars || 0, s.rejections), busy: [...runs.values()].some((c) => c.state.running && c.bookKey === id) }
  }
  const token = crypto.randomBytes(24).toString('hex')
  // 定时任务是异步宿主；把实际执行结果同步回工作台，避免 POST 成功后网络错误仍永久显示“已排队”。
  async function syncWakeState(wakeState) {
    if (!wakeState?.jobId) return wakeState || {}
    try {
      const r = await fetch((process.env.DSH_WEB || 'http://127.0.0.1:3080') + '/api/dsh-timer-agent/jobs', { signal: AbortSignal.timeout(1500) })
      if (!r.ok) return wakeState
      const jobs = (await r.json()).jobs
      const job = Array.isArray(jobs) ? jobs.find(j => j.id === wakeState.jobId) : null
      if (!job) return wakeState
      const last = Array.isArray(job.executions) ? job.executions.at(-1) : null
      let status = wakeState.status || ''
      let error = ''
      if (last?.result === 'failed' || last?.error || job.status === 'failed') { status = 'failed'; error = String(last?.error || job.error || '任务执行失败') }
      else if (last?.result === 'succeeded' || job.status === 'completed') status = 'succeeded'
      else if (job.status === 'running') status = 'running'
      else if (job.status === 'archived' && !last?.endedAt) status = 'archived'
      else if (job.status === 'pending' || job.status === 'queued' || job.schedule?.enabled) status = 'scheduled'
      const next = { ...wakeState, status, error, jobStatus: job.status, executionId: last?.id || '' }
      if (next.status !== wakeState.status || next.error !== wakeState.error || next.jobStatus !== wakeState.jobStatus) {
        fs.writeFileSync(path.join(path.dirname(queueFile), 'qa-wake-state.json'), JSON.stringify(next, null, 2), 'utf8')
      }
      return next
    } catch { return wakeState }
  }
  // 并发：每次「开始」是一个独立的运行（独立沙箱、独立进程、独立预算、独立控制文件），放在 runs 里；互不干扰。
  // 同时运行的上限默认 3（环境变量 WORKSHOP_LAB_MAX 可改，最大 8）；同一本书不能同时被两个运行续写（否则写回会互相覆盖）。
  const MAX_RUNS = Math.min(8, Math.max(1, Number(process.env.WORKSHOP_LAB_MAX) || 3))
  const runs = new Map()
  let lastId = ''
  const idleState = { running: false, phase: 'ready', logs: [], reports: [], error: '' }
  const runningCount = () => [...runs.values()].filter(c => c.state.running).length
  const pickCtx = id => (id && runs.get(String(id))) || runs.get(lastId) || null
  const pickActive = id => { const c = id ? runs.get(String(id)) : null; if (c) return c; const act = [...runs.values()].filter(x => x.state.running); return act.length ? act[act.length - 1] : runs.get(lastId) || null }
  let triageChain = Promise.resolve() // 初审与唤醒修复工程师会读写同一个反馈队列，多个运行结束时排队串行执行
  const log = (ctx, text) => {
    const safe = String(text).replace(/(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+)/g, '[凭据隐藏]')
    ctx.state.logs.push(safe.slice(0, 12000)); ctx.state.logs = ctx.state.logs.slice(-150)
  }
  const save = ctx => { fs.writeFileSync(ctx.controlFile + '.tmp', JSON.stringify(ctx.control), 'utf8'); fs.renameSync(ctx.controlFile + '.tmp', ctx.controlFile) }
  const stopped = () => [ROOT, path.join(os.homedir(), 'Desktop')].some(d => fs.existsSync(path.join(d, 'STOP.txt')))
  const run = (ctx, file, args, env = {}) => new Promise(resolve => {
    const p = runProcess(process.execPath, [path.join(HERE, file), ...args], { cwd: HERE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    ctx.child = p
    p.stdout.on('data', b => log(ctx, b)); p.stderr.on('data', b => log(ctx, b))
    p.on('error', e => { ctx.state.error = e.message; resolve(1) })
    p.on('close', code => { clearTimeout(ctx.terminateTimer); if (ctx.child === p) ctx.child = null; resolve(code ?? 1) })
  })
  async function begin(body) {
    if (runningCount() >= MAX_RUNS) throw new Error(`同时最多运行 ${MAX_RUNS} 个，请等一个结束或先停止一个`)
    if (stopped()) throw new Error('发现 STOP.txt，请移除后再开始')
    // 三种起点，其余全部可选：new=从零开新书（懒人模式，什么都不用填）；continue=续写已有的书；custom=按主办方给的书名/题材/设定新建一本。
    // polish=打磨已有的书：不写新章，只改已有正文（重点开篇）、补/重做书名简介封面
    // short=写短篇：用工坊的「✍ 短篇投稿」从零写一篇短篇（知乎盐言/番茄短篇等），读完自己把关，交付到桌面
    const mode = ['new', 'continue', 'custom', 'polish', 'short'].includes(body.mode) ? body.mode : body.newBook ? 'custom' : body.book ? 'continue' : body.auto === true ? 'new' : ''
    if (!mode) throw new Error('请先选择：从零开新书、续写已有的书、打磨已有的书、按设定新建一本书，或写短篇')
    const short = mode === 'short'
    const polish = mode === 'polish'
    const what = polish ? { text: body.polishText !== false, pack: !!body.polishPack, cover: !!body.polishCover } : null
    if (polish && !what.text && !what.pack && !what.cover) throw new Error('打磨至少选一项：正文、书名简介、封面')
    const auto = mode === 'new' || short
    const persona = auto ? 'author' : ['customer', 'professional', 'skeptical', 'author'].includes(body.persona) ? body.persona : 'author'
    if (!['customer', 'professional', 'skeptical', 'author'].includes(persona)) throw new Error('请选择客户身份')
    body.persona = persona
    const isAuthor = persona === 'author'
    const style = String(body.style || '').trim().slice(0, 60)
    const idea = String(body.idea || '').trim().slice(0, 600)
    const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d }
    const chapters = clampInt(body.chapters, 1, 30, 5)
    const targetWords = clampInt(body.targetWords, 5000, 200000, 20000)
    const lib = lib_()
    const bookId = mode === 'continue' || polish ? String(body.book || '') : ''
    if ((mode === 'continue' || polish) && !lib.has(bookId)) throw new Error(polish ? '请选择要打磨的书稿' : '请选择要续写的书稿')
    if (polish && !lib.get(bookId).chapters) throw new Error('这本书还没有正文，没法打磨；请改用「续写」')
    const book = bookId ? lib.get(bookId).name : ''
    const newBook = mode === 'custom' && body.newBook && typeof body.newBook === 'object' ? body.newBook : null
    if (mode === 'custom' && !newBook) throw new Error('请填写新书的书名和一句话设定')
    const haveChapters = book ? lib.get(bookId).chapters : 0
    const penName = String(body.penName || '').trim().replace(/[\r\n]/g, '').slice(0, 20)
    // 质量优先默认开（只对写书的作者身份生效）：最强模型写稿和评审、逐章打磨、额度按工作量放宽
    const quality = isAuthor && body.quality !== false && body.quality !== 'off'
    const pen = penName ? `笔名已经由主办方定好是「${penName}」，封面上会用它，你不要改、不要另起。` : '笔名不要自己编，留空，在 issue 里记一句「笔名待用户填」。'
    const pack = `去「书名·简介·封面」，生成包装方案并采用、保存（书名不超过 15 字含标点，简介不超过 500 字），然后生成封面并看图：书名字不能错、画面要像番茄爆款封面，不满意就写具体改法重新生成，最多 3 次。${pen}`
    const qualityRules = quality ? `
你是一位靠这本书吃饭、想要签约的作者，对自己的作品有要求，希望编辑看了愿意签：
- 每章写完先自己读新章和评审报告，觉得有硬伤（人设漂移、设定矛盾、重复句式、注水、AI 腔、章末钩子虚）就自己决定要不要改、怎么改；改前改后对比，更好才采用。改几轮你自己定，别为了省钱草草收工。
- 「模型与 Agent」页面你可以自己试着搭配：哪个环节用哪个模型你自己选，觉得哪种搭配出来的文字更好就用哪种，并把你试了什么、结论是什么写进 issue（用于我们做默认配置）。
- 全部写完后从头回看一遍，开篇、伏笔、人物口吻有问题就回头改。只有正文达标、书名/简介/封面都备齐、并且你愿意署名，才用 done。` : ''
    const notes = '全程遇到的软件不好用的地方，都在 issue 里具体记下来（场景、阻碍、期望）。'
    // 签约背景：被拒原话 + 零成本体检缺项（续写和打磨都带上）
    let brief = ''
    if (bookId) { try { brief = signBrief(readSigning(dataDir).books[bookId], checkBook(path.join(lib.get(bookId).root, book))) } catch { /* 体检失败不阻塞 */ } }
    const polishTask = polish ? `你是「${book}」的作者，这本书已经写了 ${haveChapters} 章，准备拿去番茄投稿签约。这次【绝对不要写新章】（不要点「写下一章」「连写」），只打磨已有的内容：
${what.text ? `① 正文：先通读全部已有章节和评审报告，开篇前 3 章最重要（编辑先看开头决定签不签）。对不满意的章节用「按评审建议改写」，在改写意见里写你自己的具体要求（例如拆长段、删 AI 腔、第一章 1000 字内亮出金手指和一次冲突）；改完对比改前改后，更好才采用，改差了就放弃。改几轮你自己定。\n` : ''}${what.pack ? `② 书名·简介：去「书名·简介·封面」重新生成包装方案，挑最抓人的简介和标签采用并保存（书名不超过 15 字含标点，简介 50–500 字；书名原则上不改，除非你确信新书名明显更好）。\n` : ''}${what.cover ? `③ 封面：${pack}\n` : ''}④ 最后看一眼导出预览，满意就用 done 并写「满意，交付」。不满意就写「未满意，下次继续：<下次先做什么>」。${qualityRules}
${notes}` : ''
    const shortChannel = String(body.shortChannel || '').trim().slice(0, 40)
    const shortTask = short ? `你是一位靠短篇稿费吃饭的作者，这次用软件写一篇能投稿过审的短篇：
① 点顶部「✍ 短篇投稿」。${shortChannel ? `投稿渠道选「${shortChannel}」。` : '投稿渠道你自己挑一个最有把握的。'}${style ? `题材选「${style}」。` : '题材你自己挑。'}${idea ? `一句灵感填：${idea}` : '一句灵感你自己想一个有强钩子的，不要套路化。'}然后点「一键写短篇」，用 wait 等它写完（短篇要写很多步，可能要等很久，状态条还在跑就继续 wait，不要重复点）。
② 写完后在「已写短篇」里打开它，把正文从头读到尾（正文会完整给你），再看「投稿包」。像编辑一样挑毛病：开头 300 字有没有钩子、反转是否成立、人物动机、结尾爽不爽、有没有 AI 腔或重复句式、正文里有没有混进批注或说明文字。
③ 如果你觉得不满意，可以换题材或灵感再写一篇（总共最多 2 篇），挑你更愿意署名的那篇。
④ 最后用 done，think 里写清选哪篇、为什么，以及「满意，交付」或「未满意，下次继续：<下次先做什么>」。${quality ? '\n你对作品有要求：不要因为质量分高就满意，以你自己读下来的感受为准。' : ''}
${notes}` : ''
    const authorTask = short ? shortTask : polish ? polishTask : mode === 'new'
      ? `你是一位要靠这本书签约的网文作者，现在从零开始做一本新书并一路做到可以交给编辑：
① 在首页开一本新书。${style ? `风格选「${style}」。` : '风格你自己挑一个最有把握的（不用问我）。'}${idea ? `想法是：${idea}` : '一句话想法你自己想一个有钩子的，不要套路化。'}然后生成开书方案，挑一个你真心觉得最抓人的，开始。
② 把书写到 ${Math.round(targetWords / 1000) / 10} 万字以上：点「写下一章」，用 wait 等它写完，读新章和评审报告，明显不行就按评审建议改写。
③ ${pack}
④ 看一眼导出预览，满意就用 done 并写「满意，交付」。${qualityRules}
${notes}`
      : mode === 'continue'
        ? `你是「${book}」的作者，这本书已经写了 ${haveChapters} 章，现在接着往下写：
① 先打开这本书，读最近两章和章纲、设定集，保持人设、文风、伏笔连续，不要推翻已有设定。
② 再往下写 ${chapters} 章：点「写下一章」，用 wait 等它写完，读新章和评审报告，明显不行就按评审建议改写。
③ 如果书名、简介、封面还没做好就补上（${pack}）；已经做好的不要动。
④ 写完后看一眼导出预览，满意就用 done 并写「满意，交付」。${qualityRules}
${notes}`
        : `你是一位作者，主办方已经建好了一本新书（书名、题材、设定都在设定集里，不要改）：
① 先读设定集和章纲，必要时点「生成开书方案」补充，但不要推翻主办方给的设定。
② 往下写 ${chapters} 章：点「写下一章」，用 wait 等它写完，读新章和评审报告，明显不行就按评审建议改写。
③ ${pack}
④ 看一眼导出预览，满意就用 done 并写「满意，交付」。${qualityRules}
${notes}`
    const extra = String(body.task || '').trim().slice(0, 2000)
    let playbook = ''
    try { playbook = fs.readFileSync(path.join(HERE, 'data', 'author-playbook.md'), 'utf8').trim().slice(0, 3500) } catch { /* 还没有经验手册 */ }
    // 经验手册全是长篇操作（写下一章、章数、包装封面），短篇不拼，免得把它带偏
    const authorTaskP = playbook && !short ? authorTask + '\n\n前辈留下的操作经验（都是实测踩过的坑，照着做能少走弯路）：\n' + playbook : authorTask
    const withBrief = brief && isAuthor ? authorTaskP + '\n\n' + brief : authorTaskP
    const task = isAuthor ? (extra ? withBrief + '\n\n主办方补充要求（优先照办）：' + extra : withBrief) : (extra || '按你的身份体验这本书的改稿、评审、导出等主要功能，比较是否方便、能否保留原意，再把软件不好用的地方具体记在 issue 里。')
    // 打磨的工作量按已有章数算（每章可能改写一两轮），封面/包装另算一点
    // 短篇：一篇约 1–2 万字、流水线内部自带精修，按 4 个单位算（最多写 2 篇）
    const units = short ? 4 : mode === 'new' ? Math.ceil(targetWords / 2500) : polish ? Math.max(2, Math.min(haveChapters, 10)) : chapters
    const dflt = quality ? qualityDefaults(units, mode === 'new')
      : isAuthor
      ? { steps: Math.min(200, 30 + units * 5), budget: Math.min(5, Math.max(mode === 'new' ? 1.5 : 0.8, Math.round(units * (mode === 'new' ? 19 : 25)) / 100)), minutes: Math.min(60, 20 + units * 4) }
      : { steps: 25, budget: 0.6, minutes: 20 }
    const limits = { steps: Number(body.steps || dflt.steps), budget: Number(body.budget || dflt.budget), minutes: Number(body.minutes || dflt.minutes) }
    validateLimits(limits)
    const think = body.think === false || body.think === 'off' ? 'off' : 'on'
    // 模拟作者（操作软件的 AI）用哪个模型：主办方在工作台下拉里选「模型与 Agent」里已配置好密钥的 agent，默认 cheap
    const { publicConfig } = await import('./lib/agents.mjs')
    const simAgents = publicConfig().agents || {}
    const simAgent = String(body.simAgent || 'cheap')
    if (!simAgents[simAgent]) throw new Error(`没有这个模型「${simAgent}」，请在下拉里重新选`)
    if (simAgents[simAgent].keySource === '未配置') throw new Error(`「${simAgents[simAgent].name || simAgent}」还没有配置密钥，换一个或先到清平文坊「模型与 Agent」里填 Key`)
    // 主办方只需要关心交付位置；始终在隔离沙箱里干活，写完后才复制回「我的书库」和桌面，原稿不被直接改动。
    const sourceWorkspace = path.resolve(DEFAULT_SOURCE)
    const deliveryRoot = path.resolve(String(body.deliveryWorkspace || path.join(os.homedir(), 'Desktop', '清平文坊-客户成果')))
    if (!fs.existsSync(sourceWorkspace)) throw new Error('当前测试书稿不存在，请先启动清平文坊并准备书稿')
    fs.mkdirSync(deliveryRoot, { recursive: true })
    // 同一本书同一时间只允许一个运行在写（续写会写回书库，两个同时写会互相覆盖）
    const bookKey = mode === 'continue' || polish ? bookId : mode === 'custom' ? '新建:' + safeBookId(newBook.title) : ''
    if (bookKey) { const busy = [...runs.values()].find(c => c.state.running && c.bookKey === bookKey); if (busy) throw new Error('这本书正在被另一个运行写作，请等它结束，或先停止它') }
    const id = crypto.randomUUID()
    const t0 = Date.now()
    const ctx = { id, controlFile: path.join(dataDir, id + '.json'), control: {}, state: {}, child: null, terminateTimer: null, bookKey }
    const controlFile = ctx.controlFile
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const testBook = auto ? '新书' : newBook ? safeBookId(newBook.title) : book
    // 一本书只对应桌面上一个文件夹（以书名命名）；开始时还不知道最终书名，先指向成果总目录，写完后再定位到具体那本书
    const deliveryWorkspace = deliveryRoot
    const keepDir = path.join(dataDir, 'runs', id)
    const keepBooks = path.join(keepDir, 'books'); fs.mkdirSync(keepBooks, { recursive: true })
    const selectedBook = auto ? '' : newBook ? createTestBook(keepBooks, newBook) : book
    if (book) copyBook(lib.get(bookId).root, book, keepBooks)
    const sourceForSim = keepBooks
    const control = ctx.control; Object.assign(control, { runId: id, revision: 0, mode: 'run', sourceWorkspace, deliveryWorkspace, deliveryBaseline: '', book: selectedBook, sourceBook: book || null, backupRoot: deliveryRoot, sourceRoot: book ? lib.get(bookId).root : '', sourceHash: book ? safeHash(path.join(lib.get(bookId).root, book)) : '', writeBack: isAuthor && body.writeBack !== false, mode, newBook: newBook || null, sandbox: keepDir, messages: [{ at: new Date().toISOString(), text: task }] }); save(ctx)
    writeWorkspaceConfig(dataDir, { sourceWorkspace })
    // 沙箱设置：真实设置的副本 + 主办方选定的笔名（user-sim 只在沙箱没有 settings.json 时才会复制，所以这里先写好）
    try {
      let set = {}; try { set = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'settings.json'), 'utf8')) } catch {}
      if (penName) set.penName = penName
      // 去 AI 腔（lib/tics.mjs）：只在 AI 模拟作者的沙箱默认打开，持续积累 A/B 数据；真人实例仍默认关。主办方给了 detic 就按主办方
      if (set.detic === undefined) set.detic = body.detic !== false
      fs.writeFileSync(path.join(keepDir, 'settings.json'), JSON.stringify(set, null, 2), 'utf8')
      if (penName) rememberPen(dataDir, penName)
    } catch (e) { log(ctx, '笔名写入沙箱失败：' + e.message) }
    // 质量优先：写作/包装用最强模型，评审用另一家模型（不让写稿人给自己打分）。只写在沙箱里，不动真实的「模型与 Agent」配置
    // 不再强制指定模型：沙箱里的模型分配由作者自己在「模型与 Agent」页改，默认用真实配置
    control.quality = quality; control.penName = penName
    const state = ctx.state; Object.assign(state, { quality, penName, running: true, phase: 'testing', logs: [], reports: [], error: '', id, budget: limits.budget, persona: body.persona, sourceWorkspace, deliveryWorkspace, book: selectedBook, newBook: !!newBook, auto, mode, think, sourceChapters: selectedBook ? chapterCount(keepDir, selectedBook) : 0, sandbox: keepDir }); runs.set(id, ctx); lastId = id
    control.polish = what
    state.simAgent = simAgent; state.simModel = simAgents[simAgent].model; state.short = short
    log(ctx, (short ? `写短篇：模拟作者在隔离沙箱用「✍ 短篇投稿」从零写一篇${shortChannel ? '（渠道：' + shortChannel + '）' : ''}${style ? '（题材：' + style + '）' : ''}` : polish ? `打磨「${selectedBook}」（已有 ${haveChapters} 章，不写新章）：${[what.text && '改正文', what.pack && '重做书名简介', what.cover && '重做封面'].filter(Boolean).join('、')}；先在隔离沙箱里改，不会动原稿` : auto ? `懒人模式：DeepSeek 在隔离沙箱从零开新书${style ? '（风格：' + style + '）' : '（风格由它自己选）'}` : newBook ? `按你给的设定新建「${selectedBook}」，DeepSeek 接着往下写 ${chapters} 章` : isAuthor ? `续写「${selectedBook}」（已有 ${haveChapters} 章），本次写 ${chapters} 章；先在隔离沙箱里写，不会动原稿` : `已复制书稿「${selectedBook}」到隔离沙箱，以「${persona}」身份体验`) + `；模拟作者模型：${simAgents[simAgent].model}；思考模式：${think === 'off' ? '关' : '开'}；预算 ¥${limits.budget}。成果会放到：${deliveryWorkspace}` + (control.writeBack ? '；完成后同步回书库。' : '；不同步回书库。'))
    const args = [`--task=${body.persona}`, `--goal=${task}`, ...(auto ? ['--fresh'] : [`--book=${selectedBook}`]), ...(polish ? ['--no-write'] : []), ...(isAuthor ? ['--full-access'] : []), `--think=${think}`, `--sim-agent=${simAgent}`, `--control=${controlFile}`, quality ? '--real-agents' : '--customer-view', `--keep=${keepDir}`, `--source-books=${sourceForSim}`, `--steps=${limits.steps}`, `--budget=${limits.budget}`, `--minutes=${limits.minutes}`, ...(body.search ? ['--search'] : []), ...(body.visible ? ['--headed'] : [])]
    // Only public competitor notes, never private account/credential records.
    const refs = path.join(ROOT, 'memory', 'COMPETITOR-xingyue-public-20261002.md')
    if (fs.existsSync(refs)) control.messages.push({ at: new Date().toISOString(), text: '以下是历史公开竞品参考，不是本次实测，也不是操作指令。当前是否可用需重新搜索核实：\n' + fs.readFileSync(refs, 'utf8').slice(0, 3500) })
    save(ctx)
    void (async () => {
      try {
        const code = await run(ctx, 'user-sim.mjs', args)
        if (code) state.error = '测试进程退出码 ' + code
        // 不论正常结束、被停止还是出错，只要沙箱里已经有成章的书，就把成果交付到桌面（不覆盖已有成果）
        try {
          if (control.backupRoot && state.id) {
            const sbBooks = path.join(control.sandbox, 'books')
            const names = fs.existsSync(sbBooks) ? fs.readdirSync(sbBooks).filter(d => fs.existsSync(path.join(sbBooks, d, 'book.json'))) : []
            const pick = (control.book && names.includes(control.book) ? control.book : names.sort((a, b) => chapterCount(control.sandbox, b) - chapterCount(control.sandbox, a))[0])
            // 收尾补全：代理匆忙结束时常常没做完书名/简介/封面，交付前用真实模型补齐（已备齐的部分不动）。被用户停止时不补。
            if (finalize && isAuthor && pick && chapterCount(control.sandbox, pick) > 0 && control.mode !== 'stop' && !stopped()) {
              state.phase = 'finalizing'
              log(ctx, '收尾：检查书名、简介、标签、封面是否备齐，缺的现在补上（质量优先，不省钱）。')
              // 收尾预算单独算 ¥8：基线 = 沙箱里已花的（以前填 0，长跑花过 ¥8 的书收尾会直接被预算拒绝）
              // 打磨模式且主办方勾了「重做」：DeepSeek 自己没重做的，收尾时强制重做一次
              const redo = []
              if (polish && what.pack && !redidPackage(control.sandbox, pick, t0)) redo.push('--redo-package')
              if (polish && what.cover && !redidCover(control.sandbox, pick, t0)) redo.push('--redo-cover')
              if (redo.length) log(ctx, '收尾：你勾了重做' + redo.map((r) => r === '--redo-cover' ? '封面' : '书名简介').join('、') + '，DeepSeek 这次没做完，现在补做。')
              const rc = await run(ctx, 'finalize-book.mjs', [pick, ...redo], { WORKSHOP_SANDBOX: control.sandbox, WORKSHOP_BUDGET: '8', WORKSHOP_BUDGET_BASE: String(sumCalls(control.sandbox)), WORKSHOP_FORCE_AGENT: '' })
              if (rc) log(ctx, '收尾补全没有完全成功（看上面的日志）；已有的内容照常交付，缺项会写在「番茄填写单」里。')
              state.phase = 'testing'
            }
            if (pick && chapterCount(control.sandbox, pick) > 0) {
              let settings = {}
              try { settings = JSON.parse(fs.readFileSync(path.join(control.sandbox, 'settings.json'), 'utf8')) } catch {}
              state.book = pick; state.chapters = chapterCount(control.sandbox, pick)
              try {
                const r = deliverToDesktop(path.join(sbBooks, pick), control.backupRoot, { penName: settings.penName || '' })
                control.deliveryWorkspace = state.deliveryWorkspace = r.directory
                state.delivered = true
                log(ctx, '已把成果（封面、正文、简介）放到桌面：' + r.directory + (r.note ? '；' + r.note : ''))
                // 每次交付都附一份签约体检，和正文、封面放一起（零成本）
                try { const ck = checkBook(path.join(sbBooks, pick)); const s = signStatus(readSigning(dataDir).books[bookId]); fs.writeFileSync(path.join(r.directory, '签约体检.txt'), checkText(titleOf(path.join(sbBooks, pick)), ck, s, nextChance(ck.metrics.chars, s.rejections)), 'utf8'); log(ctx, `签约体检：${ck.gaps.length ? ck.gaps.length + ' 项缺项（见桌面文件夹里的「签约体检.txt」）' : '没有发现明文拒签项'}`) } catch (e) { log(ctx, '签约体检失败：' + e.message) }
                if (polish && chapterCount(control.sandbox, pick) > haveChapters) log(ctx, `⚠ 打磨模式下章数从 ${haveChapters} 变成了 ${chapterCount(control.sandbox, pick)}，请检查`)
              } catch (e) { log(ctx, '桌面成果整理失败：' + e.message) }
              if (control.writeBack) {
                try { log(ctx, syncBack(control, pick, libraryRoot)) } catch (e) { log(ctx, '同步回书库失败（沙箱里的书仍保留在 ' + control.sandbox + '）：' + e.message) }
              }
            } else if (!short) log(ctx, '这次还没有写出完整章节，没有生成桌面成果。')
            if (short) {
              try {
                const got = deliverShorts(control.sandbox, control.backupRoot, { writeBack: control.writeBack ? shortsRoot : '' })
                if (got.length) { control.deliveryWorkspace = state.deliveryWorkspace = got[0].directory; state.delivered = true; log(ctx, `已把 ${got.length} 篇短篇放到桌面：` + got.map((g) => `${g.title}${g.release ? '（' + g.release + '）' : ''}→ ${g.directory}`).join('；') + (control.writeBack ? '；并已同步回清平文坊的「已写短篇」。' : '')) }
                else log(ctx, '这次没有写完的短篇，没有生成桌面成果。')
              } catch (e) { log(ctx, '短篇交付失败：' + e.message) }
            }
          }
        } catch (e) { log(ctx, '交付成果失败：' + e.message) }
        if (code) return
        const dir = path.join(HERE, 'data', 'user-sim')
        state.reports = fs.readdirSync(dir).filter(f => f.endsWith('.json')).filter(f => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).runId === id } catch { return false }
        }).slice(-3)
        if (control.mode === 'stop' || stopped()) { log(ctx, '已停止，原始报告保留；不追加初审或唤醒。'); return }
        if ((auto ? body.triage !== false : body.triage) && state.reports.length) {
          state.phase = 'triage'
          // 初审和唤醒工程师共用一个反馈队列：多个运行同时结束时排队串行，避免互相覆盖队列文件
          const job = triageChain.catch(() => {}).then(async () => {
            const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-triage-'))
            try {
              const rc = await run(ctx, 'triage.mjs', state.reports.map(f => path.join(dir, f)), { WORKSHOP_SANDBOX: sb, WORKSHOP_BUDGET: '0.15' })
              if (rc !== 0 && rc !== 3) { state.error = '初审未完成，报告已保留'; return }
            } finally { fs.rmSync(sb, { recursive: true, force: true }) }
            if (control.mode !== 'stop' && !stopped()) { state.phase = 'wake-check'; const rc = await run(ctx, 'wake-fixer.mjs', []); if (rc) state.error = '工程师唤醒未成功，请看日志' }
          })
          triageChain = job
          await job
        }
      } catch (e) { state.error = e.message; log(ctx, e.message) }
      finally { state.running = false; state.phase = control.mode === 'stop' ? 'stopped' : state.error ? 'error' : 'complete' }
    })()
    return { id }
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, data, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data) }
    const origin = `http://127.0.0.1:${server.address().port}`
    if (req.headers.host !== new URL(origin).host) return reply(403, { error: '只允许本机访问' })
    try {
      // 按路径匹配：管理后台嵌入时带 ?embed=1（以前严格比较 req.url === '/'，带参数就 404）
      if (req.method === 'GET' && req.url?.split('?')[0] === '/') return reply(200, fs.readFileSync(path.join(HERE, 'ui', 'customer-lab.html'), 'utf8').replaceAll('__TOKEN__', token), 'text/html; charset=utf-8')
      if (req.method === 'GET' && req.url?.split('?')[0] === '/api/state') {
        const focus = pickActive(new URL(req.url, origin).searchParams.get('run')); const state = focus ? focus.state : idleState, control = focus ? focus.control : {}
        const { publicConfig } = await import('./lib/agents.mjs')
        const a = publicConfig().agents.cheap || {}
        const cfg = { sourceWorkspace: DEFAULT_SOURCE }
        const sourceWorkspace = cfg.sourceWorkspace || DEFAULT_SOURCE
        const pens = readPens(dataDir)
        const q = readQueue()
        const openItems = (q.items || []).filter((i) => i.status === 'open')
        let wakeState = {}; try { wakeState = JSON.parse(fs.readFileSync(path.join(path.dirname(queueFile), 'qa-wake-state.json'), 'utf8')) } catch { }
         wakeState = await syncWakeState(wakeState)
        const issues = focus ? readIssues(focus).slice(-60).map((x, i) => ({ ...x, idx: i, sent: escalated.has(focus.id + ':' + x.step) })) : []
        return reply(200, { ...state, issues, openIssues: openItems.slice(-30).reverse().map((i) => ({ id: i.id, title: i.title, severity: i.severity, kind: i.kind, hits: i.hits || 1, manual: i.source === 'host-escalated' })), fixedCount: (q.items || []).filter((i) => i.status === 'fixed').length, lastWake: { at: wakeState.lastWakeAt || '', status: wakeState.status || '', by: wakeState.lastWakeBy || '', error: wakeState.error || '', jobStatus: wakeState.jobStatus || '' }, pens: pens.names, lastPen: pens.last, mode: control.mode, focusId: focus ? focus.id : '', maxRuns: MAX_RUNS, runningCount: runningCount(), runs: [...runs.values()].map(c => ({ id: c.id, running: !!c.state.running, phase: c.state.phase, book: c.state.book || (c.state.auto ? '新书（懒人模式）' : ''), mode: c.state.mode, paused: c.control.mode === 'pause', error: c.state.error || '' })), sourceWorkspace, workspaces: [DEFAULT_SOURCE, path.join(HERE, 'data', 'author-sandbox'), DEFAULT_BOOKS].filter((v, i, a) => fs.existsSync(v) && a.indexOf(v) === i), books: [...lib_().keys()], library: [...lib_().entries()].map(([id, v]) => ({ id, name: v.name, label: v.label, chapters: v.chapters })), chapterCounts: Object.fromEntries([...lib_().entries()].map(([n, v]) => [n, v.chapters])), queueOpen: openItems.length, styles: publicStyles().map(s => ({ id: s.id, label: s.label })), model: a.model, priceIn: a.priceIn, priceOut: a.priceOut, simAgents: Object.entries(publicConfig().agents || {}).map(([id, x]) => ({ id, label: `${x.name || id}（${x.model}）`, model: x.model, priceIn: x.priceIn, priceOut: x.priceOut, ready: x.keySource !== '未配置' })), shortChannels: Object.entries(SHORT_CHANNELS).map(([id, c]) => ({ id, name: c.name })), shortGenres: SHORT_GENRES, pricingNote: '配置估价，非网关账单；单笔正在执行的请求可能使预算超出少量', wake: '攒满 10 条通用意见（或客户明确请求）自动唤醒 GPT-6.1 sol 修复；你也可以在「DeepSeek 实时发现的问题」里点「发给 GPT 立即修」提前唤醒；单任务防重叠；不唤醒 Opus', delivery: '测试完成后自动复制到桌面「清平文坊-客户成果」中以书名命名的文件夹；原稿不覆盖' })
      }
      // 书库总览：每本书的签约状态 + 零成本签约体检（缺项清单）
      if (req.method === 'GET' && req.url === '/api/books') {
        const sign = readSigning(dataDir)
        return reply(200, { books: [...lib_().entries()].filter(([, v]) => v.label === '我的书库').map(([id, v]) => bookRow(id, v, sign)), deskRoot })
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/report?')) {
        const f = new URL(req.url, origin).searchParams.get('name')
        if (![...runs.values()].some(c => c.state.reports?.includes(f))) return reply(404, { error: '没有该报告' })
        return reply(200, { text: fs.readFileSync(path.join(HERE, 'data', 'user-sim', f.replace(/\.json$/, '.md')), 'utf8') })
      }
      if (req.method !== 'POST') return reply(404, { error: '没有该入口' })
      if (req.headers.origin !== origin || req.headers['x-lab-token'] !== token || !req.headers['content-type']?.startsWith('application/json')) return reply(403, { error: '请求校验失败，请重新打开页面' })
      let text = ''; for await (const part of req) { text += part; if (Buffer.byteLength(text) > 20000) return reply(413, { error: '内容过长' }) }
      const b = JSON.parse(text || '{}')
      if (req.url === '/api/workspace') {
        if (runningCount()) throw new Error('请先停止所有运行再切换工作区')
        const sourceWorkspace = path.resolve(String(b.sourceWorkspace || ''))
        const books = bookNames(sourceWorkspace)
        if (!books.length) throw new Error('该目录没有书稿；请选择含 books 子目录或书稿目录的工作区')
        writeWorkspaceConfig(dataDir, { sourceWorkspace })
        return reply(200, { sourceWorkspace, books, chapterCounts: Object.fromEntries(books.map(book => [book, chapterCount(sourceWorkspace, book)])) })
      }
      if (req.url === '/api/start') return reply(200, await begin(b))
      // 主办方觉得某条问题严重：直接排进修复队列（标「主办方加急」），并立即唤醒 GPT，不等攒满 10 条
      if (req.url === '/api/escalate') {
        const c = pickCtx(b.runId); if (!c) throw new Error('找不到这个运行')
        const it = readIssues(c).find((x) => x.step === Number(b.step)); if (!it) throw new Error('找不到这条问题')
        const key = c.id + ':' + it.step
        if (!escalated.has(key)) {
          const q = readQueue(); q.items = q.items || []
          const id = 'Q' + String(q.items.length + 1).padStart(3, '0')
          q.items.push({ id, status: 'open', kind: 'product', title: String(it.issue).slice(0, 200), severity: '高', hits: 1, evidence: [`运行 ${c.id} 第${it.step}步：${String(it.page || '').slice(0, 300)}`], why: '主办方在控制台手动判定为严重问题并加急', at: new Date().toISOString(), from: c.state.mode || 'author', source: 'host-escalated', verification: 'pending-code-reproduction', customerRequested: true, note: String(b.note || '').slice(0, 500) })
          writeQueue(q); escalated.add(key)
          log(c, `已把第 ${it.step} 步的问题加急排进修复队列（${id}）`)
        }
        let r; try { r = await wakeNow() } catch (e) { r = { woke: false, reason: '唤醒失败：' + e.message } }
        return reply(200, { ok: true, wake: r })
      }
      if (req.url === '/api/wake') { let r; try { r = await wakeNow() } catch (e) { r = { woke: false, reason: '唤醒失败：' + e.message } } return reply(200, { ok: true, wake: r }) }
      // 签约台账：投稿 / 签约成功 / 被拒（带编辑原话）。每次登记都存一份当时的体检快照，用来校准「什么样的书能签上」
      if (req.url === '/api/sign') {
        const lib = lib_(); const id = String(b.book || ''); if (!lib.has(id)) throw new Error('书库里没有这本书')
        const ev = String(b.event || ''); if (!['submit', 'signed', 'rejected', 'undo'].includes(ev)) throw new Error('登记类型不对')
        const sign = readSigning(dataDir); const entry = sign.books[id] ||= { name: lib.get(id).name, history: [] }
        if (ev === 'undo') { entry.history.pop() }
        else {
          const v = lib.get(id); let check = null; try { check = checkBook(path.join(v.root, v.name)) } catch { }
          const s = signStatus(entry)
          if (s.status === 'signed') throw new Error('这本书已登记为签约成功')
          if (ev === 'submit' && s.status === 'pending') throw new Error('这本书已经在等编辑结果，先登记结果')
          if (ev !== 'submit' && s.status !== 'pending') entry.history.push({ event: 'submit', at: new Date().toISOString(), auto: true, tier: (nextChance(check?.metrics?.chars || 0, s.rejections) || {}).tier || '', snapshot: check?.metrics || null })
          const tier = (nextChance(check?.metrics?.chars || 0, s.rejections) || {}).tier || ''
          entry.history.push({ event: ev, at: new Date().toISOString(), tier, note: String(b.note || '').trim().slice(0, 1000), snapshot: check?.metrics || null, gaps: check?.gaps || [] })
        }
        entry.name = lib.get(id).name; writeSigning(dataDir, sign)
        return reply(200, { ok: true, sign: signStatus(entry) })
      }
      // 体检报告写到桌面成果文件夹（和正文、封面放一起）并打开
      if (req.url === '/api/check') {
        const lib = lib_(); const id = String(b.book || ''); if (!lib.has(id)) throw new Error('书库里没有这本书')
        const v = lib.get(id); const dir = path.join(v.root, v.name); const check = checkBook(dir)
        const s = signStatus(readSigning(dataDir).books[id])
        const out = path.join(deskRoot, deskName(titleOf(dir))); fs.mkdirSync(out, { recursive: true })
        const f = path.join(out, '签约体检.txt'); fs.writeFileSync(f, checkText(titleOf(dir), check, s, nextChance(check.metrics.chars, s.rejections)), 'utf8')
        if (b.open !== false) spawn('explorer.exe', [out], { stdio: 'ignore', detached: true }).unref()
        return reply(200, { ok: true, file: f })
      }
      if (req.url === '/api/open-book') {
        const lib = lib_(); const id = String(b.book || ''); if (!lib.has(id)) throw new Error('书库里没有这本书')
        const out = path.join(deskRoot, deskName(titleOf(path.join(lib.get(id).root, lib.get(id).name))))
        if (!fs.existsSync(out)) throw new Error('桌面上还没有这本书的成果文件夹（跑一次续写或打磨后才会有）')
        spawn('explorer.exe', [out], { stdio: 'ignore', detached: true }).unref(); return reply(200, { ok: true })
      }
      if (req.url === '/api/open-result') {
        const d = (pickCtx(b.runId) || {}).state?.deliveryWorkspace
        if (!d || !fs.existsSync(d)) throw new Error('还没有成果文件夹')
        spawn('explorer.exe', [d], { stdio: 'ignore', detached: true }).unref(); return reply(200, { ok: true })
      }
      const ctx = pickActive(b.runId)
      if (!ctx || !ctx.state.running) return reply(409, { error: '目前没有运行中的测试' })
      const { state, control } = ctx
      if (req.url === '/api/correct') {
        if (state.phase !== 'testing') return reply(409, { error: '测试已结束，正在整理报告' })
        const msg = String(b.text || '').trim().slice(0, 2000); if (!msg) throw new Error('请输入纠正内容')
        control.messages.push({ at: new Date().toISOString(), text: msg }); control.messages = control.messages.slice(-12); control.revision++; save(ctx); log(ctx, '收到纠正：' + msg); return reply(200, { ok: true })
      }
      if (req.url === '/api/pause' || req.url === '/api/resume') { control.mode = req.url.endsWith('pause') ? 'pause' : 'run'; control.revision++; save(ctx); return reply(200, { ok: true }) }
      if (req.url === '/api/stop') {
        control.mode = 'stop'; control.revision++; save(ctx); log(ctx, '正在停止；不再发起下一步，已发出的服务端工作可能仍在完成。')
        if (state.phase !== 'testing') ctx.child?.kill()
        else ctx.terminateTimer = setTimeout(() => ctx.child?.kill(), 15000)
        return reply(200, { ok: true })
      }
      return reply(404, { error: '没有该入口' })
    } catch (e) { reply(400, { error: e.message }) }
  })
  server.on('close', () => { for (const c of runs.values()) { if (c.controlFile) { c.control.mode = 'stop'; try { save(c) } catch {} } c.child?.kill(); clearTimeout(c.terminateTimer) } })
  return server
}
// 固定端口 4569：管理后台（127.0.0.1:4570/admin）的「DeepSeek 作者与测试」标签页直接嵌入它，主办方只开一个管理界面
export const LAB_PORT = Number(process.env.WORKSHOP_LAB_PORT) || 4569
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const portArg = process.argv.find((a) => a.startsWith('--port='))
  const port = portArg ? Number(portArg.slice(7)) : LAB_PORT
  const server = createLab({ finalize: true })
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // 已经开着（比如管理后台拉起的）：直接打开管理后台的这个标签页，不再起第二个
      console.log(`工作台已经在运行：http://127.0.0.1:${port}，正在打开管理后台的「DeepSeek 作者与测试」标签页`)
      if (!process.argv.includes('--no-open')) spawn('cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:4570/admin#lab'], { stdio: 'ignore' })
      setTimeout(() => process.exit(0), 500); return
    }
    throw e
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`
    console.log('DeepSeek 作者与测试工作台：' + url + '\n也可以在管理后台 http://127.0.0.1:4570/admin#lab 里使用。关闭此窗口即可退出工作台。')
    if (!process.argv.includes('--no-open')) spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore' })
  })
  const quit = () => server.close(() => process.exit(0)); process.on('SIGINT', quit); process.on('SIGTERM', quit)
}

// server.mjs —— 清平文坊图形界面（本机访问，默认只监听 127.0.0.1:4580）
// 启动：双击 workshop\server.mjs
// ⚠ 没有登录认证，只监听本机回环地址；不要改成 0.0.0.0 暴露到局域网/公网。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { spawn } from 'node:child_process'
import * as PL from './lib/pipeline.mjs'
import * as S from './lib/store.mjs'
import * as PK from './lib/packaging.mjs'
import * as FQ from './lib/fanqie.mjs'
import * as CV from './lib/cover.mjs'
import { polishChapter, POLISH_MODES } from './lib/polish.mjs'
import { spentToday, recentCalls, precheck, abortCtl } from './lib/llm.mjs'
import { publicConfig, saveConfig } from './lib/agents.mjs'
import * as AG from './lib/agent.mjs'
import * as TG from './lib/tiers.mjs' // 2026-10-02 内测档位层：用户只见档位名，脱敏出口在这里
import { listFeedback, createFeedback, replyFeedback, adminFeedback } from './lib/feedback.mjs'
import { publicStyles } from './lib/styles.mjs'
import { publicVoices, resolveVoice } from './lib/voices.mjs'
import { MEME_MODES, normMemeMode } from './lib/memes.mjs'
import * as IM from './lib/importer.mjs'
import * as TL from './lib/tools.mjs' // 创意工具箱 + 章节划选 AI 动作
import { CHANNELS, GENRES, createShort, resumeShort, listShorts, shortDir, readMeta, qualityReport, gates } from './short/pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.WORKSHOP_PORT || 4580)
const HOST = '127.0.0.1'

// 后台任务：同一时间只跑一个（避免把钱烧穿、也避免两个任务写同一本书）
// live：实时看板（2026-10-03，开书先接）。fn 的第二个参数 setLive(obj) 由流式进度回调，界面轮询 /api/status 时一起拿走
const job = { running: false, label: '', step: '', startedAt: 0, error: '', done: '', result: null, outcome: null, live: null }
let jobController = null
function runJob(label, fn) {
  if (job.running) throw new Error('上一个任务还在进行中，请等它完成')
  jobController = new AbortController()
  abortCtl.signal = jobController.signal
  Object.assign(job, { running: true, label, step: '准备中', startedAt: Date.now(), error: '', done: '', result: null, outcome: null, live: null })
  fn((s) => { job.step = s }, (l) => { if (job.running) job.live = l }).then((r) => { job.result = r ?? null; job.done = label + ' 完成' + (r?.summary ? '：' + r.summary : ''); job.outcome = 'ok' }).catch((e) => { job.error = String(e.message || e); job.outcome = 'fail' }).finally(() => { job.running = false; if (abortCtl.signal === jobController?.signal) abortCtl.signal = null; jobController = null })
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
// 2026-10-02 内测脱敏出口：用户模式下一切错误文案/任务报错先清洗（泄漏词、URL、密钥样式），再出门
const out = (s) => (TG.CUSTOMER ? TG.sanitize(s) : s)
// 管理反馈入口：客户实例也可查看，但必须持有独立 token；普通 /admin 不泄漏是否存在。
const ADMIN_TOKEN = String(process.env.WORKSHOP_ADMIN_TOKEN || '')
const adminKey = (u) => ADMIN_TOKEN && u.searchParams.get('key') === ADMIN_TOKEN
// 先收齐字节再一次性 UTF-8 解码：旧写法 `s += chunk` 逐块转字符串，大请求里一个汉字被切在两块之间就会变成乱码（导入整本书时必中）
async function readBody(req, max = 1e6) {
  const bufs = []; let n = 0
  for await (const c of req) { n += c.length; if (n > max) throw new Error(max > 1e6 ? `文件太大（上限约 ${Math.round(max / 1e6)}MB），请分卷导入` : '请求太大'); bufs.push(c) }
  const s = Buffer.concat(bufs).toString('utf8')
  return s ? JSON.parse(s) : {}
}
const validId = (id) => typeof id === 'string' && /^[^\\/.][^\\/]*$/.test(id) && fs.existsSync(S.bookPath(id, 'book.json'))

// 2026-10-02 内测：额度信息（页面顶栏「已用 ¥x / 额度 ¥3 · 剩 N 天」）
import { spentTotal, liveQuota } from './lib/llm.mjs'
function budgetInfo() {
  const q = liveQuota() // 实时读台账：管理后台加额度/延期后页面顶栏马上变
  const budget = q.budget
  const spent = +spentTotal().toFixed(3)
  const exp = q.expires
  const daysLeft = exp ? Math.max(0, Math.ceil((Date.parse(exp) - Date.now()) / 86400000)) : 0
  return { budget, spent, left: budget ? +Math.max(0, budget - spent).toFixed(3) : 0, daysLeft, expired: !!exp && Date.now() > Date.parse(exp) }
}
// 会调模型的动作（内测用户模式先过 precheck：到期/超额人话拒绝，查看与导出不在此列）
function validateRevisionInstruction(value) {
  const text = String(value || '')
  if (text.length > 2000) throw new Error('改写意见超过 2000 字，未提交；请缩短后重试，原输入不会被截断')
  return text
}
const MODEL_ROUTES = new Set(['/api/concepts', '/api/start', '/api/write', '/api/revise', '/api/report', '/api/polish', '/api/package', '/api/cover', '/api/revision/compare', '/api/agent/plan', '/api/agent/start', '/api/agent/resume', '/api/tool', '/api/selection', '/api/short/new', '/api/short/resume'])
// 智能代理（Beta）：可选开关，默认关；关着时代理的所有写入类接口一律拒绝
const agentOn = () => !!PL.settings().agentBeta
const needAgent = () => { if (!agentOn()) throw new Error('智能代理（Beta）还没开启：先在「写正文」页打开「智能代理（Beta）」开关') }
const agentView = () => { const s = AG.readState(); return TG.CUSTOMER ? JSON.parse(TG.sanitize(JSON.stringify(s))) : s }

// 后端代码比进程新 = 页面（每次现读）和接口（启动时加载）不是同一版本。2026-10-01 真实事故：
// 改完代码没重启，新页面调旧接口，旧版本列表全是「Invalid Date」、点预览弹「找不到历史版本」。
const STARTED = Date.now()
// version.mjs 也要盯：2026-10-02 实测 server.mjs 先改、version.mjs 晚 1.5 秒才改，实例在中间重启读到旧版本号，之后再也不重启 → 页面一直报「版本不一致」
const CODE_FILES = () => [path.join(HERE, 'server.mjs'), path.join(HERE, 'version.mjs'), ...fs.readdirSync(path.join(HERE, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(HERE, 'lib', f))]
function codeStale() { try { return CODE_FILES().some((f) => fs.statSync(f).mtimeMs > STARTED) } catch { return false } }
const newestCodeMs = () => { try { return Math.max(...CODE_FILES().map((f) => fs.statSync(f).mtimeMs)) } catch { return 0 } }
const UI_FILE = path.join(HERE, 'ui', 'index.html')
const uiStamp = () => { try { return Math.round(fs.statSync(UI_FILE).mtimeMs) } catch { return 0 } }
import { API_VERSION } from './version.mjs' // 接口形状变了就加 1；页面不一致时提示重启

// 2026-10-06 修复工程师（管理后台「真人反馈」页用）：唤醒一律起子进程跑磁盘上最新的 wake-fixer.mjs，
// 不 import()——常驻进程里的 ES 模块缓存曾让旧代码一直建中文标题任务（会话 id 含中文进 HTTP 头 → Connection error）。
function runWakeFixer(args) {
  return new Promise((resolve) => {
    const env = { ...process.env }; delete env.WORKSHOP_SANDBOX
    const kid = spawn(process.execPath, [path.join(HERE, 'wake-fixer.mjs'), ...args], { cwd: HERE, windowsHide: true, env })
    let out = '', err = ''
    kid.stdout.on('data', (d) => { out += d }); kid.stderr.on('data', (d) => { err += d })
    kid.on('error', (e) => resolve({ woke: false, reason: '唤醒失败：' + e.message }))
    kid.on('close', () => {
      const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'))
      try { if (line) return resolve(JSON.parse(line)) } catch {}
      resolve({ woke: false, reason: '唤醒失败：' + ((err.trim() || out.trim() || '没有输出').split(/\r?\n/).pop()) })
    })
  })
}
// 最近一次唤醒 + 本地调度器里该任务的真实执行结果（失败原因直接展示给操作者）
async function fixerStatus() {
  let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'qa-wake-state.json'), 'utf8')) } catch {}
  const out = { lastWakeAt: st.lastWakeAt || '', lastWakeBy: st.lastWakeBy || '', status: st.status || '', error: st.error || '', jobId: st.jobId || '' }
  try {
    const r = await fetch((process.env.DSH_WEB || 'http://127.0.0.1:3080') + '/api/dsh-timer-agent/jobs', { signal: AbortSignal.timeout(5000) })
    const jobs = r.ok ? ((await r.json()).jobs || []) : []
    const job = jobs.find((j) => j.id === st.jobId)
    if (job) {
      const ex = (job.executions || []).slice(-1)[0] || {}
      out.job = { title: job.title || '', status: job.status || '', model: (job.modelSelection?.provider || '') + '/' + (job.modelSelection?.model || ''), result: ex.result || '', error: String(ex.error || '').slice(0, 300), startedAt: ex.startedAt ? new Date(ex.startedAt).toISOString() : '', endedAt: ex.endedAt ? new Date(ex.endedAt).toISOString() : '' }
    }
    out.dshOnline = r.ok
  } catch { out.dshOnline = false }
  return out
}

// 自动换新版本（2026-10-01 模拟作者报告：提示「关掉黑色窗口重开」在页面里做不到，用户不敢再用旧版本恢复）。
// 由 launcher.mjs（或 user-sim）托管时 WORKSHOP_SUPERVISED=1：代码更新且没有任务在跑 → 退出码 75，托管方立刻拉起新版本。
// 防半截代码：最后一次改动后静置 RESTART_QUIET_MS 才换（改代码的人可能还在连续改多个文件）。
const SUPERVISED = process.env.WORKSHOP_SUPERVISED === '1'
export const RESTART_CODE = 75
const RESTART_QUIET_MS = Number(process.env.WORKSHOP_RESTART_QUIET_MS || 20000)
let restarting = false
function restartNow(why) {
  if (restarting) return; restarting = true
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${why}，正在切换到新版本（几秒钟，页面不用关）…`)
  server.close(); setTimeout(() => process.exit(RESTART_CODE), 300)
}
if (SUPERVISED) setInterval(() => {
  if (!job.running && codeStale() && Date.now() - newestCodeMs() > RESTART_QUIET_MS) restartNow('检测到工坊程序已更新')
}, 3000).unref()
const restartInfo = () => ({ supervised: SUPERVISED, pendingRestart: SUPERVISED && codeStale(), uiStamp: uiStamp() })

const routes = {
  'POST /api/restart': () => {
    if (!SUPERVISED) throw new Error('这个后台不是用「start.cmd」启动的，没法在页面里重启：请关掉黑色窗口，重新双击「start.cmd」')
    if (job.running) throw new Error(`「${job.label}」还在进行中，等它完成后会自动切换到新版本，不用手动重启`)
    setTimeout(() => restartNow('页面要求重启后台'), 200); return { ok: true }
  },
  'GET /api/status': () => {
    const s = { apiVersion: API_VERSION, codeStale: codeStale(), ...restartInfo(), startedAt: new Date(STARTED).toISOString(), job: { ...job, error: out(job.error), live: job.live && TG.CUSTOMER ? JSON.parse(TG.sanitize(JSON.stringify(job.live))) : job.live, elapsed: job.running ? Math.round((Date.now() - job.startedAt) / 1000) : 0 }, spentToday: +spentToday().toFixed(3), settings: { ...PL.settings(), judgeNoise: PL.judgeNoise() }, polishModes: POLISH_MODES, agents: publicConfig() }
    if (TG.CUSTOMER) { s.customer = true; s.budget = budgetInfo() } // 内测用户：标记 + 额度/剩余天数给页面顶栏
    return s
  },
  'GET /api/books': () => S.listBooks(),
  // 多创作风格：给前端渲染风格选择区（不花钱、不需要额度闸门）
  'GET /api/styles': () => ({ ok: true, styles: publicStyles() }),
  'GET /api/short/channels': () => ({ channels: Object.values(CHANNELS).map((c, i) => ({ id: Object.keys(CHANNELS)[i], name: c.name, sweet: c.sweet, price: c.price, deadline: c.deadline || '', exclusive: c.exclusive, note: c.note || '', evidence: c.evidence || '' })), genres: GENRES }),
  'GET /api/shorts': () => listShorts().map((m) => ({ id: m.id, title: m.idea?.title || m.title || '未命名短篇', channel: CHANNELS[m.channelId]?.name || m.channelId, chars: m.gates?.chars ?? m.quality?.gates?.chars ?? null, release: m.quality?.release || m.release || 'blocked', reasons: m.quality?.reasons || m.reasons || [], cost: m.cost || 0, stage: m.stage || '', updatedAt: m.updatedAt || m.createdAt || '' })),
  'GET /api/short': (q) => {
    const id = String(q.id || '')
    const found = listShorts().some((m) => m.id === id)
    if (!found || !/^[^\\/.][^\\/]*$/.test(id)) throw new Error('短篇不存在')
    const meta = readMeta(id)
    const quality = meta.quality || qualityReport(id)
    return { meta: { id: meta.id, title: meta.idea?.title || '未命名短篇', channelId: meta.channelId, genre: meta.genre, release: quality.release, reasons: quality.reasons || [], cost: meta.cost || 0, stage: meta.stage || '', updatedAt: meta.updatedAt || meta.createdAt || '' }, body: fs.existsSync(path.join(shortDir(id), '正文.md')) ? fs.readFileSync(path.join(shortDir(id), '正文.md'), 'utf8') : '', package: fs.existsSync(path.join(shortDir(id), '投稿包.md')) ? fs.readFileSync(path.join(shortDir(id), '投稿包.md'), 'utf8') : '', quality: { retention: quality.retention || null, anchor: quality.anchor || null, unresolved: quality.unresolved ?? null, gates: quality.gates || gates(id) } }
  },
  'POST /api/short/new': (_, body) => {
    const channelId = String(body.channelId || ''), genre = String(body.genre || ''), idea = String(body.idea || '').slice(0, 500)
    const opts = TG.CUSTOMER ? { refineRounds: 1, refineBudget: 1.5 } : { refineRounds: 2, refineBudget: 3 }
    runJob('写短篇', async (step) => { const r = await createShort({ channelId, genre, idea, ...opts }, { onStep: step }); return { id: r.id, summary: r.idea?.title || '' } })
    return { ok: true }
  },
  'POST /api/short/resume': (_, body) => {
    const id = String(body.id || '')
    if (!listShorts().some((m) => m.id === id) || !/^[^\\/.][^\\/]*$/.test(id)) throw new Error('短篇不存在')
    const opts = TG.CUSTOMER ? { refineRounds: 1, refineBudget: 1.5 } : { refineRounds: 2, refineBudget: 3 }
    runJob('续写短篇', async (step) => { const r = await resumeShort(id, { ...opts, onStep: step }); return { id: r.id, summary: r.idea?.title || '' } })
    return { ok: true }
  },
  // 客户反馈：按访客凭证隔离线程；自动客服先答复，产品问题同步进 QA 队列
  'GET /api/feedback': (q) => listFeedback(String(q.visitor || '')),
  'POST /api/feedback': (_, body) => createFeedback(body),
  'POST /api/feedback/reply': (_, body) => replyFeedback(String(body.id || ''), body),
  'GET /api/book': (q) => {
    if (!validId(q.id)) throw new Error('书不存在')
    const b = S.readBook(q.id)
    const pk = S.readJson(q.id, 'package.json', {})
    const pkg = { ...(b.package || {}) }
    if (!pkg.intro) pkg.intro = PK.introFromConcept(q.id)
    pkg.defaultAudience = PK.audienceOfBook(b) // 作品信息「目标读者」默认值（按创作风格）
    const chapters = b.chapters.map((c) => ({ ...c, pendingRevision: !!S.readText(q.id, 'work', S.pad(c.n), 'revision.json') }))
return { ...b, chapters, package: pkg, packageDraft: pk.latest || null, concept: S.readText(q.id, 'concept.md'), outline: PL.outlineRows(q.id), bible: S.readText(q.id, 'bible.md'), characterCard: S.readCharacterCard(q.id), log: S.readText(q.id, 'progress.log').split('\n').slice(-30).join('\n') }
  },
  // ── 模型与 Agent ──
  // 内测用户模式：/api/agents* 一律 403（见请求分发处），档位只读、切换走 /api/tier
  'GET /api/agents': () => publicConfig(),
  'POST /api/agents': (_, body) => saveConfig(body),
  'POST /api/agents/ping': async (_, body) => { const { pingAgent } = await import('./lib/llm.mjs'); try { return await pingAgent(String(body.id || '')) } catch (e) { return { ok: false, error: out(String(e.message || e)) } } },
  'GET /api/calls': () => recentCalls(40).map((c) => TG.CUSTOMER
    ? { at: c.at, task: c.task, agent: TG.modelToLabel(c.model), model: TG.modelToLabel(c.model), ok: c.ok, ms: c.ms, cost: c.cost, err: out(c.err) } // 用户侧只见档位名
    : { at: c.at, task: c.task, agent: c.agentName || c.role || c.agent, model: c.model, ok: c.ok, ms: c.ms, cost: c.cost, err: c.err }),
  'POST /api/tier': (_, body) => { if (!TG.CUSTOMER) throw new Error('这个接口只在内测用户模式可用'); return { ok: true, ...TG.setTier(String(body.tier || '')) } },
  // ── 包装：书名 / 简介 / 封面提示词 ──
  'POST /api/package': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    runJob('生成包装方案', async (step) => PK.generatePackage(body.id, String(body.instruction || '').slice(0, 1000), { onStep: step, currentMeta: body.meta && typeof body.meta === 'object' ? body.meta : null })); return { ok: true }
  },
  'POST /api/package/apply': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    const b = PK.applyPackage(body.id, { title: body.title, intro: body.intro, tags: body.tags, meta: body.meta, coverPrompt: body.coverPrompt })
    return { ok: true, title: b.title }
  },
  // 番茄「创建作品」页的真实字段限制与标签词表（界面渲染选择器、校验用，不花钱）
  'GET /api/fanqie-spec': () => ({ ok: true, spec: FQ.SPEC }),
  'POST /api/cover': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    runJob('生成封面', async (step) => { const r = await CV.generateCover(body.id, { extra: String(body.extra || '').slice(0, 500), onStep: step }); return { file: r.file } }); return { ok: true }
  },
  'POST /api/cover/recompose': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    const cover = S.readBook(body.id).package?.cover
    const current = S.readBook(body.id)
    if (cover?.file && cover.coverTitle === current.title && cover.coverPen === (PL.settings().penName || '')) return { ok: true, unchanged: true }
    // AI 写字封面需要付费异步编辑；无变化不启动任务。
    if (cover?.textMode === 'ai') { runJob('封面改字', async (step) => { const r = await CV.retextCover(body.id, { onStep: step }); return { file: r.file } }); return { ok: true, aiText: true } }
    return { file: CV.recomposeCover(body.id) }
  },
  'GET /api/hits': () => PK.hitSamples('urban-naodong', 15),
  // ── 创意工具箱：工具清单由后端给，前端按清单渲染；id 可空 = 不绑定书 ──
  'GET /api/tools': () => ({ ok: true, tools: TL.toolList() }),
  'POST /api/tool': (_, body) => {
    const id = body.id ? String(body.id) : ''
    if (id && !validId(id)) throw new Error('书不存在')
    const tool = String(body.tool || '')
    TL.checkTool(tool, body.inputs, { bound: !!id }) // 先校验，错了直接报，不占任务队列
    runJob(`创意工具箱：${TL.toolLabel(tool)}`, async (step) => TL.runTool({ id, tool, inputs: body.inputs }, { onStep: step })); return { ok: true }
  },
  // ── 章节划选 AI 动作：只生成候选，不改正文；替换由前端走 /api/save ──
  'POST /api/selection': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    const n = Number(body.n)
    if (!S.readText(body.id, 'chapters', S.pad(n) + '.txt')) throw new Error('这一章还没有定稿正文')
    const req = TL.checkSelection(body) // 先校验，错了直接报
    runJob(`划选${TL.actionLabel(req.action)}：第 ${n} 章`, async (step) => TL.runSelection(body.id, n, req, { onStep: step })); return { ok: true }
  },
  // ── 评审报告重试 / 润色 ──
  'POST /api/report': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    runJob(`重做第 ${body.n} 章评审报告`, async (step) => { step('评审员打分中（约 1 分钟）'); const r = await PL.rerunReport(body.id, Number(body.n)); if (r.error) throw new Error(r.error) }); return { ok: true }
  },
  'POST /api/polish': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    // 作者在章节页主动点「人工润色」= 就是要润色：设置里还是「关闭」时直接用 LLM 版（2026-10-02 内测：用户找不到开关，以为功能不能用）
    let mode = String(body.mode || PL.settings().polish || 'off')
    if (mode === 'off') mode = 'llm'
    if (!POLISH_MODES[mode]) throw new Error('没有这个润色模式')
    runJob(`润色第 ${body.n} 章`, async (step) => { step(`${POLISH_MODES[mode]}润色中（规则版几秒，LLM 版几分钟）`); return polishChapter(body.id, Number(body.n), mode) }); return { ok: true }
  },
  'POST /api/polish/adopt': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    const n = Number(body.n); const t = S.readText(body.id, 'work', S.pad(n), 'polished.txt'); if (!t) throw new Error('还没有润色稿')
    const old = S.readBook(body.id).chapters.find((c) => c.n === n) || {}
    S.commitChapter(body.id, n, t, { ...old, polished: (old.polished || 0) + 1, chars: t.replace(/\s/g, '').length, scoreStale: true }, { reason: '采用润色稿' }); return { ok: true }
  },
  'GET /api/chapter': (q) => {
    if (!validId(q.id)) throw new Error('书不存在')
    const n = Number(q.n); const W = `work/${S.pad(n)}`
    const cands = []; for (let k = 1; k <= 6; k++) { const t = S.readText(q.id, ...`${W}/cand-${k}.txt`.split('/')); if (t) cands.push(t) }
    return { text: S.readText(q.id, 'chapters', S.pad(n) + '.txt'), report: S.readJson(q.id, `${W}/report.json`), revision: S.readJson(q.id, `${W}/revision.json`), meta: S.readBook(q.id).chapters.find((c) => c.n === n) || null, textHash: S.bodyHash(S.readText(q.id, 'chapters', S.pad(n) + '.txt')), judge: S.readJson(q.id, `${W}/judge.json`), plan: S.readText(q.id, ...`${W}/plan.md`.split('/')), candidates: cands, history: S.listHistory(q.id, n), polished: S.readText(q.id, ...`${W}/polished.txt`.split('/')), polishInfo: S.readJson(q.id, `${W}/polish.json`) }
  },
  'POST /api/concepts': (_, body) => { runJob('生成开书方案', async (step) => { step('主编正在构思 3 个方案（约 1 分钟）'); const r = await PL.proposeConcepts(String(body.idea || '').slice(0, 500), body.style, body.voice); return r.list }); return { ok: true } },
  // 文风（笔调）清单 + 玩梗模式清单：给前端渲染（不花钱）
  'GET /api/voices': () => ({ ok: true, voices: publicVoices(), memeModes: MEME_MODES }),
  // 带稿导入：拆章落库不调模型、不花钱；第一次「写下一章」时才整理设定（pipeline.ensureImportedFoundation）
  'POST /api/import': (_, body) => {
    if (job.running) throw new Error('有任务在进行中，请等它完成')
    const r = IM.importBook({ title: body.title, text: String(body.text || ''), style: body.style })
    return { ok: true, id: r.book.id, title: r.book.title, chapters: r.chapters, chars: r.chars, warnings: r.warnings }
  },
  'POST /api/start': (_, body) => {
    const concept = String(body.concept || '').slice(0, 8000); if (!/书名[:：]/.test(concept)) throw new Error('方案内容不完整')
    // 时长按 2026-10-03 开书日志实测：设定集中位 43 秒、章纲中位 61 秒
    runJob('开书', async (step, setLive) => { step('正在生成设定集和前 10 章章纲（约 2 分钟）'); const b = await PL.startBook(concept, String(body.idea || ''), body.style, { voice: body.voice, memeMode: body.memeMode, onLive: setLive }); return { id: b.id } }); return { ok: true }
  },
  'POST /api/write': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    // 控制台「打磨已有的书」：只改已有内容，不写新章（user-sim 传 WORKSHOP_NO_WRITE=1）
    if (process.env.WORKSHOP_NO_WRITE === '1') throw new Error('这次是打磨模式：只改已有章节和书名简介封面，不写新章')
    const count = Math.min(10, Math.max(1, Number(body.count) || 1))
    runJob(`写 ${count} 章`, async (step) => {
      const wrote = []
      for (let i = 0; i < count; i++) { const n = (S.readBook(body.id).chapters.at(-1)?.n || 0) + 1; const row = await PL.writeChapter(body.id, n, { onStep: (s) => step(`第 ${n} 章（${i + 1}/${count}）：${s}`) }); wrote.push(`第${n}章${row?.score != null ? row.score + '分' : ''}`) }
      return { summary: wrote.join('、') }
    }); return { ok: true }
  },
  // 情绪浓度（稳/燃/炸）：按书保存，下一章起生效；不花钱，不进 MODEL_ROUTES
  'POST /api/book/heat': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    const heat = ['calm', 'hot', 'blast'].includes(body.heat) ? body.heat : 'calm'
    const b = S.readBook(body.id); b.heat = heat; S.saveBook(b); return { ok: true, heat }
  },
  // 文风 / 玩梗模式：按书保存，下一章（含改写）起生效；不花钱
  'POST /api/book/voice': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    const b = S.readBook(body.id)
    if (body.voice !== undefined) b.voice = resolveVoice(body.voice).id
    if (body.memeMode !== undefined) b.memeMode = normMemeMode(body.memeMode)
    S.saveBook(b); return { ok: true, voice: b.voice || 'auto', memeMode: b.memeMode || 'light' }
  },
  'POST /api/revise': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    runJob(`改写第 ${body.n} 章`, async (step) => { await PL.reviseChapter(body.id, Number(body.n), validateRevisionInstruction(body.instruction), { onStep: step }) }); return { ok: true }
  },
  'POST /api/revision/compare': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    runJob(`重新对比第 ${body.n} 章改前改后`, async (step) => { await PL.compareRevision(body.id, Number(body.n), { onStep: step }) }); return { ok: true }
  },
  'POST /api/revision/adopt': (_, body) => { if (!validId(body.id)) throw new Error('书不存在'); if (job.running) throw new Error('有任务在进行中，请等它完成'); PL.adoptRevision(body.id, Number(body.n)); return { ok: true } },
  'POST /api/revision/discard': (_, body) => { if (!validId(body.id)) throw new Error('书不存在'); if (job.running) throw new Error('有任务在进行中，请等它完成'); PL.discardRevision(body.id, Number(body.n)); return { ok: true } },
  // ── 智能代理（Beta）──
  'GET /api/agent': () => ({ enabled: agentOn(), state: agentView() }),
  'POST /api/agent/plan': (_, body) => {
    needAgent(); if (!validId(body.id)) throw new Error('书不存在')
    runJob('代理拟计划', async (step) => { await AG.plan(body.id, { instruction: body.instruction, chapters: body.chapters, budget: body.budget, allowPackage: body.allowPackage !== false, allowCover: !!body.allowCover }, { onStep: step }) }); return { ok: true }
  },
  'POST /api/agent/start': (_, body) => { needAgent(); AG.assertCanStart(false); runJob('智能代理', async (step) => { const r = await AG.run({ instruction: body.instruction }, { onStep: step }); return { summary: r?.note } }); return { ok: true } },
  'POST /api/agent/resume': (_, body) => { needAgent(); AG.assertCanStart(true); runJob('智能代理（继续）', async (step) => { const r = await AG.run({ instruction: body.instruction, resume: true }, { onStep: step }); return { summary: r?.note } }); return { ok: true } },
  'POST /api/agent/pause': () => { AG.pause(); return { ok: true } },
  'POST /api/job/stop': () => { jobController?.abort(); try { AG.stop() } catch { /* 手动任务没有代理状态 */ } return { ok: true, stopping: job.running } },
  'POST /api/agent/stop': () => { AG.stop(); return { ok: true } },
  'POST /api/agent/guide': (_, body) => { AG.guide(body.text); return { ok: true } },
  'POST /api/agent/discard': () => { AG.discardPlan(); return { ok: true } },
  'POST /api/pick': (_, body) => {
    // 作者手动改选某个候选稿为定稿
    if (!validId(body.id)) throw new Error('书不存在')
    const n = Number(body.n); const k = Number(body.k)
    const t = S.readText(body.id, 'work', S.pad(n), `cand-${k}.txt`); if (!t) throw new Error('候选稿不存在')
    const old = S.readBook(body.id).chapters.find((c) => c.n === n) || {}
    S.commitChapter(body.id, n, t, { ...old, winner: k, manualPick: true, scoreStale: true }, { reason: `改选候选版本 ${k}` }); return { ok: true }
  },
  'POST /api/save': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    const n = Number(body.n); const text = String(body.text || ''); if (text.length < 200) throw new Error('正文太短')
    const old = S.readBook(body.id).chapters.find((c) => c.n === n) || {}
    S.commitChapter(body.id, n, text, { ...old, handEdited: true, scoreStale: true }, { reason: '作者手改' }); return { ok: true }
  },
  'GET /api/history': (q) => {
    if (!validId(q.id)) throw new Error('书不存在')
    if (!/^\d{4}-\d+(-dropped)?\.txt$/.test(q.file || '')) throw new Error('历史版本文件名不对')
    const t = S.readText(q.id, 'history', q.file); if (!t) throw new Error('找不到历史版本'); return { text: t }
  },
  'POST /api/rollback': (_, body) => { if (!validId(body.id)) throw new Error('书不存在'); S.rollback(body.id, Number(body.n), String(body.file), { keepTitle: body.keepTitle !== false }); return { ok: true } },
  'POST /api/drop': (_, body) => { if (!validId(body.id)) throw new Error('书不存在'); S.dropLastChapter(body.id); return { ok: true } },
  'POST /api/export': (_, body) => { if (!validId(body.id)) throw new Error('书不存在'); return { file: PL.exportBook(body.id) } },
  'POST /api/characters': (_, body) => {
    if (!validId(body.id)) throw new Error('书不存在')
    return { ok: true, characterCard: S.saveCharacterCard(body.id, body.characterCard || {}) }
  },
  'POST /api/settings': (_, body) => {
    const cur = PL.settings(); const c = Math.min(4, Math.max(1, Number(body.candidates) || cur.candidates))
    const polish = body.polish !== undefined && POLISH_MODES[body.polish] ? body.polish : cur.polish
    const autoPolish = body.autoPolish !== undefined ? !!body.autoPolish : !!cur.autoPolish
    const penName = body.penName !== undefined ? String(body.penName).trim().slice(0, 20) : (cur.penName || '')
    const coverWidth = Math.min(2000, Math.max(200, Number(body.coverWidth) || cur.coverWidth || 600))
    const coverHeight = Math.min(2600, Math.max(200, Number(body.coverHeight) || cur.coverHeight || 800))
    const coverTextMode = body.coverTextMode !== undefined ? (body.coverTextMode === 'overlay' ? 'overlay' : 'ai') : (cur.coverTextMode === 'overlay' ? 'overlay' : 'ai')
    const agentBeta = body.agentBeta !== undefined ? !!body.agentBeta : !!cur.agentBeta
    if (!agentBeta && AG.readState().status === 'running') throw new Error('代理正在运行，先暂停或中止，再关闭开关')
    const next = { ...cur, candidates: c, polish, autoPolish, penName, coverWidth, coverHeight, coverTextMode, agentBeta }; delete next.candidateRoles // 候选稿用谁写改由「模型与 Agent」决定
    fs.mkdirSync(path.dirname(PL.settingsFile()), { recursive: true }); fs.writeFileSync(PL.settingsFile(), JSON.stringify(next, null, 2), 'utf8'); return PL.settings()
  },
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}`)
    // 2026-10-02 内测用户模式：模型与 Agent 的一切入口对用户 403（映射只有管理员能改）
    if (TG.CUSTOMER && /^\/api\/agents(\/|$)/.test(u.pathname)) return send(res, 403, { error: out('普通用户不能修改模型设置') })
    // 管理员模式（WORKSHOP_MODE=admin）或带 token 的反馈查看：/admin?key=...
    // 管理员实例：完整管理后台（档位 ↔ 模型、Base URL、Key、协议）；客户实例凭 token 只能看反馈
    if (TG.ADMIN_MODE && (u.pathname === '/admin' || u.pathname === '/')) return send(res, 200, fs.readFileSync(path.join(HERE, 'ui', 'admin.html'), 'utf8'), 'text/html; charset=utf-8')
    if (adminKey(u) && u.pathname === '/admin') return send(res, 200, ADMIN_HTML, 'text/html; charset=utf-8')
    if ((TG.ADMIN_MODE || adminKey(u)) && u.pathname === '/api/admin/feedback') {
      // 2026-10-06：附修复队列状态（待修复/已修复/结论），最新在前；顺带把漏进队列的真人反馈补进去
      return send(res, 200, adminFeedback())
    }
    // 2026-10-03 管理后台（只在 WORKSHOP_MODE=admin 的本机实例里开放，不接受 token —— 客户实例走隧道暴露在公网，不能让它改模型）
    if (TG.ADMIN_MODE && /^\/api\/admin\/(tiers|test|config|agents)$/.test(u.pathname)) {
      if (req.method === 'POST' && req.headers.origin !== undefined) {
        let same = false; try { same = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.headers.origin).host) } catch { same = false }
        if (!same) return send(res, 403, { error: '拒绝跨站请求' })
      }
      const { loadEnv, TASKS } = await import('./lib/agents.mjs')
      if (u.pathname === '/api/admin/tiers') {
        if (req.method === 'POST') { TG.adminSave(await readBody(req), TASKS.map((t) => t.id)); return send(res, 200, { ok: true, ...TG.adminView(loadEnv()), tasks: TASKS }) }
        return send(res, 200, { ...TG.adminView(loadEnv()), tasks: TASKS })
      }
      if (u.pathname === '/api/admin/test' && req.method === 'POST') {
        const { pingDef } = await import('./lib/llm.mjs')
        try {
          const b = await readBody(req)
          if (b.scope === 'agent') { // 「模型与分工」里的 agent：用表单里未保存的值，Key 留空用已保存的
            const { loadConfig } = await import('./lib/agents.mjs'); const { normBaseUrl } = await import('./lib/tiers.mjs')
            const old = loadConfig().agents[String(b.id || '')] || {}; const m = { ...old, ...(b.model || {}) }; const env = loadEnv()
            const typed = typeof b.model?.apiKey === 'string' ? b.model.apiKey.trim() : ''
            const key = (typed && !typed.startsWith('••') ? typed : '') || String(old.apiKey || '').trim() || String(env[m.keyEnv] || process.env[m.keyEnv] || '').trim()
            if (!key) throw new Error('没有 API Key')
            return send(res, 200, await pingDef({ name: String(m.name || b.id), model: String(m.model || ''), baseUrl: normBaseUrl(m.baseUrl), protocol: m.protocol === 'anthropic' ? 'anthropic' : 'openai', key }))
          }
          return send(res, 200, await pingDef(TG.adminTestDef(b, loadEnv())))
        } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }) }
      }
      // 站长自用的「模型与分工」（workshop/data/agents.json）并入管理后台：读打码视图、保存写真实文件
      if (u.pathname === '/api/admin/agents') {
        if (req.method === 'POST') return send(res, 200, { ok: true, ...saveConfig(await readBody(req), { real: true }) })
        return send(res, 200, publicConfig())
      }
      // 旧的整份 JSON 接口：只读，且 Key 打码（直接填的 Key 只存在管理员配置文件里）
      if (u.pathname === '/api/admin/config' && req.method === 'GET') return send(res, 200, TG.adminView(loadEnv()))
      return send(res, 404, { error: '没有这个接口' })
    }
    // 2026-10-03 账号与额度 + 隧道（合并原「内测账号」开户页）。同样只在本机 admin 实例开放，POST 只认本机 Origin。
    if (TG.ADMIN_MODE && /^\/api\/admin\/(accounts|tunnels)(\/|$)/.test(u.pathname)) {
      if (req.method === 'POST' && req.headers.origin !== undefined) {
        let same = false; try { same = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.headers.origin).host) } catch { same = false }
        if (!same) return send(res, 403, { error: '拒绝跨站请求' })
      }
      const AC = await import('./lib/accounts.mjs')
      const r = await AC.handle(req.method, u.pathname, Object.fromEntries(u.searchParams), () => readBody(req))
      if (r) return send(res, r[0], r[1])
      return send(res, 404, { error: '没有这个接口' })
    }
    // 2026-10-06 管理后台「DeepSeek 作者与测试」标签页：工作台固定跑在 127.0.0.1:4569，这里查它在不在、不在就拉起（只本机）
    if (TG.ADMIN_MODE && u.pathname === '/api/admin/lab') {
      if (req.method === 'POST' && req.headers.origin !== undefined) {
        let same = false; try { same = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.headers.origin).host) } catch { same = false }
        if (!same) return send(res, 403, { error: '拒绝跨站请求' })
      }
      const port = Number(process.env.WORKSHOP_LAB_PORT) || 4569
      const up = () => new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); r(true) }); s.on('error', () => r(false)) })
      if (req.method === 'POST' && !(await up())) {
        // 工作台不能继承管理员实例的沙箱/模式变量（否则它读到的是 _admin 沙箱而不是真书库）
        const env = { ...process.env }; for (const k of ['WORKSHOP_MODE', 'WORKSHOP_SANDBOX', 'WORKSHOP_ADMIN_CONFIG', 'WORKSHOP_PORT', 'WORKSHOP_SUPERVISED', 'WORKSHOP_BUDGET', 'WORKSHOP_BUDGET_BASE', 'WORKSHOP_AUTO_TUNNEL']) delete env[k]
        const kid = spawn(process.execPath, [path.join(HERE, 'customer-lab.mjs'), '--no-open', `--port=${port}`], { cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true, env })
        kid.unref()
        for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250))
      }
      return send(res, 200, { running: await up(), url: `http://127.0.0.1:${port}/?embed=1` })
    }
    // 2026-10-06 管理后台「真人反馈」：查看修复工程师最近一次任务的真实执行结果 / 手动唤醒（只本机）
    if (TG.ADMIN_MODE && u.pathname === '/api/admin/fixer') {
      if (req.method === 'POST') {
        let same = req.headers.origin === undefined; try { same = same || /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.headers.origin).host) } catch { same = false }
        if (!same) return send(res, 403, { error: '拒绝跨站请求' })
        return send(res, 200, { wake: await runWakeFixer(['--force', '--json']) })
      }
      return send(res, 200, await fixerStatus())
    }
    if (TG.ADMIN_MODE && u.pathname === '/api/admin/usage') {
      const dir0 = u.searchParams.get('dir') || process.env.WORKSHOP_SANDBOX
      // 只允许查询「沙箱所在的用户根目录」之内的目录，防路径穿越读到别处文件
      const root = process.env.WORKSHOP_SANDBOX ? path.dirname(path.resolve(process.env.WORKSHOP_SANDBOX)) : ''
      const dir = dir0 && root && (path.resolve(dir0) + path.sep).startsWith(root + path.sep) ? path.resolve(dir0) : ''
      if (dir0 && !dir) return send(res, 400, { error: '只能查询用户目录之内的路径' })
      const rows = dir && fs.existsSync(path.join(dir, 'calls.ndjson')) ? fs.readFileSync(path.join(dir, 'calls.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
      const cost = +rows.reduce((a, x) => a + (x.ok ? x.cost || 0 : 0), 0).toFixed(5)
      return send(res, 200, { dir, calls: rows.length, cost, suggest: +(cost * TG.priceFactor()).toFixed(5), factor: TG.priceFactor() })
    }
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(HERE, 'ui', 'index.html'), 'utf8')
      // 内测：页面里不许出现模型/供应商名，品牌统一「清平文坊」
      return send(res, 200, TG.CUSTOMER ? TG.sanitize(html).replaceAll('清平文坊', '清平文坊') : html, 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && u.pathname === '/cover') {
      const id = u.searchParams.get('id'); if (!validId(id)) return send(res, 404, '书不存在', 'text/plain; charset=utf-8')
      const f = CV.coverFile(id); if (!f) return send(res, 404, '还没有封面', 'text/plain; charset=utf-8')
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', ...(u.searchParams.get('dl') ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(S.readBook(id).title + '-封面.png')}` } : {}) })
      return res.end(fs.readFileSync(f))
    }
    if (req.method === 'GET' && u.pathname === '/download') {
      const id = u.searchParams.get('id'); if (!validId(id)) return send(res, 404, '书不存在', 'text/plain; charset=utf-8')
      try {
        if (u.searchParams.get('what') === 'info') {
          const name = `${S.readBook(id).title}-作品信息.txt`
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` })
          return res.end(PL.exportInfo(id))
        }
        const f = PL.exportBook(id)
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f))}` })
        return res.end(fs.readFileSync(f))
      } catch (e) { return send(res, 400, String(e.message || e), 'text/plain; charset=utf-8') }
    }
    const h = routes[`${req.method} ${u.pathname}`]
    if (!h) return send(res, 404, { error: '没有这个接口' })
    // 简单防跨站：只接受来自本页面的 POST
    // 有 Origin 就必须是本机或与请求 Host 同源（反代到公网后 Host 是用户访问的地址）；Origin: null 一律拒绝
    if (req.method === 'POST' && req.headers.origin !== undefined) {
      const o = req.headers.origin; let same = false
      try { const oh = new URL(o).host; same = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(oh) || oh === (req.headers['x-forwarded-host'] || req.headers.host) } catch { same = false }
      if (!same) return send(res, 403, { error: '拒绝跨站请求' })
    }
    if (req.method === 'POST' && TG.CUSTOMER && MODEL_ROUTES.has(u.pathname)) precheck() // 内测用户：到期/超额在任务启动前就拒绝
    const body = req.method === 'POST' ? await readBody(req, u.pathname === '/api/import' ? 12e6 : 1e6) : {}
    // 改变定稿的即时操作完成后，清掉上一个后台任务的「完成」提示，避免顶部写着「评审完成」而报告已经换了版本
    if (req.method === 'POST' && !job.running && /^\/api\/(rollback|save|pick|drop|polish\/adopt|revision\/(adopt|discard)|cover\/recompose)$/.test(u.pathname)) Object.assign(job, { done: '', error: '', label: '', outcome: u.pathname.includes('recompose') ? 'recompose' : null })
    send(res, 200, await h(Object.fromEntries(u.searchParams), body))
  } catch (e) { send(res, 400, { error: out(String(e.message || e)) }) }
}).listen(PORT, HOST, () => { console.log(`清平文坊已启动：http://${HOST}:${PORT}  （关掉这个窗口就停止）`); if (TG.ADMIN_MODE) import('./lib/accounts.mjs').then((m) => m.autoTunnelOnStart()).catch(() => {}) })

// 客户实例凭 token 打开的只读反馈页（档位与模型只能在本机管理员实例里改，见 ui/admin.html）
const ADMIN_HTML = `<!doctype html><meta charset="utf-8"><title>清平文坊 · 反馈</title>
<body style="font-family:system-ui;max-width:860px;margin:24px auto;padding:0 16px">
<h2>清平文坊 · 客户反馈</h2>
<p><button onclick="feedback()">刷新反馈</button></p>
<pre id="fb"></pre>
<script>
const $=id=>document.getElementById(id), key=new URLSearchParams(location.search).get('key')||'', admin=(p)=>p+(p.includes('?')?'&':'?')+'key='+encodeURIComponent(key)
async function feedback(){const r=await fetch(admin('/api/admin/feedback'));$('fb').textContent=JSON.stringify(await r.json(),null,2)}
feedback()
</script></body>`

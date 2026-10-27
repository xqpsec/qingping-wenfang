// feedback.mjs —— 客户反馈收件箱与零额外模型成本自动客服
// 2026-10-06：真人反馈一律进修复队列（source=customer-feedback，最高优先级），不再因为分类是「其他」就丢掉；
// 管理后台通过 adminFeedback() 看到原话、上下文和修复进度。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 反馈必须落在共享工坊数据目录，不能跟着客户沙箱走；测试可用 WORKSHOP_FEEDBACK_DIR 隔离
const ROOT = () => process.env.WORKSHOP_FEEDBACK_DIR ? path.resolve(process.env.WORKSHOP_FEEDBACK_DIR) : path.join(HERE, '..', 'data')
const FILE = () => path.join(ROOT(), 'feedback.json')
const QUEUE = () => path.join(ROOT(), 'qa-queue.json')
const MAX = 200
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n)
function read() { try { const x = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(x) ? x : [] } catch { return [] } }
function save(rows) { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE() + '.tmp', JSON.stringify(rows.slice(-MAX), null, 2), 'utf8'); fs.renameSync(FILE() + '.tmp', FILE()) }
function readQueue() { let q = { items: [] }; try { q = JSON.parse(fs.readFileSync(QUEUE(), 'utf8')) } catch {} if (!Array.isArray(q.items)) q.items = []; return q }
function writeQueue(q) { fs.mkdirSync(path.dirname(QUEUE()), { recursive: true }); fs.writeFileSync(QUEUE() + '.tmp', JSON.stringify(q, null, 2), 'utf8'); fs.renameSync(QUEUE() + '.tmp', QUEUE()) }
function id() { return `F-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}` }
function classify(text) {
  if (/打不开|进不去|连不上|空白|白屏|加载|刷新|消失/.test(text)) return { category: '访问问题', reply: '我已经收到“页面访问”反馈。请先刷新一次页面；如果仍然打不开，请把你看到的页面提示或截图发来，我会继续跟进。' }
  if (/失败|报错|错误|异常|没生成|生成不了|卡住|一直转|不动|无法|不能/.test(text)) return { category: '任务异常', reply: '我已经记录这个任务异常。请告诉我你刚才点的是哪个按钮，以及页面显示的最后一句话；已有的稿件不会因为反馈而被删除。' }
  if (/找不到|不会|怎么|在哪|看不见|不懂|不会用|不显眼/.test(text)) return { category: '使用问题', reply: '我先按使用问题处理。请告诉我你想完成的目标（例如“找到第一章”“修改一段”“下载全书”），我会给你最短操作路径。' }
  if (/不好|不满意|不对|改错|质量|像机器|不自然|原意/.test(text)) return { category: '结果反馈', reply: '我已经记录结果反馈。请补充“哪一段不满意 + 你希望怎样”，我会把它拆成可复现的问题交给改进队列。' }
  if (/建议|希望|能不能|增加|功能|最好|精进|参考/.test(text)) return { category: '功能建议', reply: '建议已收下。我会先判断它能否复用到其他作者，再决定进入功能队列；请补充一个具体使用场景。' }
  return { category: '其他', reply: '我已收到你的反馈，会先整理成具体问题。请补充：你当时想做什么、实际发生了什么、你希望看到什么结果。' }
}
const SEVERITY = { '访问问题': '高', '任务异常': '高' }
function evidenceOf(f) {
  const c = f.context || {}
  const where = [c.page && `页面「${c.page}」`, c.bookId && `书「${c.bookId}」`, c.chapter && `第 ${c.chapter} 章`, f.account && `账号沙箱 ${f.account}`].filter(Boolean).join('，')
  return `真人反馈 ${f.id}（${f.createdAt}${where ? '，' + where : ''}）：${f.text}`
}
// 真人反馈 → 修复队列条目。真人反馈不分类别全部入队，customerRequested=true 让唤醒逻辑立刻处理。
function queueItem(f) {
  return { id: `Q-FB-${f.id.slice(-6)}`, feedbackId: f.id, status: 'open', kind: 'customer-feedback', title: `真人反馈·${f.category}：${f.text.slice(0, 140)}`, severity: SEVERITY[f.category] || '高', hits: 1, evidence: [evidenceOf(f)], why: '真人用户在网页「反馈」里提交，优先级高于 AI 模拟反馈', at: f.createdAt, from: 'customer', source: 'customer-feedback', verification: 'pending-code-reproduction', customerRequested: true, priority: 'real-customer' }
}
// 把 feedback.json 里所有还没进队列的真人反馈补进 qa-queue.json；客户追问会追加证据并重新打开已关闭的条目。
// 幂等：按 feedbackId 去重。返回 { added, reopened }。
export function syncFeedbackQueue() {
  const rows = read(); if (!rows.length) return { added: 0, reopened: 0 }
  const q = readQueue(); let added = 0, reopened = 0, rowsDirty = false
  for (const f of rows) {
    let item = q.items.find((x) => x.feedbackId === f.id)
    if (!item) { item = queueItem(f); q.items.push(item); added++ }
    if (f.qaId !== item.id) { f.qaId = item.id; rowsDirty = true }
    const follow = (f.messages || []).filter((m) => m.role === 'customer').slice(1)
    const seen = Number(item.followUps || 0)
    if (follow.length > seen) {
      item.evidence = [...(Array.isArray(item.evidence) ? item.evidence : [String(item.evidence || '')]), ...follow.slice(seen).map((m) => `客户追问（${m.at}）：${m.text}`)]
      item.followUps = follow.length
      if (item.status !== 'open') { item.status = 'open'; item.reopenedAt = new Date().toISOString(); item.reopenReason = '真人客户在反馈线程里继续追问'; reopened++ }
      rowsDirty = true
    }
  }
  if (added || reopened || rowsDirty) writeQueue(q)
  if (rowsDirty) save(rows)
  return { added, reopened }
}
export function listFeedback(visitor = '') { return read().filter((x) => !visitor || x.visitor === visitor).map(({ visitor: _v, ...x }) => x) }
const STATUS_TEXT = { open: '待修复', fixed: '已修复', rejected: '已驳回' }
// 管理后台视图：最新在前，附修复队列里的处理状态与结论（不含访客凭证）。
export function adminFeedback() {
  try { syncFeedbackQueue() } catch {}
  const q = readQueue(); const byFb = new Map(q.items.filter((x) => x.feedbackId).map((x) => [x.feedbackId, x]))
  const rows = listFeedback('').map((f) => {
    const it = byFb.get(f.id)
    const qa = it ? { id: it.id, status: it.status, statusText: STATUS_TEXT[it.status] || it.status, note: String(it.resolution || it.fix || it.why_rejected || ''), fixedIn: it.fixedIn || '', reopenedAt: it.reopenedAt || '' } : { id: '', status: 'missing', statusText: '未入队', note: '' }
    return { ...f, qa }
  }).reverse()
  const pending = rows.filter((r) => r.qa.status === 'open' || r.qa.status === 'missing').length
  return { rows, count: rows.length, pending }
}
export function createFeedback(body = {}) {
  const text = clean(body.text, 2000); if (text.length < 4) throw new Error('请至少写 4 个字')
  const visitor = clean(body.visitor, 80) || 'anonymous'
  const c = classify(text)
  const account = process.env.WORKSHOP_SANDBOX ? path.basename(path.resolve(process.env.WORKSHOP_SANDBOX)) : ''
  const f = { id: id(), visitor, account, text, category: c.category, status: 'in-progress', createdAt: new Date().toISOString(), context: { page: clean(body.page, 80), bookId: clean(body.bookId, 100), chapter: clean(body.chapter, 30) }, messages: [{ role: 'customer', text, at: new Date().toISOString() }, { role: 'assistant', text: c.reply + '（这条反馈已转给技术同事优先处理。）', at: new Date().toISOString() }], qaId: '' }
  const rows = read(); rows.push(f); save(rows)
  try { syncFeedbackQueue() } catch {}
  wakeForCustomer()
  return publicFeedback(read().find((x) => x.id === f.id) || f)
}
export function replyFeedback(fid, body = {}) {
  const text = clean(body.text, 2000); if (text.length < 2) throw new Error('回复太短')
  const rows = read(); const f = rows.find((x) => x.id === fid); if (!f) throw new Error('反馈不存在')
  if (f.visitor !== (clean(body.visitor, 80) || 'anonymous')) throw new Error('反馈凭证不匹配')
  f.messages.push({ role: 'customer', text, at: new Date().toISOString() }); const c = classify(text); f.messages.push({ role: 'assistant', text: c.reply, at: new Date().toISOString() }); f.status = 'in-progress'; save(rows)
  try { syncFeedbackQueue() } catch {}
  wakeForCustomer()
  return publicFeedback(read().find((x) => x.id === fid) || f)
}
// 真人提交反馈后立即在后台跑一次 wake-fixer（非强制：已有修复任务在跑、同一批已唤醒过都不会重复建任务）。
// 独立子进程、不等待，客户页面不受影响；测试（WORKSHOP_FEEDBACK_DIR）和 WORKSHOP_NO_AUTO_WAKE=1 时不唤醒。
function wakeForCustomer() {
  if (process.env.WORKSHOP_FEEDBACK_DIR || process.env.WORKSHOP_NO_AUTO_WAKE === '1') return
  try {
    const env = { ...process.env }; delete env.WORKSHOP_SANDBOX
    const kid = spawn(process.execPath, [path.join(HERE, '..', 'wake-fixer.mjs')], { cwd: path.join(HERE, '..'), detached: true, stdio: 'ignore', windowsHide: true, env })
    kid.on('error', () => {}); kid.unref()
  } catch {}
}
function publicFeedback(f) { const { visitor: _v, ...x } = f; return x }
export const feedbackFile = FILE

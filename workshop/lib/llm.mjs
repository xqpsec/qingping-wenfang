// llm.mjs —— 极简 OpenAI 兼容客户端（零依赖）。用哪个服务商/密钥/模型由 agents.mjs 决定（界面「模型与 Agent」可改）。
// 调用明细写 workshop/data/calls.ndjson（含 agent 编号与名称，方便排查是哪一个 agent 出的错）
import fs from 'node:fs'
import path from 'node:path'
import { resolveAgent, loadConfig, taskLabel, ROOT as AROOT } from './agents.mjs'
import { CUSTOMER } from './tiers.mjs' // 2026-10-02 内测档位层

export const ROOT = AROOT
// 沙箱（模拟用户/测试）调用记录单独存，不混进真实花费；WORKSHOP_BUDGET=元 设硬上限，超了直接拒绝调用
const SANDBOX = process.env.WORKSHOP_SANDBOX ? path.resolve(process.env.WORKSHOP_SANDBOX) : ''
export const CALL_LOG = SANDBOX ? path.join(SANDBOX, 'calls.ndjson') : path.join(ROOT, 'workshop', 'data', 'calls.ndjson')
const BUDGET = Number(process.env.WORKSHOP_BUDGET) || 0
const THINK_HEADROOM = Number(process.env.WORKSHOP_THINK_HEADROOM) || 48000 // 思考额外额度（不限思考，按实际用量扣费）
function sumLog() { if (!fs.existsSync(CALL_LOG)) return 0; return fs.readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean).reduce((a, l) => { try { return a + (JSON.parse(l).cost || 0) } catch { return a } }, 0) }
// 预算按「从某个时刻起花了多少」算：WORKSHOP_BUDGET_BASE=该时刻的累计花费（真书模式下由驱动脚本传入，
// 否则真实日志里已有的几十元会让预算一开始就判为用完）。沙箱日志从 0 开始，基线自然是 0
const BUDGET_BASE = process.env.WORKSHOP_BUDGET_BASE !== undefined ? Number(process.env.WORKSHOP_BUDGET_BASE) || 0 : (SANDBOX ? 0 : sumLog())
// 智能代理（Beta）的「立即中止」：代理运行期间把它的 AbortSignal 放这里，正在进行的模型请求会被掐断，且不再重试。
// 其他任务（手动点按钮）不设这个信号，行为不变。
export const abortCtl = { signal: null }
export function spentTotal() { return +(sumLog() - BUDGET_BASE).toFixed(5) }

// 2026-10-02 内测：到期/超额闸门。内测用户模式下一切「会调模型」的动作先过这里；
// 查看、导出不调模型，天然放行。错误文案用人话，不出现 WORKSHOP_* 变量名。
// 2026-10-03 管理后台可随时加额度/延期：客户实例每秒内实时读 deploy/users.json 里自己的记录（沙箱目录名 = 账号名），
// 读不到（测试、单机自用）就退回启动时的环境变量。停用的账号视为额度 0。
// 必须用 users.json 里的 enabled=false 来拦：这样停用后不用重启进程也立刻生效。
let _q = { at: 0, v: null }
export function liveQuota() {
  const envQ = { budget: BUDGET, expires: process.env.WORKSHOP_EXPIRES || '', enabled: true }
  if (!CUSTOMER || !SANDBOX) return envQ
  if (Date.now() - _q.at < 1000 && _q.v) return _q.v
  let v = envQ
  try {
    const uf = process.env.WORKSHOP_USERS_FILE || path.join(path.dirname(path.dirname(SANDBOX)), 'users.json')
    const u = JSON.parse(fs.readFileSync(uf, 'utf8')).users?.[path.basename(SANDBOX)]
    if (u) v = { budget: Number(u.budget) || 0, expires: u.expires || '', enabled: u.enabled !== false }
  } catch { /* 读不到用环境变量 */ }
  _q = { at: Date.now(), v }
  return v
}
export function precheck() {
  if (!CUSTOMER) return
  const q = liveQuota()
  const exp = q.expires
  if (!q.enabled) throw new Error('这个体验账号已暂停，稿件仍可查看和导出。请联系我们')
  if (exp && Date.now() > Date.parse(exp)) throw new Error('体验期已结束，稿件仍可查看和导出。想继续使用请联系我们续期')
  if (q.budget && spentTotal() >= q.budget) throw new Error('体验额度已用完（积分用光了），稿件仍可查看和导出。想继续使用请联系我们加积分')
}

/** 兼容旧代码：route(role) 仍可用 */
export function route(role) { return resolveAgent({ role }) }

// ── 兼容协议（2026-10-03）：openai = /chat/completions；anthropic = /v1/messages ──
// Anthropic 官方地址是 https://api.anthropic.com（不带 /v1）；很多中转站给的是 …/v1。两种都接受。
export function endpoint(a) {
  const b = String(a.baseUrl || '').replace(/\/+$/, '')
  if (a.protocol === 'anthropic') return /\/v\d+$/.test(b) ? b + '/messages' : b + '/v1/messages'
  return b + '/chat/completions'
}
export function authHeaders(a) {
  const h = { 'Content-Type': 'application/json' }
  // 官方认 x-api-key，部分中转站只认 Bearer：两个都带
  if (a.protocol === 'anthropic') Object.assign(h, { 'x-api-key': a.key, 'anthropic-version': '2023-06-01', Authorization: `Bearer ${a.key}` })
  else h.Authorization = `Bearer ${a.key}`
  return h
}
function anthropicBody(a, { system, user, images, temperature, maxTokens }) {
  const img = (url) => { const m = /^data:([^;]+);base64,(.*)$/.exec(url); return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url } } }
  return {
    model: a.model, max_tokens: maxTokens, temperature: Math.min(1, temperature),
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: images.length ? [{ type: 'text', text: user }, ...images.map(img)] : user }],
  }
}
export function fromAnthropic(j) {
  const content = (Array.isArray(j.content) ? j.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
  const u = j.usage || {}
  // 计费口径统一成 OpenAI 的 prompt/completion（缓存读写也算输入）
  return { content, usage: { prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), completion_tokens: u.output_tokens || 0 } }
}

/** 管理台「测试连接」：直接用给定定义发一句极短的话（不记账、不过档位） */
export async function pingDef(a) {
  const t0 = Date.now()
  const body = a.protocol === 'anthropic' ? anthropicBody(a, { user: '只回复两个字：收到', images: [], temperature: 0, maxTokens: 400 }) : { model: a.model, temperature: 0, max_tokens: 400, messages: [{ role: 'user', content: '只回复两个字：收到' }] }
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 60000)
  let res, txt
  try {
    res = await fetch(endpoint(a), { method: 'POST', headers: authHeaders(a), body: JSON.stringify(body), signal: ctl.signal })
    txt = await res.text()
  } catch (e) { throw new Error(`连不上 ${endpoint(a)}：${e.cause?.code || e.message}（检查 Base URL 和网络）`) } finally { clearTimeout(to) }
  if (!res.ok) throw new Error(explainError(res.status, txt, a))
  let j; try { j = JSON.parse(txt) } catch { throw new Error(`返回的不是 JSON（Base URL 可能指到了网页，或协议选错了）：${txt.slice(0, 80)}`) }
  const r = a.protocol === 'anthropic' ? fromAnthropic(j) : { content: j.choices?.[0]?.message?.content ?? '', usage: j.usage || {} }
  return { ok: true, ms: Date.now() - t0, reply: String(r.content).trim().slice(0, 40), usage: r.usage, endpoint: endpoint(a) }
}

/** 把 HTTP 错误翻译成「谁出了什么问题、怎么修」 */
export function explainError(status, body, agent) {
  const who = `「${agent.name}」（${agent.model} @ ${agent.baseUrl}）`
  const raw = String(body || '').slice(0, 200)
  const hint = {
    400: '请求被拒：常见原因是模型名写错、该服务商不支持这个参数，或者输入太长。',
    401: 'API Key 无效或填错了（多复制了空格、用了别家的 key）。',
    402: '这个服务商账户余额不足。去它的后台充值，或在「模型与 Agent」里把用到它的任务改派给别的 agent。',
    403: 'Key 没有权限调用这个模型，或账户被限制 / 余额不足。',
    404: 'Base URL 或模型名不对（OpenAI 兼容地址一般以 /v1 结尾，DeepSeek 官方是 https://api.deepseek.com）。',
    429: '请求太频繁或额度用完，稍后再试，或换一个 agent。',
  }[status] || (status >= 500 ? '服务商那边出错了，一般过一会儿重试就好。' : '未知错误。')
  return `${who} 返回 HTTP ${status}：${hint}\n原始信息：${raw}`
}
// 这些错误重试没有意义，直接报错（v1.0 对 402 重试了 3 次，白等十几秒）
const NO_RETRY = new Set([400, 401, 402, 403, 404])

// ── 流式 + 卡死检测（2026-10-03）──
// 非流式请求要等整段生成完才回响应头：网关一卡，fetch 就盲等 300 秒 × 3 次（一位内测用户 开书等了 15 分钟）。
// 流式下首包通常十几秒到（stream-probe 实测 gpt-6-sol 14.7s、opus 5.2s、flash 1.7s），
// 所以：首包超时 FIRST_MS、两包间隔超时 IDLE_MS、总时长 TOTAL_MS；任一触发 = 线路卡了（err.stalled），
// 分路模型卡了直接退回档位基础模型，不在同一条线上重试。
const STREAM_FIRST_MS = Number(process.env.WORKSHOP_STREAM_FIRST_MS || 60000)
const STREAM_IDLE_MS = Number(process.env.WORKSHOP_STREAM_IDLE_MS || 60000)
const STREAM_TOTAL_MS = Number(process.env.WORKSHOP_STREAM_TOTAL_MS || 480000)
// 网关没给 usage 时按字数保守估算（中文约 1 字 ≈ 1 token，宁多勿少）
const estTokens = (s) => Math.ceil(String(s || '').length)

/** 读 OpenAI 兼容 SSE 流；onDelta({ content, reasoning }) 收到增量就回调（累计全文，调用方自己节流） */
// acc：调用方传入的累加器，流被掐断时调用方仍能拿到已生成的字数来记账（网关照样按已生成的 token 收费）
async function readStream(res, { onDelta, stalled, acc = {} }) {
  let content = '', reasoning = '', usage = null, buf = '', gotAny = false
  const dec = new TextDecoder()
  let idle = setTimeout(() => stalled('first'), STREAM_FIRST_MS)
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => stalled('idle'), STREAM_IDLE_MS) }
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const d = line.slice(5).trim(); if (!d || d === '[DONE]') continue
        let j; try { j = JSON.parse(d) } catch { continue }
        if (j.error) throw new Error(String(j.error.message || JSON.stringify(j.error)).slice(0, 200))
        if (j.usage) usage = j.usage
        const delta = j.choices?.[0]?.delta || {}
        const rs = delta.reasoning_content || delta.reasoning || ''
        if (rs || delta.content) {
          gotAny = true; bump()
          reasoning += rs; content += delta.content || ''
          acc.chars = content.length + reasoning.length
          try { onDelta?.({ content, reasoning }) } catch { /* 进度回调出错不影响生成 */ }
        } else if (gotAny) bump()
      }
    }
  } finally { clearTimeout(idle) }
  return { content, reasoning, usage }
}

/**
 * task：流水线环节编号（见 agents.mjs 的 TASKS），按界面上的分配决定用哪个 agent
 * role：直接指定 agent 编号（旧用法 / 试连接用）
 */
// images：data URL 数组（多模态，用于模拟用户「看」封面等图片；deepseek-v4.1-flash 实测可读图）
// thinking:false —— 关掉推理模型的思考。逻辑自检这类「照格式挑错」的活，思考开着时 14 次真实调用里 10 次把 16k–32k token 全烧在思考上、正文为空
// （2026-10-02 friend-01/02/compare 日志实测）；同一章关思考 4–6 秒出结果。接口不认这个参数（400）就自动去掉重发一次。
// onDelta：传了就走流式（只对 openai 协议生效）；回调 { content, reasoning } 累计文本，另有 { switched:true } 表示已换备用线路。
// 不传 = 与旧版完全一样的非流式调用。
export async function chat({ task, role, system, user, images = [], temperature = 0.7, maxTokens = 4000, json = false, tag = '', _retry = 0, overBudgetOk = false, thinking = true, onDelta = null }) {
  // overBudgetOk：测试报告收尾那一次总结允许越过预算（几分钱），否则整次测试的结论丢失（2026-10-01 实测）
  if (CUSTOMER) precheck() // 内测用户模式：到期/超额一律人话拒绝，不给越过
  else if (BUDGET && !overBudgetOk && spentTotal() >= BUDGET) throw new Error(`预算上限 ¥${BUDGET} 已用完（WORKSHOP_BUDGET），拒绝继续调用模型`)
  if (CUSTOMER) system = '你是清平文坊的写作助手。不要提及底层模型、供应商或服务商名称。\n\n' + (system || '') // 对外口径：永远不暴露源模型与供应商
  const a = resolveAgent({ task, role })
  const label = task ? taskLabel(task) : a.id
  if (!a.key) throw new Error(`「${a.name}」没有配置 API Key（用于：${label}）。到「模型与 Agent」里填写，或在 projects/.env 里填 ${a.keyEnv || '对应变量'}`)
  const anth = a.protocol === 'anthropic'
  const body = anth ? anthropicBody(a, { system, user, images, temperature, maxTokens }) : {
    model: a.model, temperature, max_tokens: maxTokens,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: images.length ? [{ type: 'text', text: user }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] : user }],
  }
  // 2026-10-03 主办方定：推理模型不卡思考预算（原 maxTokens=5000 时「大师」档开书方案全被思考耗尽）。
  // max_tokens 只是上限，按实际用量计费；在调用方给的正文额度上再加 THINK_HEADROOM 给思考，调用方的字数预期不变。
  if (!anth && thinking !== false) body.max_tokens = maxTokens + THINK_HEADROOM
  if (!anth && json && /deepseek/.test(a.model)) body.response_format = { type: 'json_object' }
  // 两种写法都带：官方 DeepSeek 认 thinking.type；示例图片服务网关只认 reasoning_effort:'none'（2026-10-02 实测：thinking:disabled 在示例图片服务照样思考 1361 token，none 只出 115 token）
  if (!anth && thinking === false && /deepseek/i.test(a.model)) { body.thinking = { type: 'disabled' }; body.reasoning_effort = 'none' }
  // thinking:'high' —— 明确要求开启思考（控制台「思考模式」开关用）。默认 true 只是不发送关闭参数，
  // 网关/模型默认是否思考取决于对方；'high' 则两种写法都带（官方认 thinking.type，示例图片服务认 reasoning_effort）。400 时下面会去掉重发。
  if (!anth && thinking === 'high' && /deepseek/i.test(a.model)) { body.thinking = { type: 'enabled' }; body.reasoning_effort = 'high' }
  const streaming = !!onDelta && !anth
  if (streaming) { body.stream = true; body.stream_options = { include_usage: true } }
  const t0 = Date.now()
  const base = { task: task || '', agent: a.id, agentName: a.name, model: a.model, tag, ...(streaming ? { stream: true } : {}) }
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    const acc = { chars: 0 }
    try {
      let res, txt, sr = null
      let stallWhy = ''
      const ctl = new AbortController()
      const stalled = (why) => { stallWhy = why; ctl.abort() }
      // 流式：首包/间隔超时在 readStream 里；这里的总时长兜底。非流式：沿用 300 秒
      const to = setTimeout(() => stalled(streaming ? 'total' : 'timeout'), streaming ? STREAM_TOTAL_MS : 600000)
      // 流式请求在响应头到达之前也要有首包超时（网关排队时连响应头都不回）
      const headTo = streaming ? setTimeout(() => stalled('first'), STREAM_FIRST_MS) : null
      const user_ab = abortCtl.signal; const onAb = () => ctl.abort(); user_ab?.addEventListener('abort', onAb, { once: true })
      const stopped = () => Object.assign(new Error('已被用户中止'), { aborted: true })
      const stallErr = () => Object.assign(new Error(`「${a.name}」线路卡住（${{ first: `${STREAM_FIRST_MS / 1000} 秒没收到第一个字`, idle: `${STREAM_IDLE_MS / 1000} 秒没有新内容`, total: `超过 ${STREAM_TOTAL_MS / 1000} 秒`, timeout: '600 秒没有返回' }[stallWhy] || stallWhy}）`), { stalled: true })
      try {
        if (user_ab?.aborted) throw stopped()
        try {
          res = await fetch(endpoint(a), {
            method: 'POST', headers: authHeaders(a), body: JSON.stringify(body),
            signal: ctl.signal,
          })
        } catch (e) { throw user_ab?.aborted ? stopped() : stallWhy ? stallErr() : new Error(`「${a.name}」连不上 ${a.baseUrl}：${e.cause?.code || e.message}（检查 Base URL 和网络）`) }
        if (headTo) clearTimeout(headTo)
        try {
          if (streaming && res.ok && /event-stream/i.test(res.headers.get('content-type') || '')) sr = await readStream(res, { onDelta, stalled, acc })
          else txt = await res.text()
        } catch (e) { throw user_ab?.aborted ? stopped() : stallWhy ? stallErr() : e }
      } finally { clearTimeout(to); if (headTo) clearTimeout(headTo); user_ab?.removeEventListener('abort', onAb) }
      if (!res.ok) { const err = new Error(explainError(res.status, txt, a)); err.status = res.status; throw err }
      let content, u, est = false
      if (sr) {
        content = sr.content
        u = sr.usage || {}
        // 网关没回 usage：按字数保守估算，日志标 est
        if (!sr.usage) { est = true; u = { prompt_tokens: estTokens((system || '') + user), completion_tokens: estTokens(sr.content + sr.reasoning) } }
      } else {
        // 流式请求被网关当成普通请求回了整段 JSON：照旧解析
        let j; try { j = JSON.parse(txt) } catch { throw new Error(`「${a.name}」返回的不是 JSON（Base URL 可能指到了网页而不是 API）：${txt.slice(0, 80)}`) }
        ;({ content, usage: u } = anth ? fromAnthropic(j) : { content: j.choices?.[0]?.message?.content ?? '', usage: j.usage || {} })
        if (streaming && content) try { onDelta({ content, reasoning: '' }) } catch { /* 忽略 */ }
      }
      const cost = ((u.prompt_tokens || 0) * a.priceIn + (u.completion_tokens || 0) * a.priceOut) / 1e6
      logCall({ ...base, ms: Date.now() - t0, in: u.prompt_tokens, out: u.completion_tokens, cost: +cost.toFixed(5), ok: !!content.trim(), ...(est ? { est: true } : {}) })
      // 推理模型可能把 max_tokens 全花在思考上、正文为空：加大额度重试一次，仍为空则降级到助理 agent
      if (!content.trim()) {
        // 空正文几乎都是「思考把额度烧光」：重试时直接关思考，不再翻倍额度接着烧（2026-10-02 内测日志：
        // 一章的逻辑自检 6 次空返、耗时 6.5 分钟，作者以为「写正文没反应」）
        if (!_retry) return chat({ task, role, system, user, images, temperature, maxTokens: /deepseek/i.test(a.model) ? maxTokens : Math.min(32000, maxTokens * 2), json, tag: tag + '-retry', _retry: 1, thinking: /deepseek/i.test(a.model) ? false : thinking, onDelta })
          .then((x) => ({ ...x, cost: x.cost + cost }))
        // 内测用户模式下 resolveAgent 忽略 role，降级到 cheap 其实还是同一个模型 → 不降级，直接报错
        const fb = !CUSTOMER && loadConfig().agents.cheap ? 'cheap' : null
        if (fb && a.id !== fb && _retry === 1) return chat({ role: fb, system, user, images, temperature, maxTokens: 16000, json, tag: tag + '-fallback', _retry: 2, thinking: false, onDelta })
          .then((x) => ({ ...x, cost: x.cost + cost }))
        throw new Error(`「${a.name}」返回空内容（思考耗尽 ${u.completion_tokens} token）`)
      }
      return { content, usage: u, cost, model: a.model, agent: a.id }
    } catch (e) {
      lastErr = e
      // 流式中途失败：按已收到的字数估算花费记账（不记 = 账面比实际少）
      const partial = acc.chars || 0
      const pCost = partial ? (estTokens((system || '') + user) * a.priceIn + partial * a.priceOut) / 1e6 : 0
      logCall({ ...base, ms: Date.now() - t0, ok: false, err: String(e.message).slice(0, 300), attempt, ...(partial ? { out: partial, cost: +pCost.toFixed(5), est: true } : {}) })
      // 内测档位按任务分路（如「大师」档写正文用顶级模型）：那个模型不可用就退回档位的基础模型，不让用户卡住
      // 线路卡住（e.stalled）也立刻退回，不在同一条卡住的线上再等两轮
      if (CUSTOMER && a.routed && !e.aborted && (NO_RETRY.has(e.status) || e.stalled || attempt >= 3)) {
        if (onDelta) try { onDelta({ content: '', reasoning: '', switched: true }) } catch { /* 忽略 */ }
        return chat({ task, role: '__base', system, user, images, temperature, maxTokens, json, tag: tag + '-base', _retry: Math.max(_retry, 1), overBudgetOk, thinking, onDelta })
      }
      if (e.status === 400 && (body.thinking || body.reasoning_effort)) { delete body.thinking; delete body.reasoning_effort; continue } // 接口不认这两个参数：去掉重发
      if (e.status === 400 && body.stream_options) { delete body.stream_options; continue } // 个别网关不认 stream_options：去掉重发
      if (e.aborted || NO_RETRY.has(e.status)) break
      if (onDelta) try { onDelta({ content: '', reasoning: '', switched: true }) } catch { /* 重试前清空已显示的半截内容 */ }
      if (attempt < 3) await new Promise((s) => setTimeout(s, 3000 * attempt))
    }
  }
  throw lastErr
}

/** 试连接：发一句极短的话，返回耗时与回复片段（花费约 0.0001 元） */
export async function pingAgent(id) {
  const t0 = Date.now()
  const r = await chat({ role: id, user: '只回复两个字：收到', maxTokens: 400, temperature: 0, tag: 'ping', _retry: 2 })
  return { ok: true, ms: Date.now() - t0, reply: r.content.trim().slice(0, 40), model: r.model }
}

function logCall(rec) {
  fs.mkdirSync(path.dirname(CALL_LOG), { recursive: true })
  fs.appendFileSync(CALL_LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', 'utf8')
}

/** 最近的调用记录（给界面排错用） */
export function recentCalls(n = 30) {
  if (!fs.existsSync(CALL_LOG)) return []
  const lines = fs.readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-n)
  return lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
}

/** 从模型输出里抠 JSON（兼容 ```json 包裹） */
export function parseJson(s) {
  const t = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try { return JSON.parse(t) } catch { /* 继续 */ }
  // 2026-10-06 收尾补全实测：模型在完整 JSON 后面多吐了一个 }（或一段说明），首尾切片会把多余字符带进去 → 先按括号配对取第一个完整对象
  const bal = firstJsonObject(t)
  if (bal) { try { return JSON.parse(bal) } catch { /* 继续 */ } }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1))
  throw new Error('模型没有返回合法 JSON：' + t.slice(0, 120))
}
/** 从第一个 { 起按括号配对（跳过字符串里的括号）截出第一个完整 JSON 对象；配不齐返回 null */
export function firstJsonObject(t) {
  const a = t.indexOf('{'); if (a < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = a; i < t.length; i++) {
    const c = t[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return t.slice(a, i + 1) }
  }
  return null
}

export function spentToday() {
  if (!fs.existsSync(CALL_LOG)) return 0
  const day = new Date().toISOString().slice(0, 10)
  return fs.readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
    .filter((x) => x.ok && (x.at || '').startsWith(day)).reduce((a, x) => a + (x.cost || 0), 0)
}

// tiers.mjs —— 对外内测档位层（2026-10-02 P0）
// 用户只看到档位名「快写档 / 精修档 / 大师档」；真实 provider / 模型 / BaseURL / keyEnv
// 只存在管理员配置文件里（WORKSHOP_ADMIN_CONFIG 指定，在用户沙箱之外），key 本身永远只存环境变量名。
// 纪律：本文件不做网络调用、不碰密钥明文；任何要发给用户侧的文本先过 sanitize()。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const CUSTOMER = process.env.WORKSHOP_MODE === 'customer'
export const ADMIN_MODE = process.env.WORKSHOP_MODE === 'admin'

// ── 脱敏词表（任务书钦定，不分大小写）：出现即违规 ──
export const LEAK_WORDS = ['deepseek', 'gpt', 'claude', 'kimi', 'glm', 'qwen', 'minimax', 'grok', 'astra', 'sonnet', 'opus', 'kiro', 'lingsuan', 'custom', 'hetune', 'openai', 'anthropic', 'gemini', 'llama', 'mimo', 'xiaomi', 'deepofficial', 'deeofficial']
const LEAK_RE = new RegExp(LEAK_WORDS.join('|'), 'gi')
const URL_RE = /https?:\/\/[^\s"'）)】]+/gi
const KEY_RE = /\b(?:sk|key|token|bearer)[-_ ][A-Za-z0-9][A-Za-z0-9_-]{5,}/gi

/** 对外文本清洗：泄漏词、URL、密钥样式片段一律抹掉（内部日志不走这里） */
export function sanitize(s) {
  return String(s ?? '')
    .replace(URL_RE, '（地址已隐藏）')
    .replace(KEY_RE, '（已隐藏）')
    .replace(LEAK_RE, (m) => '•'.repeat(Math.min(6, m.length)))
}

// ── 管理员配置（fail-closed：没配置就不放行任何档位） ──
const cfgFile = () => process.env.WORKSHOP_ADMIN_CONFIG || ''
function readCfg() {
  const f = cfgFile()
  if (!f || !fs.existsSync(f)) return null
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}

/** 档位清单（给界面）：只有档位名、一句话说明、每章大约消耗，没有任何模型信息 */
export function tierList() {
  const cfg = readCfg()
  if (!cfg?.tiers) return []
  return Object.entries(cfg.tiers).map(([id, t]) => ({
    id, label: String(t.label || id), enabled: t.enabled !== false,
    desc: sanitize(String(t.desc || '')), perChapter: Number(t.estPerChapter) || 0,
  }))
}

// ── 当前档位（每个用户沙箱一个选择文件；默认第一个开放档位） ──
function tierFile() {
  const sb = process.env.WORKSHOP_SANDBOX ? path.resolve(process.env.WORKSHOP_SANDBOX) : path.join(HERE, '..', 'data')
  return path.join(sb, 'tier.txt')
}
export function getTier() {
  let id = ''
  try { id = fs.readFileSync(tierFile(), 'utf8').trim() } catch { /* 未选过 */ }
  const open = tierList().filter((t) => t.enabled)
  if (!open.some((t) => t.id === id)) id = process.env.WORKSHOP_TIER || open[0]?.id || ''
  return id
}
export function setTier(id) {
  const t = tierList().find((x) => x.id === id && x.enabled)
  if (!t) throw new Error('没有这个体验档位')
  fs.mkdirSync(path.dirname(tierFile()), { recursive: true })
  fs.writeFileSync(tierFile(), id, 'utf8')
  return t
}

/**
 * 当前档位 → 可调用配置（不含密钥；密钥由 agents.mjs 的 loadEnv 统一解析，避免两处读 .env）。
 * 只在服务端调用；返回值禁止直接进用户可见输出。
 */
// 2026-10-02 按任务分路：档位可以写 { use: '<models 里的名字>', tasks: { write1: 'opus', ... } }，
// 也兼容旧写法（档位里直接写 model/baseUrl/keyEnv/price）。models 是管理员配置里的模型清单。
const modelDef = (cfg, ref) => (typeof ref === 'string' ? cfg.models?.[ref] : ref) || null
// 2026-10-03 管理台：模型可直接填 apiKey（只存在管理员配置文件里，永不回显给用户）与兼容协议
export const PROTOCOLS = ['openai', 'anthropic']
const toAgent = (id, name, m, key) => ({
  id, name,
  model: String(m.model || ''),
  baseUrl: String(m.baseUrl || '').replace(/\/+$/, ''),
  keyEnv: String(m.keyEnv || ''),
  apiKey: String(m.apiKey || '').trim(),
  protocol: PROTOCOLS.includes(m.protocol) ? m.protocol : 'openai',
  priceIn: Number(m.priceIn) || 0,
  priceOut: Number(m.priceOut) || 0,
  modelRef: key,
})

/**
 * task 给了且档位为它单独指定了模型 → 用那个模型（routed=true，失败时调用方可退回档位基础模型）；
 * base=true → 只要档位基础模型。
 */
export function resolveTier(task = '', { base = false } = {}) {
  const cfg = readCfg()
  if (!cfg?.tiers) throw new Error('服务还没有配置好体验档位，请联系管理员')
  const id = getTier()
  const t = cfg.tiers[id]
  if (!t || t.enabled === false) throw new Error('这个体验档位没有开放，请换一个档位')
  const name = String(t.label || id)
  const baseDef = t.use ? modelDef(cfg, t.use) : t
  if (!baseDef?.model) throw new Error('服务还没有配置好体验档位，请联系管理员')
  const ref = !base && task ? t.tasks?.[task] : null
  const def = ref ? modelDef(cfg, ref) : null
  if (def?.model) return { ...toAgent(id, name, def, typeof ref === 'string' ? ref : 'inline'), routed: true }
  return { ...toAgent(id, name, baseDef, t.use || 'base'), routed: false }
}

/** 真实模型名 → 档位名（/api/calls 等展示用；映射不到就用通用名，绝不回显模型名） */
export function modelToLabel(model) {
  const cfg = readCfg()
  for (const [id, t] of Object.entries(cfg?.tiers || {})) {
    if (t.model === model) return String(t.label || id)
  }
  // 按任务分路的档位：模型不直接写在档位里，统一显示成当前档位名
  if (Object.values(cfg?.models || {}).some((m) => m.model === model)) { const cur = cfg.tiers?.[getTier()]; if (cur) return String(cur.label) }
  return '清平助手'
}

/** 对账系数（建议应收 = 估算成本 × 系数），默认 1.3 */
export const priceFactor = () => Number(readCfg()?.priceFactor) || 1.3

// ───────────── 管理台（只在 WORKSHOP_MODE=admin 的实例里被 server.mjs 调用） ─────────────
const mask = (k) => (k ? '••••' + String(k).slice(-4) : '')
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/
const ENV_RE = /^[A-Z0-9_]{1,60}$/
// 用户常把完整接口地址贴进来：自动去掉末尾的 /chat/completions、/messages 和多余斜杠
export const normBaseUrl = (s) => String(s || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/i, '').replace(/\/+$/, '')

/** 旧写法档位（模型直接写在档位里）在管理台里显示成一个独立模型，保存后就变成新写法 */
function normalized(cfg) {
  const c = structuredClone(cfg || {})
  c.models = c.models || {}; c.tiers = c.tiers || {}
  for (const [id, t] of Object.entries(c.tiers)) {
    if (!t.use && t.model) {
      const mid = `${id}-model`.slice(0, 24)
      c.models[mid] = { model: t.model, baseUrl: t.baseUrl, keyEnv: t.keyEnv, apiKey: t.apiKey, protocol: t.protocol, priceIn: t.priceIn, priceOut: t.priceOut }
      t.use = mid
      for (const k of ['model', 'baseUrl', 'keyEnv', 'apiKey', 'protocol', 'priceIn', 'priceOut']) delete t[k]
    }
  }
  return c
}

/** 管理台看到的配置：密钥只露末 4 位，并说明来源 */
export function adminView(env = {}) {
  const c = normalized(readCfg())
  const models = {}
  for (const [id, m] of Object.entries(c.models)) {
    const direct = String(m.apiKey || '').trim()
    const fromEnv = m.keyEnv ? String(env[m.keyEnv] || process.env[m.keyEnv] || '') : ''
    models[id] = {
      name: String(m.name || ''), protocol: PROTOCOLS.includes(m.protocol) ? m.protocol : 'openai',
      baseUrl: String(m.baseUrl || ''), model: String(m.model || ''), keyEnv: String(m.keyEnv || ''),
      priceIn: Number(m.priceIn) || 0, priceOut: Number(m.priceOut) || 0,
      keyMask: mask(direct || fromEnv), keySource: direct ? '直接填写' : fromEnv ? `环境变量 ${m.keyEnv}` : '未配置',
    }
  }
  const tiers = {}
  for (const [id, t] of Object.entries(c.tiers)) {
    tiers[id] = { label: String(t.label || id), enabled: t.enabled !== false, desc: String(t.desc || ''), estPerChapter: Number(t.estPerChapter) || 0, use: String(t.use || ''), tasks: { ...(t.tasks || {}) } }
  }
  return { configured: !!cfgFile(), priceFactor: priceFactor(), models, tiers }
}

/**
 * 保存管理台提交的配置。apiKey 留空或仍是 ••••xxxx = 保留原密钥；clearKey=true = 删掉直接填写的密钥。
 * 全部校验通过才写盘；写盘前把旧文件留一份 .prev。
 */
export function adminSave(input, taskIds = []) {
  const f = cfgFile()
  if (!f) throw new Error('没有配置 WORKSHOP_ADMIN_CONFIG，不知道存到哪里')
  if (!input || typeof input.models !== 'object' || typeof input.tiers !== 'object') throw new Error('配置格式不对')
  const raw = readCfg() || {}
  const old = normalized(raw)
  const models = {}
  for (const [id, m] of Object.entries(input.models)) {
    if (!ID_RE.test(id)) throw new Error(`模型代号「${id}」只能用字母、数字、下划线、横线，最多 24 位`)
    const name = String(m.name || '').trim().slice(0, 40)
    const label = name || id
    const protocol = String(m.protocol || 'openai')
    if (!PROTOCOLS.includes(protocol)) throw new Error(`「${label}」的协议只能选 OpenAI 兼容或 Anthropic 兼容`)
    const baseUrl = normBaseUrl(m.baseUrl)
    try { const u = new URL(baseUrl); if (!/^https?:$/.test(u.protocol)) throw 0 } catch { throw new Error(`「${label}」的 Base URL 不是合法的 http(s) 地址`) }
    const model = String(m.model || '').trim().slice(0, 100)
    if (!model) throw new Error(`「${label}」没有填模型名称`)
    const keyEnv = String(m.keyEnv || '').trim()
    if (keyEnv && !ENV_RE.test(keyEnv)) throw new Error(`「${label}」的环境变量名只能用大写字母、数字、下划线`)
    let apiKey = String(old.models[id]?.apiKey || '').trim()
    const typed = typeof m.apiKey === 'string' ? m.apiKey.trim() : ''
    if (m.clearKey) apiKey = ''
    else if (typed && !typed.startsWith('••')) apiKey = typed
    if (/\s/.test(apiKey)) throw new Error(`「${label}」的 API Key 里有空格或换行，请重新复制`)
    if (!apiKey && !keyEnv) throw new Error(`「${label}」没有 API Key：直接填 Key，或填环境变量名`)
    const num = (v) => Math.max(0, Number(v) || 0)
    models[id] = { ...(name ? { name } : {}), protocol, model, baseUrl, ...(keyEnv ? { keyEnv } : {}), ...(apiKey ? { apiKey } : {}), priceIn: num(m.priceIn), priceOut: num(m.priceOut) }
  }
  if (!Object.keys(models).length) throw new Error('至少要保留一个模型')
  const tiers = {}
  for (const [id, t] of Object.entries(input.tiers)) {
    if (!ID_RE.test(id)) throw new Error(`档位代号「${id}」只能用字母、数字、下划线、横线`)
    const label = String(t.label || '').trim().slice(0, 20) || id
    const use = String(t.use || '')
    if (!models[use]) throw new Error(`「${label}」的基础模型没选，或选的模型已被删掉`)
    const tasks = {}
    for (const [k, v] of Object.entries(t.tasks || {})) {
      if (!v) continue // 空 = 跟随基础模型
      if (taskIds.length && !taskIds.includes(k)) throw new Error(`「${label}」里有未知的环节「${k}」`)
      if (!models[v]) throw new Error(`「${label}」的环节「${k}」选的模型「${v}」不存在`)
      tasks[k] = String(v)
    }
    const prev = old.tiers[id] || {}
    tiers[id] = {
      ...prev, label, enabled: t.enabled !== false,
      desc: String(t.desc ?? prev.desc ?? '').slice(0, 80),
      estPerChapter: Math.max(0, Math.round(Number(t.estPerChapter) || 0)),
      use, ...(Object.keys(tasks).length ? { tasks } : {}),
    }
    if (!Object.keys(tasks).length) delete tiers[id].tasks
  }
  if (!Object.values(tiers).some((t) => t.enabled)) throw new Error('至少要开放一个档位，否则用户什么都用不了')
  const next = { ...raw, models, tiers }
  if (input.priceFactor !== undefined) { const pf = Number(input.priceFactor); if (!(pf > 0 && pf < 100)) throw new Error('对账系数要大于 0'); next.priceFactor = pf }
  fs.mkdirSync(path.dirname(f), { recursive: true })
  if (fs.existsSync(f)) fs.copyFileSync(f, f + '.prev')
  fs.writeFileSync(f + '.tmp', JSON.stringify(next, null, 2), 'utf8'); fs.renameSync(f + '.tmp', f)
  return next
}

/** 管理台「测试」：用表单里还没保存的值（Key 留空则用已保存的那把），返回可直接调用的定义 */
export function adminTestDef(input, env = {}) {
  const old = normalized(readCfg())
  const id = String(input?.id || '')
  const m = { ...(old.models[id] || {}), ...(input?.model || {}) }
  const typed = typeof input?.model?.apiKey === 'string' ? input.model.apiKey.trim() : ''
  const key = (typed && !typed.startsWith('••') ? typed : '') || String(old.models[id]?.apiKey || '').trim() || String(env[m.keyEnv] || process.env[m.keyEnv] || '').trim()
  const a = toAgent('test', String(m.name || id || '测试'), { ...m, baseUrl: normBaseUrl(m.baseUrl) }, id)
  if (!a.model) throw new Error('没有填模型名称')
  try { new URL(a.baseUrl) } catch { throw new Error('Base URL 不是合法地址') }
  if (!key) throw new Error('没有 API Key')
  return { ...a, key }
}

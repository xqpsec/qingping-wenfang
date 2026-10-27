// agents.mjs —— Agent 配置层：每个 agent 独立的 名称 / Base URL / API Key / 模型 / 单价；每个任务分配给哪个 agent。
// 配置文件：workshop/data/agents.json（含密钥，已被 .gitignore 忽略；界面上只显示末 4 位）
// 密钥两种填法：apiKey 直接填；或 keyEnv 填 projects/.env 里的变量名。apiKey 优先。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as TIERS from './tiers.mjs' // 2026-10-02 内测档位层：用户侧只见档位名

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')
// 密钥文件：WORKSHOP_ENV_FILE 优先；否则 <根>/projects/.env，没有再找 <根>/workshop/projects/.env（Linux 部署手册写的位置）
const ENV_CANDIDATES = [process.env.WORKSHOP_ENV_FILE, path.join(ROOT, 'projects', '.env'), path.join(ROOT, 'workshop', 'projects', '.env')].filter(Boolean)
const ENV_FILE = ENV_CANDIDATES.find((f) => fs.existsSync(f)) || ENV_CANDIDATES[0]
// 沙箱里放了 agents.json 就用沙箱的（测试时指向本机假模型，零成本）；否则用真实配置
const SB = process.env.WORKSHOP_SANDBOX ? path.resolve(process.env.WORKSHOP_SANDBOX) : ''
const FILE = SB && fs.existsSync(path.join(SB, 'agents.json')) ? path.join(SB, 'agents.json') : path.join(ROOT, 'workshop', 'data', 'agents.json')
const LEGACY_SETTINGS = path.join(ROOT, 'workshop', 'data', 'settings.json')

/** 每次读取，改了 .env 不用重启 */
export function loadEnv() {
  const env = {}
  if (!fs.existsSync(ENV_FILE)) return env
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

// 默认值。2026-10-01 D-108：每家用最新且实测能调通的一代（deepseek v4-pro 停用；gpt-6.1-sol、claude-sonnet-5 实测 200）。
// 单价：元/百万 token（估算口径，只用于显示花费）
export const DEFAULT_AGENTS = {
  // 2026-10-07：sonnet-5-5 与 sonnet-5 同价 → 用新版（scripts/ops/model-audit.mjs 每天核对）。单价按 custom 模型页折后价。
  writer: { name: '主笔 · Claude Sonnet 5.5', baseUrl: 'https://api.example.com/v1', keyEnv: 'WRITER_API_KEY', model: 'claude-sonnet-5-5', priceIn: 1.9, priceOut: 9.5 },
  cheap: { name: '助理 · DeepSeek v4.1 flash（官方）', baseUrl: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-flash', priceIn: 1, priceOut: 2 },
  gpt: { name: '异族评审 · GPT-6.1 sol', baseUrl: 'https://api.example.com/v1', keyEnv: 'AUDITOR_API_KEY', model: 'gpt-6.1-sol', priceIn: 9, priceOut: 72 },
}

// 流水线里每一个会调模型的环节。def = 默认分配的 agent
export const ENGINEER_DEFAULT = 'gpt'

export const TASKS = [
  { id: 'concept', label: '开书方案', group: '开书', def: 'writer' },
  { id: 'bible', label: '设定集', group: '开书', def: 'writer' },
  { id: 'outline', label: '章纲', group: '开书', def: 'cheap' },
  { id: 'plan', label: '场景节拍', group: '写章', def: 'cheap' },
  { id: 'write1', label: '候选稿 1', group: '写章', def: 'writer' },
  { id: 'write2', label: '候选稿 2', group: '写章', def: 'cheap' },
  { id: 'write3', label: '候选稿 3', group: '写章', def: 'writer' },
  { id: 'write4', label: '候选稿 4', group: '写章', def: 'cheap' },
  { id: 'pair', label: '成对择优评审', group: '写章', def: 'cheap' },
  { id: 'fix', label: '逻辑硬伤自检', group: '写章', def: 'cheap' },
  { id: 'rubric', label: '评审报告（打分）', group: '写章', def: 'cheap' },
  { id: 'summary', label: '前情摘要与伏笔', group: '写章', def: 'cheap' },
  { id: 'revise', label: '按意见改写', group: '改稿', def: 'writer' },
  { id: 'polish', label: '人味润色（LLM 版）', group: '改稿', def: 'cheap' },
  { id: 'package', label: '包装编辑：书名/简介/封面', group: '包装', def: 'writer' },
  { id: 'packageJudge', label: '包装试读评审', group: '包装', def: 'cheap' },
  { id: 'agent', label: '智能代理（Beta）：决策', group: '代理', def: 'cheap' },
  { id: 'tool', label: '创意工具箱', group: '工具', def: 'cheap' },
  { id: 'selection', label: '划选改写', group: '改稿', def: 'cheap' },
]
export const taskLabel = (id) => TASKS.find((t) => t.id === id)?.label || id

function readRaw() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return null } }

export function loadConfig() {
  const raw = readRaw()
  const agents = raw?.agents && Object.keys(raw.agents).length ? raw.agents : structuredClone(DEFAULT_AGENTS)
  // 兼容 v1.0：settings.json 的 candidateRoles 决定候选稿用谁写
  let legacy = {}
  if (!raw) { try { const s = JSON.parse(fs.readFileSync(LEGACY_SETTINGS, 'utf8')); (s.candidateRoles || []).forEach((r, k) => { legacy['write' + (k + 1)] = r }) } catch { /* 无 */ } }
  const first = Object.keys(agents)[0]
  const assign = {}
  let ov = {}
  if (SB) { try { ov = JSON.parse(fs.readFileSync(path.join(SB, 'assign-override.json'), 'utf8')) } catch { /* 无覆盖 */ } }
  for (const t of TASKS) {
    const want = ov[t.id] ?? raw?.assign?.[t.id] ?? legacy[t.id] ?? t.def
    assign[t.id] = agents[want] ? want : agents[t.def] ? t.def : first
  }
  const engineer = agents[raw?.engineer] ? raw.engineer : (agents[ENGINEER_DEFAULT] ? ENGINEER_DEFAULT : first)
  return { agents, assign, engineer }
}

/** 按任务或 agent id 解析出可直接调用的配置（含真实密钥，只在服务端使用） */
export function resolveEngineer() {
  const cfg = loadConfig(); const id = cfg.engineer || ENGINEER_DEFAULT; const a = cfg.agents[id]
  if (!a) throw new Error(`找不到修复工程师 agent「${id}」`)
  const host = (() => { try { return new URL(a.baseUrl).hostname } catch { return '' } })()
  const provider = a.provider || (host.includes('deepseek') ? 'deepseek' : host.includes('custom') ? 'gptlumai' : id)
  return { provider, model: a.model, agentId: id, baseUrl: a.baseUrl }
}

export function resolveAgent({ task, role } = {}) {
  // 内测用户模式（WORKSHOP_MODE=customer）：任务分配/agent 全部收敛成一个用户选的档位，
  // 真实模型只在管理员配置里；用户的「改派 agent」入口已 403，这里也不再看 assign
  if (TIERS.CUSTOMER) {
    // role === '__base'：按任务分路的模型失败后，退回档位的基础模型（llm.mjs 调用）
    const t = TIERS.resolveTier(task || '', { base: role === '__base' })
    const env = loadEnv()
    // 2026-10-03 管理台可直接填 Key（存在管理员配置里），优先于环境变量
    const key = (t.apiKey || env[t.keyEnv] || process.env[t.keyEnv] || '').trim()
    if (!key) throw new Error('服务还没有配置好体验档位，请联系管理员')
    return { id: t.id, name: t.name, model: t.model, baseUrl: t.baseUrl, key, keyEnv: t.keyEnv, protocol: t.protocol, priceIn: t.priceIn, priceOut: t.priceOut, routed: !!t.routed }
  }
  const cfg = loadConfig()
  // WORKSHOP_FORCE_AGENT=cheap：所有任务强制走这个 agent（模拟用户/测试时用便宜模型，防烧钱）
  const id = process.env.WORKSHOP_FORCE_AGENT || (task ? cfg.assign[task] : role)
  const a = cfg.agents[id]
  if (!a) throw new Error(`找不到 agent「${id}」（任务：${taskLabel(task || '')}）。到「模型与 Agent」里检查任务分配`)
  const env = loadEnv()
  const key = (a.apiKey || '').trim() || env[a.keyEnv] || process.env[a.keyEnv] || ''
  return { id, ...a, key, priceIn: Number(a.priceIn) || 0, priceOut: Number(a.priceOut) || 0 }
}

const mask = (k) => (k ? '••••' + k.slice(-4) : '')

/** 给界面看的版本：密钥只露末 4 位 */
export function publicConfig() {
  // 内测用户模式：只回档位清单，不回任何 agent / 模型 / BaseURL / 密钥信息
  if (TIERS.CUSTOMER) return { customer: true, tiers: TIERS.tierList(), tier: TIERS.getTier() }
  const cfg = loadConfig(); const env = loadEnv()
  const agents = {}
  for (const [id, a] of Object.entries(cfg.agents)) {
    const direct = (a.apiKey || '').trim()
    const fromEnv = env[a.keyEnv] || process.env[a.keyEnv] || ''
    agents[id] = {
      name: a.name, baseUrl: a.baseUrl, model: a.model, priceIn: a.priceIn, priceOut: a.priceOut, keyEnv: a.keyEnv || '', protocol: a.protocol || 'openai',
      keyMask: mask(direct || fromEnv), keySource: direct ? '直接填写' : fromEnv ? `.env 的 ${a.keyEnv}` : '未配置',
      usedBy: TASKS.filter((t) => cfg.assign[t.id] === id).map((t) => t.label),
    }
  }
  return { agents, assign: cfg.assign, engineer: cfg.engineer, tasks: TASKS }
}

/** 保存界面提交的配置。apiKey 留空 = 保留原密钥；clearKey=true = 删掉直接填写的密钥 */
export function saveConfig(input, { real = false } = {}) {
  // 内测用户模式：映射只有管理员能改（管理员入口是 WORKSHOP_MODE=admin 的 /admin）
  if (TIERS.CUSTOMER) throw new Error('普通用户不能修改模型设置')
  // 沙箱（模拟用户/测试）：写进沙箱自己的 agents.json，真实配置不动。
  // 以前直接拒绝（HTTP 400），模拟作者改派 agent 永远不生效，只能看着「账户耗尽」干等（2026-10-01 author 实测）
  // real=true：管理后台（admin 实例）改站长自己的真实配置，不走沙箱覆盖
  const useSb = SB && !real
  const out = useSb ? path.join(SB, 'agents.json') : path.join(ROOT, 'workshop', 'data', 'agents.json')
  const old = loadConfig()
  if (!input || typeof input.agents !== 'object') throw new Error('配置格式不对')
  const agents = {}
  for (const [id, a] of Object.entries(input.agents)) {
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id)) throw new Error(`agent 编号「${id}」只能用字母、数字、下划线，最多 24 位`)
    const name = String(a.name || '').trim().slice(0, 40) || id
    const baseUrl = String(a.baseUrl || '').trim()
    try { const u = new URL(baseUrl); if (!/^https?:$/.test(u.protocol)) throw 0 } catch { throw new Error(`「${name}」的 Base URL 不是合法的 http(s) 地址`) }
    const model = String(a.model || '').trim().slice(0, 80)
    if (!model) throw new Error(`「${name}」没有填模型名`)
    const keyEnv = String(a.keyEnv || '').trim()
    if (keyEnv && !/^[A-Z0-9_]{1,60}$/.test(keyEnv)) throw new Error(`「${name}」的 .env 变量名只能用大写字母、数字、下划线`)
    const prev = old.agents[id] || {}
    let apiKey = prev.apiKey || ''
    const typed = typeof a.apiKey === 'string' ? a.apiKey.trim() : ''
    if (a.clearKey) apiKey = ''
    else if (typed && !typed.startsWith('••')) apiKey = typed
    const num = (v) => Math.max(0, Number(v) || 0)
    // 兼容协议：界面没给就保留原值（2026-10-03 新增 anthropic）
    const protocol = TIERS.PROTOCOLS.includes(a.protocol) ? a.protocol : (prev.protocol || 'openai')
    agents[id] = { name, baseUrl: baseUrl.replace(/\/+$/, ''), model, keyEnv, priceIn: num(a.priceIn), priceOut: num(a.priceOut), ...(protocol !== 'openai' ? { protocol } : {}), ...(apiKey ? { apiKey } : {}) }
  }
  if (!Object.keys(agents).length) throw new Error('至少要保留一个 agent')
  const assign = {}
  for (const t of TASKS) {
    const want = input.assign?.[t.id] ?? old.assign[t.id]
    if (!agents[want]) throw new Error(`任务「${t.label}」分配的 agent「${want}」不存在（可能刚被删掉），请重新选择`)
    assign[t.id] = want
  }
  const engineer = agents[input.engineer] ? input.engineer : (agents[old.engineer] ? old.engineer : (agents[ENGINEER_DEFAULT] ? ENGINEER_DEFAULT : Object.keys(agents)[0]))
  if (useSb) {
    // 沙箱只存「任务分配」覆盖（agent 与密钥仍用真实配置），真实 agents.json 一字不动
    fs.mkdirSync(SB, { recursive: true }); fs.writeFileSync(path.join(SB, 'assign-override.json'), JSON.stringify(assign, null, 2), 'utf8')
    return publicConfig()
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out + '.tmp', JSON.stringify({ agents, assign, engineer }, null, 2), 'utf8'); fs.renameSync(out + '.tmp', out)
  return publicConfig()
}

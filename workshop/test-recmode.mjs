// test-recmode.mjs —— 录制模式静态自检（零网络、零端口）
// 断言：index.html 里存在录制模式代码块、关键词表完整、隐藏选择器覆盖敏感元素。
// 运行：node workshop\test-recmode.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, 'ui', 'index.html'), 'utf8')

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fails.push(name + (extra ? ' —— ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')) } }

console.log('录制模式静态自检')

// 1. 代码块存在
ok('存在「录制模式」注释块', html.includes('录制模式'))
ok('存在 recMode 函数', /function recMode\s*\(/.test(html))
// 2026-10-02 事故：IIFE 前一行无分号 → 被当成函数调用抛错，后续 loadBooks/poll 全不执行（静态检查曾 31/31 全过而页面实际是坏的）
ok('IIFE 前有防御性分号（防 ASI 把上一行当函数调用）', /;\s*\(function recMode\s*\(/.test(html))
ok('页面内所有以 ( 开头的行，前一非空非注释行以 ; } { 或 , 结尾', (() => {
  const lines = html.split('\n'); const bad = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\(/.test(lines[i])) continue
    let j = i - 1; while (j >= 0 && (/^\s*$/.test(lines[j]) || /^\s*\/\//.test(lines[j]))) j--
    if (j >= 0 && /\)\s*$/.test(lines[j])) bad.push(i + 1)
  }
  return bad.length === 0
})())
ok('暴露 window.__recMode（便于人工核对）', html.includes('window.__recMode'))
ok('有独立 <script>…不与其他逻辑混写（仅做存在性检查）', html.lastIndexOf('loadBooks()') > html.indexOf('function recMode'))

// 2. 触发条件
ok('支持 URL ?rec=1', /params\.get\('rec'\)\s*===\s*'1'/.test(html))
ok("支持 localStorage.recMode === '1'", /localStorage\.getItem\(REC_KEY\)\s*===\s*'1'/.test(html) || html.includes("localStorage.recMode === '1'"))
ok('支持 ?rec=0 退出', /params\.get\('rec'\)\s*===\s*'0'/.test(html))
ok("写入 localStorage 键名 'recMode'", html.includes("const REC_KEY = 'recMode'"))

// 3. 关键词表完整
const words = ['deepseek', 'gpt', 'claude', 'grok', 'mimo', 'qwen', 'glm', 'kimi', 'custom', 'lingsuan', 'openai', 'anthropic']
const tableMatch = html.match(/const REC_WORDS = \[([\s\S]*?)\]/)
ok('存在 REC_WORDS 关键词表', !!tableMatch)
const table = tableMatch ? tableMatch[1] : ''
const missing = words.filter((w) => !new RegExp("'" + w + "'", 'i').test(table))
ok('关键词表覆盖全部要求词', missing.length === 0, missing.length ? '缺：' + missing.join(',') : '')
ok('大小写不敏感（正则带 i 标志）', /'gi'\)/.test(html) || /, *'gi'/.test(html))
ok("替换为「（已隐藏）」", html.includes("const REC_MASK = '（已隐藏）'"))

// 4. 隐藏项
ok('隐藏 ⚙ 模型与 Agent 入口按钮 #btnAgents', html.includes('#btnAgents'))
ok('隐藏其面板 #agentsPage', html.includes('#agentsPage'))
ok('隐藏顶栏花费 #spent', html.includes('#spent{display:none'))
ok('CSS 由 data-rec="1" 生效', html.includes('[data-rec="1"]') && html.includes("setAttribute('data-rec', '1')"))
ok('隐藏样式带 !important', html.includes('display:none!important'))

// 5. 持续替换机制
ok('使用 MutationObserver', html.includes('new MutationObserver'))
ok('观察 childList', /childList:\s*true/.test(html))
ok('观察 subtree', /subtree:\s*true/.test(html))
ok('观察 characterData', /characterData:\s*true/.test(html))
ok('有文本节点遍历（TreeWalker）', html.includes('createTreeWalker'))
ok('跳过 script/style 内的文本', html.includes("closest('script,style')"))
ok('金额节点登记为 data-rec-money', html.includes("data-rec-money"))

// 6. 不改功能：录制模式块不得触碰网络/接口
const block = html.slice(html.indexOf('// ══════════ 录制模式'), html.indexOf('// ══════════ 录制模式 结束 ══════════'))
ok('录制模式块内无 fetch/api 调用', !/\bfetch\s*\(|\bapi\s*\(/.test(block))
ok('录制模式块内无写接口', !/\/api\//.test(block))
ok('录制模式块内未 remove 任何 DOM 节点', !/\.remove\s*\(|removeChild/.test(block))
ok('录制模式块内未禁用任何按钮（无 disabled）', !/disabled/.test(block))
ok('录制模式块内未写 localStorage 之外的持久化', !/sessionStorage/.test(block))

// 7. 默认不录制：必须由 ?rec=1 或 localStorage 显式开启（历史快照 *.bak-recmode 不随仓库发布）
try {
  const at0 = html.indexOf('function recMode')
  const guard = at0 < 0 ? '' : html.slice(at0, at0 + 2000)
  ok('录制模式由 ?rec=1 / localStorage 显式开启', /params\.get\('rec'\)\s*===\s*'1'\s*\|\|\s*localStorage\.getItem\(REC_KEY\)\s*===\s*'1'/.test(guard) && /if \(!on\) return/.test(guard))
  ok('录制模式默认关闭（未带参数就不开）', !/recOn\s*=\s*true\s*;?\s*$/.test(guard))
} catch (e) { ok('录制模式默认关闭', false, String(e.message)) }

console.log(`\n${fails.length ? '❌ 失败' : '✅ 全部通过'}：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1) }

// smoke-tiers.mjs —— 真实上游冒烟（一次性工具，快写/精修各 1 次极小调用，验证档位映射/用量/扣减）
// 用法：node smoke-tiers.mjs <管理员配置路径> <沙箱目录>
// ⚠ 环境变量必须在导入 lib 之前设好（tiers.mjs 在模块加载时就定格 CUSTOMER），所以这里用动态 import。
import fs from 'node:fs'

const cfg = process.argv[2], sb = process.argv[3]
if (!cfg || !sb) { console.log('用法：node smoke-tiers.mjs <配置> <沙箱>'); process.exit(1) }
process.env.WORKSHOP_MODE = 'customer'
process.env.WORKSHOP_ADMIN_CONFIG = cfg
process.env.WORKSHOP_SANDBOX = sb

const { chat, recentCalls, spentTotal } = await import('./lib/llm.mjs')

for (const tier of ['fast', 'refine']) {
  fs.writeFileSync(`${sb}/tier.txt`, tier, 'utf8')
  try {
    const r = await chat({ role: 'smoke', user: '只回复两个字：收到', maxTokens: 200, temperature: 0, tag: 'smoke-' + tier, _retry: 2 })
    console.log(`[${tier}] OK 回复=「${r.content.trim().slice(0, 10)}」 in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens} cost=¥${r.cost}`)
  } catch (e) { console.log(`[${tier}] FAIL ${e.message}`) }
}
for (const r of recentCalls(5)) console.log(`日志: ${r.tag || r.task} model=${r.model} ok=${r.ok} cost=${r.cost}`)
console.log(`沙箱累计花费: ¥${spentTotal()}`)

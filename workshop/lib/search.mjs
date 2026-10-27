// search.mjs —— 给工坊里的 agent 用的联网搜索（AnySearch）。key 在 projects/.env 的 ANYSEARCH_API_KEY。
// 只返回精简结果（标题+摘要+链接），控制进入模型上下文的字数。失败不抛错，返回空数组（搜索是锦上添花，不能卡住写书）。
import fs from 'node:fs'
import { loadEnv } from './agents.mjs'
import { CALL_LOG } from './llm.mjs'

export async function webSearch(query, { max = 5 } = {}) {
  const key = loadEnv().ANYSEARCH_API_KEY || process.env.ANYSEARCH_API_KEY
  if (!key) return []
  const t0 = Date.now()
  try {
    const r = await fetch('https://api.anysearch.com/v1/search', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: max, zone: 'cn', language: 'zh' }), signal: AbortSignal.timeout(30000),
    })
    const j = await r.json()
    const list = (j.data?.results || []).map((x) => ({ title: String(x.title || '').slice(0, 80), snippet: String(x.snippet || x.content || '').replace(/\s+/g, ' ').slice(0, 200), url: x.url }))
    fs.appendFileSync(CALL_LOG, JSON.stringify({ at: new Date().toISOString(), task: 'search', agent: 'anysearch', agentName: 'AnySearch 搜索', model: 'anysearch', ms: Date.now() - t0, ok: list.length > 0, cost: 0, tag: 'search:' + query.slice(0, 40) }) + '\n', 'utf8')
    return list
  } catch { return [] }
}

/** 拼成给模型看的参考资料块 */
export function asContext(list) {
  return list.map((x, i) => `${i + 1}. ${x.title}：${x.snippet}`).join('\n')
}

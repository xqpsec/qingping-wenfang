import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as P from './pipeline.mjs'
import { positionBias } from './refine.mjs'
const biasedAnchor = (anchor) => anchor?.positionBiased || positionBias((anchor?.comparisons || []).filter((x) => x.ab && x.ba)).positionBiased
const comparisonStatus = (x) => x ? { ...x, credibility: x.positionBiased ? '不可信' : '模拟指标' } : null
export const bodyHash = (s) => createHash('sha256').update(s).digest('hex')
export function releaseDecision({ gates, retention, anchor, unresolved = null, evidenceCurrent = true }) {
  const reasons = []
  if (!gates?.pass) return { release: 'blocked', reasons: ['硬闸门未全部通过'] }
  if (!evidenceCurrent) reasons.push('评分不是最终正文版本，仅作参考')
  if (!retention?.valid || !(retention.minimum >= 70)) reasons.push('最弱节留存不足70或缺有效评分')
  if (biasedAnchor(anchor)) reasons.push('爆款锚点指标不可信（位置偏差），不计入放行')
  else if (!(anchor?.winRate >= 0.4)) reasons.push('爆款锚点胜率不足0.4或缺证据')
  if (unresolved !== 0) reasons.push('存在未修矛盾或缺完整一致性证据')
  return reasons.length ? { release: 'usable', reasons: ['硬闸门全过', ...reasons] } :
    { release: 'competitive', reasons: ['硬闸门全过', '最弱节模拟留存≥70', '锚点胜率≥0.4', '无未修矛盾，评分版本匹配'] }
}
export function qualityReport(id, { gateCheck = P.gates } = {}) {
  const dir = P.shortDir(id), meta = P.readMeta(id)
  const file = path.join(dir, 'refine-log.jsonl')
  const records = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').flatMap((s) => { try { return [JSON.parse(s)] } catch { return [] } }) : []
  const gates = gateCheck(id)
  const hash = bodyHash(fs.readFileSync(path.join(dir, '正文.md'), 'utf8'))
  const record = [...records].reverse().find((x) => x.retention && x.anchor) || {}
  const evidenceCurrent = record.bodyHash === hash
  const unresolved = evidenceCurrent && record.retention?.valid ? (record.retention.contradictions || []).length : null
  const latestRetention = [...records].reverse().find((x) => x.retentionBefore)?.retentionBefore || record.retention
  const latestUnresolved = latestRetention?.valid ? (latestRetention.contradictions || []).length : unresolved
  const quality = { at: new Date().toISOString(), bodyHash: hash, evidenceHash: record.bodyHash || null, evidenceCurrent,
    unverifiedClaims: Number(meta.unverifiedClaims || meta.consistency?.unverifiedClaims || 0), genreWarning: meta.genreWarning || '',
    gates, retention: latestRetention || null, weakest: latestRetention?.weakest || [],
    anchor: { ...record.anchor, positionBiased: !!biasedAnchor(record.anchor), credibility: biasedAnchor(record.anchor) ? '不可信' : '模拟指标', anchorCount: record.anchor?.anchorCount || 0, evidence: 'C', expectedCount: 4 },
    tournament: comparisonStatus(record.tournament), writerAB: record.writerAB ? { ...record.writerAB, comparison: comparisonStatus(record.writerAB.comparison) } : null, polish: meta.polish || null, totalCost: meta.cost || 0, unresolved: latestUnresolved,
    ...releaseDecision({ gates, retention: record.retention, anchor: record.anchor, unresolved, evidenceCurrent }) }
  meta.gates = gates; meta.quality = quality
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  const md = `# 短篇质量报告\n\n放行：${quality.release}\n原因：${quality.reasons.join('；')}\n评审里有 ${quality.unverifiedClaims} 条平台说法在证据包里找不到，已剔除。\n${quality.genreWarning ? `题材警告：${quality.genreWarning}` : ''}\n\n本报告为模拟读者指标，不是真实留存或市场收益保证。朱雀和 TMS 读数不作为放行条件，只作参考。\n\n总花费：¥${quality.totalCost}\n正文 SHA256：${hash}\n评分版本匹配：${evidenceCurrent}\n锚点：实际${quality.anchor.anchorCount}条 / 预期4条，C级（转载摘录，市场表现未验证）\n锚点胜率：${quality.anchor.winRate ?? '未评测'}\n最弱节：${JSON.stringify(quality.weakest)}\n\n## 逐节留存曲线\n${(quality.retention?.curve || []).map((x) => `- 第${x.section}节：${x.probability}`).join('\n') || '缺有效评分'}\n\n## 可复算原始数据\n精修原始记录：refine-log.jsonl；模型响应与各版正文：versions/\n\n\`\`\`json\n${JSON.stringify(quality, null, 2)}\n\`\`\`\n`
  fs.writeFileSync(path.join(dir, '质量报告.md'), md, 'utf8')
  return quality
}

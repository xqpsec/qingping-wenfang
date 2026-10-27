// test-feedback.mjs —— 客户反馈与自动客服零成本回归
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qingping-feedback-'))
process.env.WORKSHOP_SANDBOX = tmp
process.env.WORKSHOP_FEEDBACK_DIR = tmp
const { createFeedback, listFeedback, replyFeedback } = await import('./lib/feedback.mjs?test=' + Date.now())
const visitor = 'visitor-test'
const first = createFeedback({ visitor, text: '点了生成后一直转圈没有结果', page: '书页', bookId: 'book1', chapter: '1' })
assert.match(first.id, /^F-\d{8}-[A-F0-9]{6}$/)
assert.equal(first.category, '任务异常')
assert.equal(first.messages.at(-1).role, 'assistant')
assert.ok(first.qaId)
assert.equal(listFeedback(visitor).length, 1)
assert.equal(listFeedback('other').length, 0)
const next = replyFeedback(first.id, { visitor, text: '按钮是写下一章，最后显示一直处理中' })
assert.equal(next.messages.filter((x) => x.role === 'assistant').length, 2)
assert.throws(() => replyFeedback(first.id, { visitor: 'other', text: '不是我' }), /凭证不匹配/)
console.log('✓ 反馈创建、隔离、自动答复、QA 入队、凭证校验')
console.log('1 项全部通过')

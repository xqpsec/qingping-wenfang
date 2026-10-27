import assert from 'node:assert/strict'
import { instructionChecks } from './lib/pipeline.mjs'

const quote = '你连第一页都没看完'
const instruction = `新增一句「${quote}」作为对白。`
const added = instructionChecks(instruction, [{ at: 1, del: [], add: [quote] }], quote)
assert.equal(added[0].state, 'both')
assert.match(added[0].text, /可找到/)
assert.doesNotMatch(added[0].text, /不像已经改掉/)
const missing = instructionChecks(instruction, [], '别的对白')
assert.match(missing[0].text, /未匹配|未找到/)
const removed = instructionChecks(`删除原句「${quote}」。`, [{ at: 1, del: [quote], add: [] }], '')
assert.equal(removed[0].state, 'gone')
const unchanged = instructionChecks(`不要新增「${quote}」这句对白。`, [], quote)
assert.match(unchanged[0].text, /不判定新增或删除|待人工验收/)
assert.doesNotMatch(unchanged[0].text, /要求新增/)
console.log('instruction insertion: 4 scenarios passed')

// test-thinking-style.mjs —— 零成本行为测试（假模型 + 临时沙箱，跑完删干净）
// ① 逻辑自检关思考：chat({thinking:false}) 对 deepseek 模型发 thinking:{type:'disabled'}；接口回 400 时去掉参数重发；默认调用不带该参数
// ② 自定义风格的评审提示词里要出现作者原话，而不是只有「自定义风格」
// 用法：node test-thinking-style.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-think-'))
const bodies = []
let reject400 = false
const fake = http.createServer(async (req, res) => {
  let s = ''; for await (const c of req) s += c
  const b = JSON.parse(s); bodies.push(b)
  if (reject400 && b.thinking) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"unknown parameter: thinking"}}') }
  const u = b.messages.at(-1).content
  const out = /总分|打分|评分/.test(b.messages[0]?.content + u) ? '{"total":70,"scores":{}}' : '无'
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: out } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const agent = { name: '假模型', baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'deepseek-fake', apiKey: 'x', priceIn: 1, priceOut: 1 }
fs.writeFileSync(path.join(SB, 'agents.json'), JSON.stringify({ agents: { cheap: agent, writer: agent, pro: agent, gpt: agent }, assign: {} }))
process.env.WORKSHOP_SANDBOX = SB
const { chat } = await import('./lib/llm.mjs')
const ST = await import('./lib/styles.mjs')
const J = await import('./lib/judge.mjs')

let pass = 0, fail = 0
const t = async (name, fn) => { try { await fn(); pass++; console.log('✓', name) } catch (e) { fail++; console.log('✗', name, '—', e.message) } }

try {
  await t('thinking:false → 请求体带 thinking:{type:disabled}', async () => {
    bodies.length = 0
    await chat({ task: 'fix', user: 'x', thinking: false, tag: 't' })
    assert.deepEqual(bodies[0].thinking, { type: 'disabled' })
  })
  await t('默认调用不带 thinking 参数（写正文等不受影响）', async () => {
    bodies.length = 0
    await chat({ task: 'fix', user: 'x', tag: 't' })
    assert.equal(bodies[0].thinking, undefined)
  })
  await t('接口不认 thinking（400）→ 去掉参数重发一次并成功', async () => {
    bodies.length = 0; reject400 = true
    const r = await chat({ task: 'fix', user: 'x', thinking: false, tag: 't' })
    reject400 = false
    assert.equal(bodies.length, 2); assert.ok(bodies[0].thinking); assert.equal(bodies[1].thinking, undefined)
    assert.equal(r.content, '无')
  })
  await t('pipeline 的逻辑自检调用写了 thinking:false', () => {
    const src = fs.readFileSync(new URL('./lib/pipeline.mjs', import.meta.url), 'utf8')
    assert.ok(/task: 'fix'[^\n]*thinking: false/.test(src))
  })
  await t('自定义风格：label 带作者原话，评审系统提示里能看到', async () => {
    const st = ST.styleOfBook({ genre: 'custom', styleCustom: '八零年代东北小镇，糙汉与知青的慢热日常' })
    assert.equal(st.id, 'custom')
    assert.ok(st.label.includes('八零年代东北小镇'), st.label)
    assert.ok(J.judgeSystem(st.label).includes('八零年代东北小镇'))
    bodies.length = 0
    try { await J.rubricJudge('第1章 测试\n\n正文。', { chapterNo: 1, styleLabel: st.label }) } catch { /* 假模型返回不完整也没关系，只看发出去的提示词 */ }
    assert.ok(bodies.length >= 1 && bodies[0].messages[0].content.includes('八零年代东北小镇'), '评审请求的 system 里没有作者原话')
  })
  await t('内置风格 label 不变（豪门总裁 / 都市脑洞）', () => {
    assert.equal(ST.resolveStyle('豪门总裁').label, '豪门总裁')
    assert.equal(ST.resolveStyle('urban-naodong').label, '都市脑洞')
  })
} finally {
  fake.close(); fs.rmSync(SB, { recursive: true, force: true })
}
console.log(fail ? `\n${fail} 项失败 / ${pass} 通过` : `\n关思考 + 自定义风格评审全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)

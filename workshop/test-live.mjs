// test-live.mjs —— 流式 + 卡死切换 + 开书实时看板的零成本测试（本机假模型服务，不调真实 API）
// 用法：node test-live.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 首包/间隔超时压到 1.5 秒，测试才跑得快
Object.assign(process.env, { WORKSHOP_STREAM_FIRST_MS: '1500', WORKSHOP_STREAM_IDLE_MS: '1500', WORKSHOP_STREAM_TOTAL_MS: '20000' })

const BIBLE = '# 《测试书》全书设定集\n## 核心设定\n### 金手指：外卖签收系统\n**一句话规则**：送完最后一单就能签到拿修为。\n## 主角\n**陈野，24 岁，骑手。**\n## 主要配角（2 人）\n**1. 苏晚，22 岁，护士。**\n**2. 王大雷，38 岁，站长。**\n## 反派\n萧战，自称战神。\n'
const OUTLINE = Array.from({ length: 10 }, (_, i) => `${i + 1}|第${i + 1}章标题|目标描述内容|阻碍描述内容|结果描述内容|钩子类型|决定|章末钩子描述文字`).join('\n')
const hits = []
// mode: sse = 正常流式；hang = 回了响应头但一个字不吐；hanghead = 连响应头都不回；idle = 吐两句后卡住；json = 无视 stream 回整段 JSON
function fake(port, mode) {
  return new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
        const j = JSON.parse(b || '{}')
        hits.push({ port, mode, model: j.model, stream: !!j.stream })
        // 设定集调用 max_tokens=7000、章纲 12000；测试里直接调 chat 时用 user 标记区分
        const u = String(j.messages?.at(-1)?.content || '')
        const text = u.includes('BIBLE_PROBE') || j.max_tokens === 7000 ? BIBLE : OUTLINE
        if (mode === 'hanghead') { req.socket.on('close', () => {}); return } // 不回任何东西
        if (mode === 'json' || !j.stream) { rsp.writeHead(200, { 'content-type': 'application/json' }); return rsp.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 200 } })) }
        rsp.writeHead(200, { 'content-type': 'text/event-stream' })
        if (mode === 'hang') return
        const send = (o) => rsp.write('data: ' + JSON.stringify(o) + '\n\n')
        send({ choices: [{ delta: { reasoning_content: '先想想金手指的代价。代价要狠，读者才信。' } }] })
        if (mode === 'idle') { send({ choices: [{ delta: { content: '# 半截' } }] }); return }
        const parts = text.match(/[\s\S]{1,40}/g)
        for (const p of parts) { send({ choices: [{ delta: { content: p } }] }); await sleep(5) }
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 300 } })
        rsp.write('data: [DONE]\n\n'); rsp.end()
      })
    }).listen(port, '127.0.0.1', () => res(s))
  })
}
const servers = await Promise.all([fake(4721, 'sse'), fake(4722, 'hang'), fake(4723, 'hanghead'), fake(4724, 'idle'), fake(4725, 'json')])

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'))
const m = (port, name) => ({ model: name, baseUrl: `http://127.0.0.1:${port}/v1`, keyEnv: 'TK', priceIn: 1, priceOut: 2 })
const cfg = {
  models: { good: m(4721, 'good-model'), hang: m(4722, 'hang-model'), hanghead: m(4723, 'hanghead-model'), idle: m(4724, 'idle-model'), json: m(4725, 'json-model') },
  tiers: {
    master: { label: '大师档', enabled: true, use: 'good', tasks: { bible: 'hang', outline: 'good', write1: 'hanghead', revise: 'idle', plan: 'json' } },
  },
}
fs.writeFileSync(path.join(tmp, 'cfg.json'), JSON.stringify(cfg))
Object.assign(process.env, { WORKSHOP_MODE: 'customer', WORKSHOP_ADMIN_CONFIG: path.join(tmp, 'cfg.json'), WORKSHOP_SANDBOX: tmp, WORKSHOP_BUDGET: '3', TK: 'sk-test-fixture-xxxx', WORKSHOP_TIER: 'master' })

const { chat } = await import('./lib/llm.mjs')
const LV = await import('./lib/live.mjs')

// ── 1. 纯函数 ──
ok(LV.thoughtOf('我先读一下用户要求。金手指每用一次要付出什么代价？再想想反派') === '金手指每用一次要付出什么代价？', '思维摘要：跳过幕后话、丢掉没写完的半句', LV.thoughtOf('我先读一下用户要求。金手指每用一次要付出什么代价？再想想反派'))
ok(LV.thoughtOf('按照系统提示词输出格式。') === '', '思维摘要：全是幕后话时返回空')
const card = LV.bibleCard(BIBLE)
ok(card.cheat === '外卖签收系统' && card.hero === '陈野' && card.cast?.join() === '苏晚,王大雷' && card.villain === '萧战', '设定卡片：金手指/主角/配角/反派都抠出来', JSON.stringify(card))
ok(LV.outlineDone(OUTLINE + '\n11|半截').length === 10, '章纲：只认字段齐全的行（截断的半行不算）')
// 2026-10-03 真实 e2e 里漏出过的摘要句：幕后话与碎片都要挡掉
for (const s of ['注意：书名《外卖签到成神》，主角陈野，24岁。', '相邻不重复即可。', '这些要具体写出来。', '如果内容太长可以，手机阅读？', '用户要的是把开书方案扩写成可执行的全书设定集。', '10 信息遮断\n', '3《必送单，必被骂》7字\n', '- SS级：需要特殊条件触发（城市最高点）\n', '被动），人没事，全场破防。'])
  ok(LV.thoughtOf(s) === '', '摘要挡掉：' + s.trim().slice(0, 16), JSON.stringify(LV.thoughtOf(s)))
ok(LV.thoughtOf('或者第2章主动的是"爆发力量"——把车从人身上抬起来一角。') !== '', '正常的构思句照样显示')
// 真实设定集的三种写法（线上书库格式，取样 2026-10-03）
const real = [
  ['金手指：任意一份他有权打印的银行流水，盯着看3秒。\n# 《一查流水》全书设定集\n## 二、主角\n**陈默，32岁，农商行信贷审核员。**\n## 三、主要配角（6人）\n**1. 苏晚，34岁，陈默妻子**\n**2. 赵小满，24岁，柜员**\n## 四、反派与阻力（前30章）\n| 谁 | 想要什么 |\n', { cheat: '任意一份他有权打印的银行流水', hero: '陈默' }],
  ['# 《合法催收》全书设定集\n## 一、核心设定：讨债系统\n**系统全称**：合法债权执行辅助系统\n## 二、主角\n周正，28岁，外包催收专员。\n', { cheat: '讨债系统', hero: '周正' }],
  ['## 一、核心设定\n### 金手指：天罚契约\n1. 双方必须知情\n## 三、主要配角（4–6人）\n**1. 老周（周建国）**\n**2. 林薇**\n', { cheat: '天罚契约', cast: '老周' }],
]
for (const [t, want] of real) {
  const c = LV.bibleCard(t)
  ok(Object.entries(want).every(([k, v]) => k === 'cast' ? (c.cast || []).includes(v) : String(c[k] || '').startsWith(v)), '真实设定集格式：' + Object.values(want).join('/'), JSON.stringify({ cheat: c.cheat, hero: c.hero, cast: c.cast, villain: c.villain }))
}
ok(!LV.bibleCard(real[0][0]).villain, '反派表头「谁 | 想要什么」不会被当成人名')
ok(LV.bibleCard('## 四、反派与阻力（前30章）\n1. 马哥，催收公司小头目\n').villain === '马哥', '反派列表行去掉编号取名（真实 e2e 曾显示成「1.」）', String(LV.bibleCard('## 四、反派与阻力（前30章）\n1. 马哥，催收公司小头目\n').villain))
// 进度条在「先思考很久」时也会走（真实 e2e：前 40 秒只有思考，旧算法一直停在 5%）
{ let T = 0; const tr = LV.makeTracker(() => {}, { intervalMs: 0, now: () => T }); tr.phase('bible'); tr.feed({ reasoning: '想'.repeat(4000) }); ok(tr.live.pct > 20, '只有思考流时进度条也往前走', String(tr.live.pct)) }

// ── 2. 流式正常 ──
const deltas = []
hits.length = 0
const r1 = await chat({ task: 'outline', user: 'x', onDelta: (d) => deltas.push(d) })
ok(hits.at(-1).stream === true, '传了 onDelta 就走流式请求')
ok(r1.content === OUTLINE && deltas.length > 3 && deltas.at(-1).content === OUTLINE, '流式拼接结果与原文一致，增量逐段回调', `deltas=${deltas.length}`)
ok(deltas.some((d) => d.reasoning.includes('代价要狠')), '思考流也回调给看板')
ok(Math.abs(r1.cost - (100 * 1 + 300 * 2) / 1e6) < 1e-9, '用流末尾的 usage 计费', String(r1.cost))

// ── 3. 不传 onDelta：完全旧行为（非流式） ──
hits.length = 0
const r0 = await chat({ task: 'outline', user: 'x' })
ok(hits.at(-1).stream === false && r0.content === OUTLINE, '不传 onDelta：仍是非流式，结果不变')

// ── 4. 卡死 → 快速退回基础模型 ──
for (const [task, why] of [['bible', '回了响应头但不吐字'], ['write1', '连响应头都不回'], ['revise', '吐了半句后卡住']]) {
  hits.length = 0; const sw = []; const t0 = Date.now()
  const r = await chat({ task, user: 'BIBLE_PROBE', onDelta: (d) => sw.push(d) })
  const s = (Date.now() - t0) / 1000
  ok(r.content === BIBLE && hits.length === 2 && hits.at(-1).model === 'good-model', `${why} → 一次就换到基础模型，不在卡住的线上重试 3 次`, hits.map((h) => h.model).join('→') + ` ${s.toFixed(1)}s`)
  ok(s < 6, `${why}：等待 ${s.toFixed(1)} 秒（首包超时 1.5 秒）`)
  ok(sw.some((d) => d.switched), `${why}：看板收到「已切换备用线路」`)
}
const logs = fs.readFileSync(path.join(tmp, 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
ok(logs.some((l) => l.model === 'idle-model' && l.ok === false && l.est && l.out > 0), '中途卡住：已生成的字数照样估算记账', JSON.stringify(logs.find((l) => l.model === 'idle-model')))
ok(logs.filter((l) => l.ok === false).every((l) => /线路卡住/.test(l.err)), '卡死报错写明原因（不是笼统的连不上）')

// ── 5. 网关无视 stream 回整段 JSON ──
const dj = []
const r5 = await chat({ task: 'plan', user: 'BIBLE_PROBE', onDelta: (d) => dj.push(d) })
ok(r5.content === BIBLE && dj.length === 1, '网关不支持流式（回 JSON）：照常解析，看板一次拿到全文')

// ── 6. 开书全流程：startBook + 看板 ──
cfg.tiers.master.tasks.bible = 'good'; fs.writeFileSync(path.join(tmp, 'cfg.json'), JSON.stringify(cfg))
fs.mkdirSync(path.join(tmp, 'novels'), { recursive: true })
const PL = await import('./lib/pipeline.mjs')
const lives = []
const book = await PL.startBook('书名：《测试书》\n风格：吐槽流\n一句话：测试', '测试', undefined, { onLive: (l) => lives.push(l) })
ok(book && book.stage === 'writing', '开书完成，书进入写作阶段')
ok(lives[0]?.card?.title === '测试书', '看板第一帧就有书名')
ok(lives.some((l) => l.step === 'bible') && lives.some((l) => l.step === 'outline') && lives.at(-1).step === 'done' && lives.at(-1).pct === 100, '步骤依次经过 搭世界观 → 排章纲 → 完成', lives.map((l) => l.step).filter((v, i, a) => a[i - 1] !== v).join('→'))
ok(lives.some((l) => l.card?.cheat === '外卖签收系统'), '设定集生成中，金手指卡片就出来了')
ok(lives.at(-1).chapters.length === 10, '章纲排完 10/10', String(lives.at(-1).chapters.length))
const pcts = lives.map((l) => l.pct); ok(pcts.every((p, i) => !i || p >= pcts[i - 1]), '百分比只增不减', pcts.join(','))
ok(lives.some((l) => l.think), '思维摘要有内容', (lives.find((l) => l.think) || {}).think)
ok(!JSON.stringify(lives).match(/good-model|127\.0\.0\.1/), '看板数据里没有模型名和地址')

for (const s of servers) { s.closeAllConnections?.(); s.close() }
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

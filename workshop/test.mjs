// test.mjs —— 零成本回归测试：node workshop/test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyPatches, dedupeParas, tidy } from './lib/pipeline.mjs'
import { findAnnot, stripAnnot } from './lib/annot.mjs'
import * as Store from './lib/store.mjs'
import { computeMetrics, bandScore } from './lib/metrics.mjs'
import { parseRubric } from './lib/judge.mjs'

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('✓', name) }

t('补丁：忽略引号与空白定位并替换', () => {
  const fix = { patches: [{ from: '刀停在三尺外', to: '刀停在两毫米外' }] }
  assert.equal(applyPatches('他看见\n刀停在三尺外。', fix), '他看见\n刀停在两毫米外。'); assert.equal(fix.applied, 1)
})
t('补丁：（留空）删除整段且删最后一次出现', () => {
  const fix = { patches: [{ from: '说：“行吧，你先放放刀。”', to: '（留空）' }] }
  const out = applyPatches('A\n说：“行吧，你先放放刀。”\nB\n说：“行吧，你先放放刀。”\n', fix)
  assert.equal(out, 'A\n说：“行吧，你先放放刀。”\nB\n'); assert.equal(fix.applied, 1)
})
t('补丁：改前改后相同的补丁跳过、不计入 applied', () => {
  const fix = { patches: [{ from: '声控灯又亮了一层。', to: '声控灯又亮了一层。' }] }
  assert.equal(applyPatches('A\n声控灯又亮了一层。\n', fix), 'A\n声控灯又亮了一层。\n'); assert.equal(fix.applied, 0)
})
t('补丁：同一件事的两种说法都被标删除时，至少保留一处（2026-10-02 豪门总裁实测）', () => {
  const p1 = '五年前那个夜晚，她十七岁，冲进火里拖出一个人。手腕烧掉一块皮，脸被烟熏得睁不开眼，在酒店走廊里缠了一周的纱布。'
  const p2 = '五年前12月24日，火场，她冲进去拖出来一个人。手腕被烧穿一块皮，脸被烟熏得睁不开，缠了整整一周纱布。'
  const fix = { patches: [{ from: p1, to: '（留空）' }, { from: p2, to: '（留空）' }] }
  const out = applyPatches(`开头。\n${p1}\n中间。\n${p2}\n结尾。`, fix)
  assert.ok(out.includes('火'), '火场背景被全部删光了')
  assert.equal(fix.applied, 1); assert.equal(fix.kept, 1)
})
t('补丁：两段不相关的句子都标删除时照删', () => {
  const fix = { patches: [{ from: '他站在楼道口数了数兜里的钱。', to: '（留空）' }, { from: '八点整，门外什么动静都没有。', to: '（留空）' }] }
  const out = applyPatches('A\n他站在楼道口数了数兜里的钱。\nB\n八点整，门外什么动静都没有。\nC', fix)
  assert.equal(out, 'A\nB\nC'); assert.equal(fix.applied, 2)
})
t('补丁：「改为：原句（无问题，保留）」不把批注写进正文（2026-10-07 事故）', () => {
  const src = '我掏出小本子翻到最后一页，写：陈老师 500。\n楼梯间的窗户开着。'
  const fix = { patches: [
    { from: '我掏出小本子翻到最后一页，写：陈老师 500。', to: '我掏出小本子翻到最后一页，写：陈老师 500。（无问题，保留）' },
    { from: '楼梯间的窗户开着。', to: '（注：此处与前文一致，无矛盾，保留）' },
  ] }
  const out = applyPatches(src, fix)
  assert.equal(out, src); assert.equal(fix.applied, 0); assert.equal(fix.annot, 2)
})
t('补丁：真修改后面拖了批注时只保留修改', () => {
  const fix = { patches: [{ from: '刀停在三尺外', to: '刀停在两毫米外（已修正，与前文一致）' }] }
  assert.equal(applyPatches('他看见\n刀停在三尺外。', fix), '他看见\n刀停在两毫米外。')
})
t('批注检测：只认审稿口吻，不误伤正文括号', () => {
  assert.equal(findAnnot('他说（小声）：“走。”\n（未完待续）\n她笑了（笑得很假）。').length, 0)
  assert.equal(findAnnot('一句。（无问题，保留）\n二句。（无问题）\n三句（注：数值需核对）\n四句（无矛盾，保留）').length, 4)
  assert.equal(stripAnnot('一句。（无问题，保留）\n他说（小声）。'), '一句。\n他说（小声）。')
})
t('补丁：找不到原句时不改动', () => {
  const fix = { patches: [{ from: '不存在的一句话', to: 'x' }] }
  assert.equal(applyPatches('正文', fix), '正文'); assert.equal(fix.applied, 0)
})
t('去重：逐字重复长段落只保留第一次', () => {
  assert.deepEqual(dedupeParas(['这是一段超过十二个字的重复内容啊', '中间', '这是一段超过十二个字的重复内容啊', '好']), ['这是一段超过十二个字的重复内容啊', '中间', '好'])
})
t('格式：半角标点转全角、段间空行', () => {
  const out = tidy('他说,"走吧!"\n好?')
  assert.ok(!/[,"]/.test(out)); assert.ok(out.includes('\n\n'))
})
t('指标：识别无空行与重复段落', () => {
  const body = Array.from({ length: 10 }, (_, i) => `这是第${i}段内容，写得很普通的一句话。`).join('\n') + '\n这是第1段内容，写得很普通的一句话。'
  const m = computeMetrics(body)
  assert.equal(m.noBlankLine, 1); assert.equal(m.dupParas, 1)
  const bs = bandScore(m, {}); assert.ok(bs.hard.length >= 2)
})
t('评审解析：行格式', () => {
  const s = 'hook_open=8|好\nconflict=7|x\npayoff=6|x\nnovelty=7|x\nprotagonist=7|x\ndensity=6|x\ndialogue=7|x\nhumor=6|x\nlogic=8|x\ncliff=7|x\nread_next=60|x\nbest=开头\nworst=中段\nfix1=a'
  const r = parseRubric(s); assert.equal(r.readNext, 60); assert.equal(Object.keys(r.scores).length, 10); assert.equal(r.total, Math.round(6.9 * 7 + 18))
})
// ── v1.1：agent 配置层 / 报错可读性 / 包装 / 润色开关 ──
const { explainError } = await import('./lib/llm.mjs')
const { loadConfig, TASKS, publicConfig } = await import('./lib/agents.mjs')
const { POLISH_MODES } = await import('./lib/polish.mjs')
const { hitSamples } = await import('./lib/packaging.mjs')
const { settings } = await import('./lib/pipeline.mjs')
t('402 报错带 agent 名、模型、地址和处理建议', () => {
  const m = explainError(402, '{"error":{"message":"Insufficient Balance"}}', { name: '助理 · DeepSeek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' })
  assert.ok(m.includes('「助理 · DeepSeek」') && m.includes('deepseek-flash') && m.includes('https://api.deepseek.com') && m.includes('余额不足') && m.includes('Insufficient Balance'))
})
t('每个任务都分配到一个存在的 agent', () => {
  const c = loadConfig(); for (const x of TASKS) assert.ok(c.agents[c.assign[x.id]], x.id)
  assert.ok(TASKS.some((x) => x.id === 'package') && TASKS.some((x) => x.id === 'rubric'))
  assert.ok(c.engineer && c.agents[c.engineer], '工程师模型必须指向已配置 agent')
})
t('界面配置不泄露完整密钥', () => {
  const s = JSON.stringify(publicConfig())
  for (const a of Object.values(loadConfig().agents)) if (a.apiKey) assert.ok(!s.includes(a.apiKey))
  assert.ok(!/"apiKey"/.test(s))
})
t('人工润色器默认关闭', () => {
  assert.equal(POLISH_MODES.off, '关闭'); assert.ok(POLISH_MODES.rules && POLISH_MODES.llm)
})
t('包装 agent 能读到爆款库样本（未提供样本库时安全退化）', () => {
  const h = hitSamples('urban-naodong', 5)
  assert.ok(Array.isArray(h), 'hitSamples 必须返回数组')
  if (h.length) assert.ok(h[0].title, '样本缺少标题')
  else console.log('      · 未提供爆款库（data/knowledge/rank），跳过内容断言')
})
t('设置有润色开关字段', () => { const s = settings(); assert.ok('polish' in s && 'autoPolish' in s) })
// ── v1.2：改写建议必须和指标一致（模拟用户实测发现的三个反例） ──
const { revisionAdvice } = await import('./lib/pipeline.mjs')
t('建议：分数降、追读降、成对说改后好 → 矛盾，不写建议采用', () => {
  assert.equal(revisionAdvice({ dTotal: -1, dRead: -12, pairWinner: 1, noise: 8 }).level, 'mixed')
})
t('建议：分数涨 9、追读涨 21、成对说改前好 → 矛盾', () => {
  assert.equal(revisionAdvice({ dTotal: 9, dRead: 21, pairWinner: 0, noise: 8 }).level, 'mixed')
})
t('建议：分数一致上升、成对也说改后好 → 建议采用；全在误差内且成对平局 → 看喜好', () => {
  assert.equal(revisionAdvice({ dTotal: 12, dRead: 20, pairWinner: 1, noise: 8 }).level, 'better')
  assert.equal(revisionAdvice({ dTotal: 2, dRead: -3, pairWinner: -1, noise: 8 }).level, 'same')
  assert.equal(revisionAdvice({ dTotal: -10, dRead: -20, pairWinner: 0, noise: 8 }).level, 'worse')
})
t('分差恰好等于误差不算「超过」（Q024：-8 与 ±8）', () => {
  assert.equal(revisionAdvice({ dTotal: -8, dRead: 0, pairWinner: 1, noise: 8 }).level, 'mixed')
  assert.equal(revisionAdvice({ dTotal: -9, dRead: 0, pairWinner: -1, noise: 8 }).level, 'worse')
})
const { instructionChecks } = await import('./lib/pipeline.mjs')
t('改写意见里用引号标出的原句能对上删改（Q022）', () => {
  const ins = '删掉章末「绿萝」这句\n把弹窗挪走'
  const changes = [{ at: 3, del: ['窗台那盆绿萝垂下来。'], add: ['窗外只剩雨。'] }]
  const rows = instructionChecks(ins, changes, '第3章 x\n\n窗外只剩雨。\n')
  assert.equal(rows.length, 2)
  assert.ok(rows[1].text.includes('待人工验收'))
  assert.equal(rows[0].state, 'gone')
  assert.equal(instructionChecks(ins, [], '正文里绿萝还在').filter((x) => x.state === 'still').length, 1)
  assert.equal(instructionChecks('删掉『我不干了』这句', [{ at: 1, del: ['我不干了。'], add: [] }], '下一句。')[0].state, 'gone')
  assert.equal(instructionChecks('删掉“房东第三个电话”', [], '房东第三个电话还在')[0].state, 'still')
})
const { splitTitle } = await import('./lib/pipeline.mjs')
t('章名：正文里原样出现的系统提示句不能当章名（第1章真实事故）', () => {
  assert.equal(splitTitle('第1章 建议以非对抗方式推进收容进程\n正文一段\n【提示：建议以非对抗方式推进收容进程。】', 1).title, '')
  assert.equal(splitTitle('第2章 主动投案\n他走进派出所。', 2).title, '主动投案')
})
t('写手自述：章名前的「我看了修改要求…主要改动」与重复章名被去掉（模拟作者发现的事故）', () => {
  const raw = '我看了修改要求和原稿，现在开始按要求改写第1章。\n主要改动：\n1. 开篇加代价\n2. 中段动作化\n\n第1章 刀在颈侧\n\n第1章 刀在颈侧\n\n追出八百米，膝盖先撞上了水泥地。\n\n他喘了口气。\n\n改动说明：以上删去了中段推理。'
  const r = splitTitle(raw, 1)
  assert.equal(r.title, '刀在颈侧')
  assert.ok(r.body.startsWith('追出八百米'), r.body.slice(0, 30))
  assert.ok(!/改动|修改要求|刀在颈侧/.test(r.body), r.body)
  assert.ok(computeMetrics('第1章 x\n\n我看了修改要求，开始改写。\n\n正文').writerNotes >= 1)
  assert.equal(computeMetrics('第1章 x\n\n他说：“按要求办。”\n\n正文').writerNotes, 0) // 对白里的「按要求」不算
})

// ── 多创作风格（styles.mjs）：默认 8 个 featured，拖入风格卡自动扩展 ──
const ST = await import('./lib/styles.mjs')
const PR = await import('./lib/prompts.mjs')
const { judgeSystem } = await import('./lib/judge.mjs')

t('风格：默认 8 个 featured 且顺序正确，id 不重复', () => {
  assert.ok(ST.STYLES.length >= 8, '至少要有 8 个 featured 风格，实际 ' + ST.STYLES.length)
  const feats = ST.STYLES.filter((s) => s.featured).map((s) => s.id)
  assert.deepEqual(feats, ['urban-naodong', '都市高武', '玄幻脑洞', '悬疑灵异', '豪门总裁', '现言脑洞', '古言脑洞', '科幻末世'])
  assert.deepEqual(ST.STYLES.slice(0, 8).map((s) => s.id), feats, 'featured 必须排在最前')
  assert.equal(new Set(ST.STYLES.map((s) => s.id)).size, ST.STYLES.length, 'id 不能重复')
  for (const s of ST.STYLES) assert.ok(s.label && s.tagline && [...s.tagline].length <= 16 && (s.audience === 'male' || s.audience === 'female'), s.id)
  assert.deepEqual(ST.STYLES[0].rankCats, ['都市脑洞', '都市日常', '都市高武'])
  assert.equal(ST.publicStyles().length, ST.STYLES.length)
})
t('风格：每个非都市脑洞风格都能取到规则，且不含「证据摘要」', () => {
  for (const s of ST.STYLES) {
    const rules = ST.styleRules(ST.resolveStyle(s.id))
    assert.ok(rules.length > 100, s.id + ' 规则为空')
    assert.ok(!rules.includes('证据摘要'), s.id + ' 没去掉证据摘要')
    assert.ok(!/^---/.test(rules), s.id + ' frontmatter 没去掉')
  }
})
t('风格：自定义风格把作者原话写进规则', () => {
  const rules = ST.styleRules(ST.resolveStyle({ id: 'custom', custom: '重生复仇' }))
  assert.ok(rules.includes('重生复仇') && rules.includes('作者指定风格'), rules.slice(0, 60))
})
t('风格：空/未知一律回退都市脑洞；custom 为空也回退', () => {
  assert.equal(ST.resolveStyle(undefined).id, 'urban-naodong')
  assert.equal(ST.resolveStyle('').id, 'urban-naodong')
  assert.equal(ST.resolveStyle({ id: '不存在' }).id, 'urban-naodong')
  assert.equal(ST.resolveStyle({ id: 'custom', custom: '   ' }).id, 'urban-naodong')
  assert.equal(ST.resolveStyle({ id: 'custom', custom: '啊'.repeat(300) }).custom.length, 200, 'custom 要截断到 200 字')
  assert.equal(ST.styleOfBook({ genre: 'urban-naodong' }).id, 'urban-naodong', '老书必须还是都市脑洞')
  assert.equal(ST.styleOfBook({ genre: '豪门总裁' }).label, '豪门总裁')
})
t('风格：都市脑洞的规则与 projects/genres 下的规则文件逐字相同', () => {
  const raw = fs.readFileSync(new URL('../projects/genres/urban-naodong.md', import.meta.url), 'utf8')
  assert.equal(ST.styleRules(ST.resolveStyle('urban-naodong')), raw.replace(/^---[\s\S]*?---\s*/, '').trim())
})
t('提示词：architectSystem 默认即 SYS_ARCHITECT，换风格换频道话术', () => {
  assert.equal(PR.architectSystem('都市脑洞'), PR.SYS_ARCHITECT)
  assert.equal(PR.architectSystem(), PR.SYS_ARCHITECT)
  assert.ok(PR.SYS_ARCHITECT.includes('主编') && PR.SYS_ARCHITECT.includes('都市脑洞'), '主编提示词应锁定频道')
  assert.ok(PR.architectSystem('豪门总裁').includes('「豪门总裁」') && PR.architectSystem('豪门总裁').includes('要情绪、要冲突、要兑现'))
})
t('提示词：conceptPrompt 同输入稳定，都市脑洞与不指定风格等价', () => {
  assert.equal(PR.conceptPrompt('x', ['a']), PR.conceptPrompt('x', ['a']))
  assert.equal(PR.conceptPrompt('x', ['a'], ST.resolveStyle('urban-naodong')), PR.conceptPrompt('x', ['a']))
  assert.ok(PR.conceptPrompt('开一家末日便利店', []).includes('开一家末日便利店'))
  assert.ok(PR.conceptPrompt('x', ['榜一书']).includes('榜一书'))
})
t('提示词：conceptPrompt 其他风格走通用版（去都市脑洞专属话术）', () => {
  const s = PR.conceptPrompt('', [], ST.resolveStyle('豪门总裁'))
  assert.ok(!s.includes('都市脑洞')); assert.ok(!s.includes('脑洞公式')); assert.ok(!s.includes('一句话脑洞'))
  assert.ok(s.includes('一句话卖点') && s.includes('核心设定') && s.includes('核心冲突'))
  assert.ok(!PR.conceptPrompt('', [], ST.resolveStyle('豪门总裁')).includes('榜单书名'), '没有榜单标题时不该留一段空榜单')
  assert.ok(PR.conceptPrompt('x', ['榜一书'], ST.resolveStyle('豪门总裁')).includes('当前番茄「豪门总裁」榜单书名'))
  assert.ok(PR.conceptPrompt('', [], ST.resolveStyle({ id: 'custom', custom: '重生复仇' })).includes('作者指定的风格：重生复仇'))
})
t('提示词：writerSystem 默认风格即都市脑洞，其他风格换频道名与指标标题', () => {
  assert.equal(PR.writerSystem('GT'), PR.writerSystem('GT', '都市脑洞'))
  assert.ok(PR.writerSystem('GT').includes('签约大神作者'), '正文提示词要有写手人设')
  assert.ok(PR.writerSystem('GT').includes('GT'), '题材文本要进提示词')
  assert.ok(PR.writerSystem('GT').includes('输出格式'), '正文提示词要有硬性输出格式')
  const w = PR.writerSystem('GT', '豪门总裁')
  assert.equal(w.split('\n')[0], '你是番茄小说「豪门总裁」频道的签约大神作者，你的书常年在读榜前十。你写的是给手机读者看的网文，不是文学作品。')
  assert.ok(w.includes('## 文体参考指标（网文通用；与上面风格要求冲突时以风格要求为准）'))
  assert.ok(!w.includes('本地 39 本番茄都市脑洞爆款第一章'))
})
t('评审：judgeSystem 默认风格即都市脑洞，其他风格换频道并加口径说明', () => {
  assert.equal(judgeSystem('都市脑洞'), judgeSystem())
  assert.ok(judgeSystem('都市脑洞').includes('资深签约编辑'), '评审提示词要有人设')
  const j = judgeSystem('悬疑灵异')
  assert.ok(j.includes('「悬疑灵异」频道'))
  assert.ok(j.includes('按「悬疑灵异」读者的期待打分'))
})
t('评审：rubricJudge/pairJudge 接受 styleLabel 不报错（不真调模型）', () => {
  assert.equal(typeof import('./lib/judge.mjs').then, 'function')
  const src = fs.readFileSync(new URL('./lib/judge.mjs', import.meta.url), 'utf8')
  assert.ok(/rubricJudge\(text, opts = \{\}\)[\s\S]{0,120}styleLabel/.test(src), 'rubricJudge 要解构 styleLabel')
  assert.ok(/pairJudge\(a, b, \{ context = '', sameBook = true, styleLabel = '都市脑洞' \} = \{\}\)/.test(src), 'pairJudge 要接受 styleLabel')
  assert.ok(!/pairJudge\([\s\S]{0,400}?system: SYS/.test(src), 'judge.mjs 里不应再有直接用 SYS 的调用')
})
t('情绪浓度：默认「稳」时写作 prompt 逐字不变；燃/炸注入要求；非法值当稳', () => {
  const base = { bible: 'b', characterCard: null, plan: 'p', recap: '', prevTail: '', chapterNo: 1, outlineRow: '1|x', anchors: [] }
  const old = PR.writerPrompt(base)
  assert.equal(PR.writerPrompt({ ...base, heatText: PR.heatBlock('calm', 1) }), old)
  assert.equal(PR.heatBlock(undefined, 1), '')
  assert.equal(PR.heatBlock('xx', 1), '')
  const hot = PR.writerPrompt({ ...base, heatText: PR.heatBlock('hot', 1) })
  assert.ok(hot.includes('【情绪浓度：燃】') && hot.includes('这是第一章'))
  assert.ok(!PR.heatBlock('hot', 3).includes('这是第一章'))
  assert.ok(PR.heatBlock('blast', 2).includes('【情绪浓度：炸】'))
  const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes("'POST /api/book/heat'"), '要有保存情绪浓度的接口')
  assert.ok(!/MODEL_ROUTES = new Set\([^)]*book\/heat/.test(src), '切换情绪浓度不花钱，不应进 MODEL_ROUTES')
})

t('意见清单：结构要求、长引文、超过六条均保留', () => {
  const long = '原句'.repeat(40)
  const rows = instructionChecks(`章末停在证据出现时\n删掉「${long}」\n` + Array.from({length: 8}, (_, i) => `保留「台词${i}」`).join('\n'), [{del: [long], add: []}], '台词0')
  assert.equal(rows.length, 10)
  assert.ok(rows[0].text.includes('待人工验收'))
  assert.equal(rows[1].state, 'gone')
  assert.ok(rows[2].text.includes('仍可找到'))
  assert.ok(rows[3].text.includes('未找到'))
})
t('意见清单：新增和保留不误报未删旧句', () => {
  const rows = instructionChecks('新增「十七公里」；保留「旧台词」', [], '十七公里，旧台词')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.state !== 'still'))
})
t('意见清单：短词与完整新增句不互相矛盾，并给出位置', () => {
  const rows = instructionChecks('新增：在「591」旁边补一句「广东那个学校的代码是591。填这张表的人，本来应该是我。」', [], '她在草稿纸上写591。广东那个学校的代码是591。填这张表的人，本来应该是我。')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].state, 'both')
  assert.equal(rows[1].state, 'both')
  assert.ok(rows.every(r => /非空行/.test(r.text)))
})
t('任务完成提示跨页面保留', () => {
  const ui = fs.readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8')
  assert.ok(ui.includes('后台任务已结束；可回书页核对章节和字数'))
  assert.ok(!ui.includes('page === jobSeenPage) { b.className = \'busy\'; b.textContent = `✅'))
})
t('UI 完整意见、默认维度、封面异步和 API 版本一致', () => {
  const ui = fs.readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8')
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const ver = fs.readFileSync(new URL('./version.mjs', import.meta.url), 'utf8')
  assert.ok(!ui.includes('esc(v.instruction).slice'))
  assert.ok(ui.includes('<details open><summary>各项得分对比'))
  assert.ok(ui.includes('r.unchanged') && ui.includes('r.aiText'))
  assert.ok(server.includes('text.length > 2000'))
  assert.equal(ui.match(/UI_API_VERSION = (\d+)/)[1], ver.match(/API_VERSION = (\d+)/)[1])
})
t('模拟器稳定注册编号与输入读回防护', () => {
  const sim = fs.readFileSync(new URL('./user-sim.mjs', import.meta.url), 'utf8')
  assert.ok(sim.includes('window.__simRegistry'))
  assert.ok(sim.includes('matches.length === 1 ? matches[0] : null'))
  assert.ok(sim.includes("return 'TOOLONG:' + el.maxLength"))
  assert.ok(sim.includes("el.value === t ? 'OK' : 'MISMATCH'"))
  assert.ok(sim.includes('任务仍在运行：') && sim.includes('下一步继续 wait，不重复点击'))
  const registry = { next: 0, keys: new Map() }
  const assign = key => { if (!registry.keys.has(key)) registry.keys.set(key, registry.next++); return registry.keys.get(key) }
  const save = assign('id:btnPackSave'), view = assign('id:btnRevView')
  assign('id:addedButton')
  assert.equal(assign('id:btnRevView'), view)
  assert.equal(assign('id:btnPackSave'), save)
})
const { splitCoverTitle } = await import('./lib/cover.mjs')
t('封面断行不拆数字或英文连续串', () => {
  const lines = splitCoverTitle('我把同桌从312教到591')
  assert.equal(lines.join(''), '我把同桌从312教到591')
  assert.ok(lines.some(x => x.includes('312')) && lines.some(x => x.includes('591')))
  assert.deepEqual(splitCoverTitle('ABCDEFGHIJK12345'), ['ABCDEFGHIJK12345'])
})
t('保留引文容忍标点与换行差异，但不宣称语义落实', () => {
  const result = instructionChecks('保留「下单人名字：周建国。我爸。」', [], '下单人名字:周建国。\n我爸。')
  assert.ok(result[0].text.includes('仍可找到') && result[0].text.includes('核对上下文'))
})
t('删除重复引文不要求全部删除，报告减少处数与剩余位置', () => {
  const checks = instructionChecks('删掉第二次「牌照呢」', [{ del: ['牌照呢', '牌照呢'], add: ['牌照呢'] }], '牌照呢\n其他内容')
  assert.equal(checks[0].state, 'both')
  assert.ok(checks[0].text.includes('减少 1 处') && checks[0].text.includes('非空行 1'))
})
console.log(`\n${pass} 项全部通过`)

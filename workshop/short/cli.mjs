// short/cli.mjs —— 短篇模块命令行入口（界面接入前先用它跑通、做对照）
//   node workshop/short/cli.mjs channels
//   node workshop/short/cli.mjs new <渠道id> <题材> [灵感...]      一键：选题→构思→正文→闸门→编辑试读→投稿包
//   node workshop/short/cli.mjs gates <稿件id>                    只重跑机器闸门（0 成本）
//   node workshop/short/cli.mjs quality <id>                    重算质量报告（0 成本）
//   node workshop/short/cli.mjs polish <id> [rules|llm]          默认rules零成本；llm需显式选择
//   node workshop/short/cli.mjs list
import { CHANNELS, GENRES, createShort, gates, listShorts, resumeShort, shortDir, qualityReport, polishShort } from './pipeline.mjs'
import { refineShort } from './refine.mjs'
// node workshop/short/cli.mjs refine <id> [rounds=3] [budget=6]

const [cmd, a, b, ...rest] = process.argv.slice(2)
const step = (s) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`)

if (cmd === 'channels') {
  for (const [id, c] of Object.entries(CHANNELS)) console.log(`${id.padEnd(14)} ${c.name}｜${c.sweet.join('-')} 字｜${c.price}`)
  console.log('\n题材：' + GENRES.join('、'))
} else if (cmd === 'new') {
  const m = await createShort({ channelId: a, genre: b, idea: rest.join(' ') }, { onStep: step })
  console.log(`\n完成：${m.id}（${shortDir(m.id)}）`)
  console.log(`标题：${m.idea?.title}｜${m.gates?.chars} 字｜闸门 ${m.gates?.pass ? '通过' : '未通过'}｜编辑试读 ${m.editor?.slice(-1)[0]?.hookScore} 分「${m.editor?.slice(-1)[0]?.verdict}」｜花费 ¥${m.cost}（${m.calls} 次调用）`)
} else if (cmd === 'resume') {
  const m = await resumeShort(a, { onStep: step })
  console.log(`\n完成：${m.id}｜${m.gates?.chars} 字｜闸门 ${m.gates?.pass ? '通过' : '未通过'}｜编辑试读 ${m.editor?.slice(-1)[0]?.hookScore} 分「${m.editor?.slice(-1)[0]?.verdict}」｜累计 ¥${m.cost}（${m.calls} 次）`)
} else if (cmd === 'refine') {
  const r = await refineShort(a, { rounds: b === undefined ? 3 : Number(b), budget: rest[0] === undefined ? 6 : Number(rest[0]), onStep: step })
  console.log(JSON.stringify(r, null, 2))
} else if (cmd === 'quality') {
  console.log(JSON.stringify(qualityReport(a), null, 2))
} else if (cmd === 'polish') {
  console.log(JSON.stringify(await polishShort(a, { mode: b || 'rules', onStep: step }), null, 2))
} else if (cmd === 'gates') {
  console.log(JSON.stringify(gates(a), null, 2))
} else if (cmd === 'list') {
  for (const s of listShorts()) console.log(`${s.id} ${s.stage} ${s.idea?.title || ''} ¥${s.cost}`)
} else {
  console.log('用法见文件头')
}

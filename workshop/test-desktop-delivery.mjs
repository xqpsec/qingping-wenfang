import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deliverToDesktop } from './customer-lab.mjs'
import { deliverBook, protagonists } from './lib/delivery.mjs'

function makeBook(root, title, n) {
  const dir = path.join(root, title)
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ title, chapters: Array.from({ length: n }, (_, i) => ({ n: i + 1 })) }))
  for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, 'chapters', String(i).padStart(4, '0') + '.txt'), '正文' + i)
  return dir
}

test('one folder per book: more chapters replace, fewer chapters never replace, old versions are archived', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'))
  const out = path.join(tmp, '成果')
  try {
    const r1 = deliverToDesktop(makeBook(path.join(tmp, 's1'), '测试书', 3), out, {})
    assert.equal(path.basename(r1.directory), '测试书')
    const r2 = deliverToDesktop(makeBook(path.join(tmp, 's2'), '测试书', 5), out, {})
    assert.match(r2.note, /3 章 → 5 章/)
    assert.equal(fs.readdirSync(path.join(out, '测试书', '分章正文')).length, 5)
    const r3 = deliverToDesktop(makeBook(path.join(tmp, 's3'), '测试书', 2), out, {})
    assert.match(r3.note, /没有替换/)
    assert.equal(fs.readdirSync(path.join(out, '测试书', '分章正文')).length, 5)
    assert.equal(fs.readdirSync(path.join(out, '_旧版本')).length, 2)
    assert.deepEqual(fs.readdirSync(out).sort(), ['_旧版本', '测试书'])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('fill sheet follows the real Fanqie form: 15-char title, 500-char intro, 5-char hero names, pen name, cover', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-'))
  try {
    const src = makeBook(path.join(tmp, 's'), '测试书', 2)
    const bj = JSON.parse(fs.readFileSync(path.join(src, 'book.json'), 'utf8'))
    bj.package = { intro: '简介'.repeat(30), tags: ['系统', '都市'] }
    fs.writeFileSync(path.join(src, 'book.json'), JSON.stringify(bj))
    fs.writeFileSync(path.join(src, 'bible.md'), '书名：《测试书》\n主角：马小刚，26岁，外卖骑手。\n')
    const r = deliverBook(src, path.join(tmp, 'out'), { penName: '夜行灯' })
    const sheet = fs.readFileSync(path.join(r.directory, '番茄填写单.txt'), 'utf8')
    assert.match(sheet, /书本名称/); assert.match(sheet, /主角名1：马小刚/); assert.match(sheet, /笔名：夜行灯/)
    assert.match(sheet, /系统、都市/); assert.match(sheet, /当前 3\/15/); assert.match(sheet, /最终封面尚未生成/)
    assert.equal(fs.readFileSync(path.join(r.directory, '简介.txt'), 'utf8').trim(), '简介'.repeat(30))
    assert.deepEqual(protagonists(src), ['马小刚'])
    const long = makeBook(path.join(tmp, 'l'), '这是一个超过十五个字的非常非常长的书名', 1)
    const r2 = deliverBook(long, path.join(tmp, 'out2'), {})
    assert.match(fs.readFileSync(path.join(r2.directory, '番茄填写单.txt'), 'utf8'), /超过番茄 15 字上限/)
    assert.match(fs.readFileSync(path.join(r2.directory, '番茄填写单.txt'), 'utf8'), /笔名待你填写/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-characters-'))
process.env.WORKSHOP_SANDBOX = sandbox
try {
  const S = await import('./lib/store.mjs')
  const P = await import('./lib/prompts.mjs')
  const b = S.createBook('Character test')
  assert.deepEqual(S.readCharacterCard(b.id).characters, [])
  const card = S.saveCharacterCard(b.id, { characters: [{ name: 'Lin', bottomLine: 'Protect civilians', behavior: 'Observe before acting' }] })
  assert.equal(S.readCharacterCard(b.id).characters[0].bottomLine, 'Protect civilians')
  assert.ok(P.characterCardText(card).includes('Protect civilians'))
  assert.equal(S.saveCharacterCard(b.id, { characters: [{ name: '' }] }).characters.length, 0)
  console.log('4 character-card checks passed; temporary sandbox only')
} finally { fs.rmSync(sandbox, { recursive: true, force: true }) }

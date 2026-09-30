import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { canonicalJson, identityBindingsFor, parseEnumSource } from './update-game-data.mjs'

test('enum labels retain explicit, implicit, and signed codes and reject ambiguity', () => {
  assert.deepEqual(parseEnumSource('enum Synthetic { None = -1, Zero, Five = 5, Six }', 'Synthetic'), { '-1': 'None', 0: 'Zero', 5: 'Five', 6: 'Six' })
  for (const source of ['enum Synthetic { A = 1, B = 1 }', 'enum Synthetic { A = 1 << 2 }', 'enum Other { A }']) assert.throws(() => parseEnumSource(source, 'Synthetic'))
})

test('identity links use reviewed numeric IDs without matching display names', () => {
  const databases = { item: [{ ID: 7, Name: 'New label' }, { ID: 8, Name: 'Old label' }] }
  assert.deepEqual(identityBindingsFor({ mappings: { 'source:item:old-label': { database: 'item', databaseId: 7 } } }, databases), { 'item:7': 'source:item:old-label' })
  assert.throws(() => identityBindingsFor({ mappings: { a: { database: 'item', databaseId: 7 }, b: { database: 'item', databaseId: 7 } } }, databases))
  assert.equal(canonicalJson({ b: [0, null, false], a: '' }), '{"a":"","b":[0,null,false]}')
})

test('CLI distinguishes help, usage errors, and offline integrity verification', () => {
  const script = new URL('./update-game-data.mjs', import.meta.url)
  assert.match(execFileSync(process.execPath, ['--experimental-strip-types', script.pathname, '--help'], { encoding: 'utf8' }), /Usage:/)
  for (const args of [[], ['--unknown'], ['--check', '--input', 'unused']]) assert.equal(spawnSync(process.execPath, ['--experimental-strip-types', script.pathname, ...args]).status, 2)
  assert.match(execFileSync(process.execPath, ['--experimental-strip-types', script.pathname, '--check'], { encoding: 'utf8' }), /Verified Windows 1\.6\.9/)
})

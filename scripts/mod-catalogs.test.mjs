import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseEquipmentArchive } from './update-mod-catalogs.mjs'

const script = fileURLToPath(new URL('./update-mod-catalogs.mjs', import.meta.url))

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

test('mod catalog updater documents both modes and portable help flags', () => {
  for (const flag of ['-h', '--help']) {
    const result = run([flag])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /--equipment-json PATH/)
    assert.match(result.stdout, /--base-equipment-archive PATH/)
    assert.match(result.stdout, /--check/)
    assert.equal(result.stderr, '')
  }
})

test('mod catalog updater accepts equivalent option forms and rejects invalid usage', () => {
  const missing = run(['--equipment-json=/not-present', '-a/not-present', '-b/not-present', '--learnable-innates-json', '/not-present'])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /ENOENT/)
  const unknown = run(['--unknown'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown option/)
  const incomplete = run(['--equipment-json', '/not-present'])
  assert.equal(incomplete.status, 2)
  assert.match(incomplete.stderr, /requires --equipment-json/)
})

test('base equipment archives expose exact named PNG payloads and reject trailing data', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const name = Buffer.from('Sword2H')
  const header = Buffer.alloc(13)
  header.writeUInt16LE(1, 2)
  const nameLength = Buffer.alloc(4)
  nameLength.writeInt32LE(name.length)
  const dataLength = Buffer.alloc(4)
  dataLength.writeInt32LE(png.length)
  const archive = Buffer.concat([header, nameLength, name, dataLength, png])
  assert.deepEqual([...parseEquipmentArchive(archive)], [['Sword2H', png]])
  assert.throws(() => parseEquipmentArchive(Buffer.concat([archive, Buffer.from([0])])), /trailing data/)
})

test('committed normalized mod data and exact sprites validate without private inputs', () => {
  const result = run(['--check'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Validated \d+ equipment definitions, \d+ learnable innates, and \d+ exact sprites\n$/)
  assert.equal(result.stderr, '')
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
test('export CLI and browser package share the pinned numeric sources without private inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crystal-calculations-'))
  try {
    const output = join(directory, 'calculations.json')
    execFileSync(process.execPath, ['scripts/export-calculations.mjs', '--output', output])
    const exported = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(exported.format, 'crystal-project-calculations')
    assert.equal(exported.rules.id, exported.data.engine)
    assert.equal(exported.rules.source.executableSha256, exported.data.executableSha256)
    assert.equal(exported.data.nativeDataDigest, JSON.parse(readFileSync('src/catalog/native-game-data.json', 'utf8')).contentDigest)
    const { checksum, ...content } = exported.data
    assert.equal(hash(content), checksum)
    assert.deepEqual(exported.rules, JSON.parse(readFileSync('src/calculations/pc-1.6.9-v1.json', 'utf8')))
    assert.deepEqual(exported.legacy, JSON.parse(readFileSync('src/calculations/guide-v1.json', 'utf8')))
    const data = JSON.stringify(exported)
    assert.doesNotMatch(data, /\/Users\/|playthroughs|personalDefinitions|displayedStats/)
    for (const [entityId, binding] of Object.entries(exported.data.bindings)) {
      assert.ok(exported.data.records[binding.family].some(record => record.ID === binding.id), entityId)
      assert.ok(binding.evidence)
    }
    assert.equal(JSON.stringify(exported), JSON.stringify(JSON.parse(execFileSync(process.execPath, ['scripts/export-calculations.mjs'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }))))
  } finally { rmSync(directory, { recursive: true }) }
})

test('calculation CLIs separate help, usage errors and runtime checks', () => {
  for (const script of ['scripts/export-calculations.mjs', 'scripts/update-native-stats.mjs']) {
    const help = spawnSync(process.execPath, [script, '-h'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Usage:/)
    assert.equal(help.stderr, '')
    const invalid = spawnSync(process.execPath, [script, '--invalid'], { encoding: 'utf8' })
    assert.equal(invalid.status, 2)
    assert.equal(invalid.stdout, '')
    assert.ok(invalid.stderr)
  }
  assert.equal(spawnSync(process.execPath, ['scripts/update-native-stats.mjs', '--check']).status, 0)
})

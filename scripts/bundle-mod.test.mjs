import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeModExport, validateModSnapshot } from './bundle-mod.mjs'

const project = () => ({ ID: 'synthetic-mod', Title: 'Synthetic mod', Version: '1.0', EditorVersion: 27, Jobs: [{ ID: 24, Name: 'Synthetic class', Description: null, Comments: 'Private author note', IsStartingJob: false, EquipmentTypes: [], HPRating: 0 }], Abilities: [{ ID: 500, Name: 'Synthetic skill', MPCost: 0, Description: 'A source description' }] })
const normalize = root => normalizeModExport(root, Buffer.from(JSON.stringify(root)), 'synthetic-mod', 'Synthetic mod')

test('bundles exact zero, false, null, and numeric identities while excluding comments', () => {
  const snapshot = normalize(project())
  assert.deepEqual(snapshot.families.Jobs[0], { ID: 24, Name: 'Synthetic class', Description: null, IsStartingJob: false, EquipmentTypes: [], HPRating: 0 })
  assert.equal(snapshot.source.version, '1.0')
  assert.match(snapshot.source.sha256, /^[a-f0-9]{64}$/)
  validateModSnapshot(snapshot)
  assert.equal(JSON.stringify(snapshot).includes('Private author note'), false)
})

test('rejects corrupt snapshots, duplicate family IDs, unsafe objects, and absent source identity', () => {
  const duplicate = project()
  duplicate.Jobs.push(duplicate.Jobs[0])
  assert.throws(() => normalize(duplicate), /duplicate/)
  assert.throws(() => normalize({ ...project(), ID: undefined }), /source evidence/)
  assert.throws(() => normalize({ ...project(), Jobs: [JSON.parse('{"ID":24,"Name":"Unsafe","__proto__":{}}')] }), /Unsafe/)
  const changed = structuredClone(normalize(project()))
  changed.families.Jobs[0].HPRating = 10
  assert.throws(() => validateModSnapshot(changed), /digest/)
})

test('CLI accepts documented forms and checks without source files, and refuses snapshot overwrite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crykit-mod-bundle-'))
  const input = join(directory, 'source.json')
  const output = join(directory, 'snapshot.json')
  const cli = (...args) => execFileSync(process.execPath, ['scripts/bundle-mod.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    writeFileSync(input, JSON.stringify(project()))
    assert.match(cli('-h'), /Usage:/)
    assert.match(cli('--help'), /No environment variables/)
    assert.match(cli(`-i${input}`, `--output=${output}`, '-ksynthetic-mod', '--mod', 'Synthetic mod'), /Bundled/)
    const bytes = readFileSync(output)
    rmSync(input)
    assert.match(cli('-c', '-o', output), /Verified/)
    assert.match(cli('-co', output, '--'), /Verified/)
    writeFileSync(input, JSON.stringify({ ...project(), Version: '2.0' }))
    assert.throws(() => cli('-i', input, '-o', output, '-k', 'synthetic-mod', '-m', 'Synthetic mod'), error => error.status === 1 && /EEXIST/.test(error.stderr))
    assert.deepEqual(readFileSync(output), bytes)
    for (const args of [['--bad'], ['--output='], ['--check', '-o', output, '-i', input], ['-i', input, '-o', output, '-k', '../bad', '-m', 'Synthetic mod'], ['--', '--check']]) assert.throws(() => cli(...args), error => error.status === 2 && error.stdout === '')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

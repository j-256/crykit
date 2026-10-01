import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { contentDigest, validateEntityReference } from './update-entity-reference.mjs'

const GAME_HASH = '1'.repeat(64)
const EDITOR_HASH = '2'.repeat(64)
const BIOME_HASH = '3'.repeat(64)
function fixture() {
  const schema = { source: { gameVersion: '1.6.9', gameExecutableSha256: GAME_HASH, editorExecutableSha256: EDITOR_HASH, entityWorldSha256: '4'.repeat(64) } }
  const native = { databases: { biome: [{ ID: 0, Name: 'N/A' }] }, source: { gameVersion: '1.6.9', executable: { sha256: GAME_HASH }, files: [{ path: 'Database/biome.dat', sha256: BIOME_HASH, size: 123 }] } }
  const snapshot = {
    schemaVersion: 1,
    contentDigest: '',
    source: { platform: 'Windows', gameVersion: '1.6.9', gameExecutableSha256: GAME_HASH, editorExecutableSha256: EDITOR_HASH, world: { path: 'Content/Worlds/field.dat', sha256: '4'.repeat(64), size: 123 }, biomes: { path: 'Content/Database/biome.dat', sha256: BIOME_HASH, size: 123 }, scope: 'Crystal Edit field world baseline', rights: 'Source-specific game/editor data; no content license asserted', evidence: ['Sang.Voxel.EntityLedger.LoadLedger'] },
    records: [{ ID: 1, Name: 'Marker', NameSource: 'EntityType', EntityType: 'Marker', BiomeID: 0, BiomeName: 'N/A', Coord: { X: 0, Y: -1, Z: 2 } }],
  }
  snapshot.contentDigest = contentDigest(snapshot)
  return { snapshot, schema, native }
}
test('entity integrity accepts explicit zero coordinates and stable canonical digest', () => {
  const { snapshot, schema, native } = fixture()
  validateEntityReference(snapshot, schema, native)
  assert.equal(contentDigest(snapshot), contentDigest({ records: snapshot.records, source: snapshot.source, contentDigest: 'ignored', schemaVersion: 1 }))
})
test('entity integrity rejects duplicate IDs, shape corruption, and digest mismatch', () => {
  for (const change of [
    snapshot => snapshot.records.push(structuredClone(snapshot.records[0])),
    snapshot => { snapshot.records[0].Coord.X = null },
    snapshot => { snapshot.records[0].BiomeID = 256 },
    snapshot => { snapshot.records[0].BiomeName = 'Unverified' },
    snapshot => { snapshot.records[0].ID = 2147483648 },
    snapshot => { snapshot.records[0].JobID = 2147483648 },
    snapshot => { snapshot.records[0].TroopIDs = [-2147483649] },
    snapshot => { snapshot.records[0].EntityType = 'Unverified' },
    snapshot => { snapshot.records[0].NameSource = 'NpcData.Key' },
    snapshot => { snapshot.records[0].NpcOutfitNames = [3] },
    snapshot => { snapshot.records[0].TroopIDs = [null] },
    snapshot => { snapshot.records[0].Comments = 'No dialogue in metadata' },
    snapshot => { snapshot.source.world.path = '/private/source.dat' },
    snapshot => { snapshot.contentDigest = '0'.repeat(64) },
  ]) {
    const { snapshot, schema, native } = fixture()
    change(snapshot)
    if (snapshot.contentDigest !== '0'.repeat(64)) snapshot.contentDigest = contentDigest(snapshot)
    assert.throws(() => validateEntityReference(snapshot, schema, native))
  }
})
test('entity integrity rejects fingerprint and version disagreement even with a valid digest', () => {
  for (const change of [
    snapshot => { snapshot.source.gameExecutableSha256 = '5'.repeat(64) },
    snapshot => { snapshot.source.editorExecutableSha256 = '5'.repeat(64) },
    snapshot => { snapshot.source.biomes.sha256 = '5'.repeat(64) },
    snapshot => { snapshot.source.world.sha256 = '5'.repeat(64) },
    snapshot => { snapshot.source.gameVersion = 'unknown' },
  ]) {
    const { snapshot, schema, native } = fixture()
    change(snapshot)
    snapshot.contentDigest = contentDigest(snapshot)
    assert.throws(() => validateEntityReference(snapshot, schema, native), /pin/)
  }
})
test('CLI help and usage forms separate results from diagnostics', () => {
  const script = new URL('./update-entity-reference.mjs', import.meta.url).pathname
  for (const flag of ['--help', '-h', '-hiunused']) {
    const result = spawnSync(process.execPath, [script, flag], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
  for (const args of [[], ['--unknown'], ['--input'], ['--input='], ['-i', ''], ['--check', '-iunused'], ['--check', '--', 'unexpected']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.length > 0)
  }
  assert.match(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8', env: { ...process.env, PATH: '' } }), /Verified Windows 1\.6\.9/)
})

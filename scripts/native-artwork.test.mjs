import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { NO_NATIVE_ARTWORK, nativeArtworkEntries, nativeArtworkPlan, validateNativeArtworkCoverage, validateNativeUiArtwork } from './native-artwork.mjs'

const textures = new Map([
  ['Icon/Test', { width: 240, height: 104, sha256: 'icon-hash' }],
  ['Monster/Red', { width: 40, height: 50, sha256: 'red-hash' }],
  ['Monster/Blue', { width: 80, height: 60, sha256: 'blue-hash' }],
])
const entry = (database, id, mode, record) => ({ id: `native:${mode}:${database}:${id}`, kind: database === 'monster' ? 'monster' : 'item', name: 'Same name', nativeRecord: { database, databaseId: id, mode, locator: `${database}:${id}`, databaseSha256: 'database-hash' }, record: { ID: id, Name: 'Same name', ...record } })

test('same-name monsters and mode overrides use their own explicit texture references', () => {
  const red = entry('monster', 4, 'base', { TexturePath: 'Monster/Red' })
  const blue = entry('monster', 5, 'base', { TexturePath: 'Monster/Blue' })
  const chaos = entry('monster', 4, 'Chaos', { TexturePath: 'Monster/Blue' })
  assert.equal(nativeArtworkPlan(red, textures).sourceTextures[0].textureSha256, 'red-hash')
  assert.deepEqual(nativeArtworkPlan(blue, textures).sourceTextures[0].region, { x: 0, y: 0, width: 80, height: 60 })
  assert.equal(nativeArtworkPlan(chaos, textures).sourceTextures[0].texturePath, 'Monster/Blue')
  assert.equal(nativeArtworkPlan(entry('monster', 4, 'Vanilla', { TexturePath: null, TexturePathAlt: 'Monster/Red' }), textures), undefined)
})

test('indexed artwork honors recorded cells and rejects unavailable textures or invalid regions', () => {
  const item = entry('item', 28, 'base', { TexturePath: 'Icon/Test', TextureIndex: 16 })
  assert.deepEqual(nativeArtworkPlan(item, textures).sourceTextures[0].region, { x: 70, y: 70, width: 32, height: 32 })
  assert.throws(() => nativeArtworkPlan({ ...item, record: { ...item.record, TextureIndex: 100 } }, textures), /outside/)
  assert.throws(() => nativeArtworkPlan({ ...item, record: { ...item.record, TexturePath: 'Icon/Missing' } }, textures), /absent/)
  assert.equal(nativeArtworkPlan(entry('ability', 28, 'base', { TexturePath: null, TextureIndex: 16 }), textures), undefined)
  assert.equal(nativeArtworkPlan(entry('passive', 28, 'base', {}), textures), undefined)
})

test('offline coverage rejects changed source cells, mode identity, absent artwork, and stale gaps', () => {
  const item = entry('item', 28, 'base', { TexturePath: 'Icon/Test', TextureIndex: 16 })
  const missing = entry('monster', 4, 'Chaos', { TexturePath: null })
  const plan = nativeArtworkPlan(item, textures)
  const manifest = { entities: { [item.id]: { kind: item.kind, name: item.name, nativeRecord: item.nativeRecord, database: { name: 'item', id: 28, recordName: item.record.Name }, rendering: { extraction: plan.extraction, sourceTextures: plan.sourceTextures } } }, coverage: { nativeDefinitionGaps: [{ id: missing.id, kind: missing.kind, name: missing.name, nativeRecord: missing.nativeRecord, reason: NO_NATIVE_ARTWORK }] } }
  assert.doesNotThrow(() => validateNativeArtworkCoverage(manifest, [item, missing], textures))
  for (const mutate of [
    m => { m.entities[item.id].nativeRecord.mode = 'Chaos' },
    m => { m.entities[item.id].rendering.sourceTextures[0].region.x = 36 },
    m => { delete m.entities[item.id] },
    m => { m.coverage.nativeDefinitionGaps[0].nativeRecord.databaseId = 5 },
    m => { m.coverage.nativeDefinitionGaps.push(m.coverage.nativeDefinitionGaps[0]) },
  ]) {
    const changed = structuredClone(manifest)
    mutate(changed)
    assert.throws(() => validateNativeArtworkCoverage(changed, [item, missing], textures), /stale|Duplicate/)
  }
})

test('artwork uses catalog identities and patch source records from the native snapshot', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../src/catalog/native-game-data.json', import.meta.url)))
  const entries = nativeArtworkEntries(snapshot)
  const sword = entries.find(e => e.nativeRecord.database === 'equipment' && e.nativeRecord.databaseId === 0 && e.nativeRecord.mode === 'base')
  assert.equal(sword.id, 'base:item:short-sword')
  const eye = entries.find(e => e.id === 'base:item:28')
  assert.equal(eye.record.TexturePath, 'Icon/ItemC')
  assert.equal(eye.record.TextureIndex, 16)
  const chaos = entries.find(e => e.id === 'base:monster:179:mode:Chaos')
  assert.match(chaos.nativeRecord.locator, /^Database\/patch\.dat\//)
  assert.equal(chaos.nativeRecord.databaseSha256, snapshot.source.files.find(f => f.path === 'Database/patch.dat').sha256)
})

test('UI artwork rejects changed currency cells, swapped coins, and seal identity drift', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/catalog/game-assets.json', import.meta.url)))
  const textures = new Map(Object.values(manifest.sources.texturePacks).flatMap(pack => pack.textures.map(texture => [texture.path, texture])))
  assert.doesNotThrow(() => validateNativeUiArtwork(manifest, textures))
  assert.equal(manifest.uiArtwork.classSeal.asset, manifest.entities['base:item:warrior-seal'].asset)
  for (const [key, x] of [['goldCoin', 1], ['silverCoin', 19], ['copperCoin', 37]]) {
    assert.deepEqual(manifest.uiArtwork[key].rendering.sourceTextures[0].region, { x, y: 0, width: 16, height: 18 })
    assert.equal(manifest.uiArtwork[key].rendering.sourceTextures[0].texturePath, 'GUI/Currency')
  }
  for (const mutate of [
    m => { m.uiArtwork.goldCoin.rendering.sourceTextures[0].region.x = 0 },
    m => { m.uiArtwork.goldCoin.asset = m.uiArtwork.silverCoin.asset },
    m => { m.uiArtwork.classSeal.entityId = 'base:item:quintar-pass' },
    m => { delete m.uiArtwork.copperCoin },
  ]) {
    const changed = structuredClone(manifest)
    mutate(changed)
    assert.throws(() => validateNativeUiArtwork(changed, textures), /invalid|stale/)
  }
})

import { expect, it } from 'vitest'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { addTestBuild, createTestLocalData } from './test-helpers'
import { applyLibraryDefaultsToNewSetup, enableLibrarySourceForBuild } from './mod-library-actions'
import { jsonRecord } from './crystal-edit'
import { buildBehavior } from './build-behavior'

it('semanticMatchDoesNotRewriteHistoricalPin', async () => {
  const bytes = new TextEncoder().encode('{"ID":"same-project","EditorVersion":34,"Items":[{"ID":3,"Name":"Mod item"}]}')
  const original = (await previewCrystalEdit(bytes, 'original.json')).proposed.catalogs[0]!
  const reformatted = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)), null, 2)), 'reformatted.json')).proposed.catalogs[0]!
  expect(original.legacy).toMatchObject({ contentFingerprint: jsonRecord(reformatted.legacy) && reformatted.legacy.contentFingerprint })
  expect(original.revisionId).not.toBe(reformatted.revisionId)
  const before = addTestBuild(createTestLocalData(), 'original-build', '', {})
  const originalCheckpoint = before.buildRevisions['original-build-revision']!
  const after = enableLibrarySourceForBuild(before, original, [...BUNDLED_CATALOGS, original, reformatted], 'original-build', before.builds['original-build']!.revision)
  const savedCheckpoint = after.buildRevisions[after.builds['original-build']!.latestRevisionId!]!
  expect(savedCheckpoint.id).not.toBe(originalCheckpoint.id)
  expect(after.buildRevisions[originalCheckpoint.id]).toEqual(originalCheckpoint)
  expect(savedCheckpoint.catalogLock).not.toEqual(originalCheckpoint.catalogLock)
  expect(after.gameSetups[savedCheckpoint.gameSetupRevisionId]?.modComposition?.layers).toContainEqual({ catalogId: original.id, catalogRevisionId: original.revisionId, enabled: true })
})

it('rejects a stale Build target before changing any checkpoint', async () => {
  const catalog = (await previewCrystalEdit(new TextEncoder().encode('{"ID":"target","EditorVersion":34,"Items":[{"ID":1,"Name":"Item"}]}'), 'target.json')).proposed.catalogs[0]!
  const before = addTestBuild(createTestLocalData(), 'build', '', {})
  expect(() => enableLibrarySourceForBuild(before, catalog, [...BUNDLED_CATALOGS, catalog], 'build', 0)).toThrow('Build changed')
  expect(before.buildRevisions).toHaveProperty('build-revision')
})

it('uses only the exact saved default pin for a new Game Setup', async () => {
  const catalog = (await previewCrystalEdit(new TextEncoder().encode('{"ID":"default","EditorVersion":34,"Items":[{"ID":1,"Name":"Item"}]}'), 'default.json')).proposed.catalogs[0]!
  const original = createTestLocalData().gameSetups['gameSetup-revision']!
  const behavior = buildBehavior(original)
  const defaults = { version: 1 as const, layers: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: true }] }
  const selected = applyLibraryDefaultsToNewSetup(behavior, defaults, [...BUNDLED_CATALOGS, catalog])
  expect(selected.modComposition?.layers).toContainEqual(defaults.layers[0])
  expect(selected.modSourceReceipts).toContainEqual(expect.objectContaining({ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum }))
  expect(original.modComposition).toBeUndefined()
  expect(() => applyLibraryDefaultsToNewSetup(behavior, defaults, BUNDLED_CATALOGS)).toThrow('unavailable')
})

import 'fake-indexeddb/auto'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { WITHDRAWN_CATALOGS } from '../domain/withdrawn-catalogs'
import { createSampleLocalData } from '../domain/sample-data'
import { createPersonalDefinition, resolveDefinition } from '../domain'
import { resolveBundledCatalogPins, validateNativeLocalDataGraph } from '../interchange/native'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { exportBackup, loadLocalData, previewImport, saveLocalDataWithStatus, commitImport, undoLocalDataWithStatus } from './local-data'
import { modCatalogRevision } from '../domain/mod-layers'
import type { CatalogRef, CatalogSnapshot, LocalData } from '../domain/types'

let database: CryKitDatabase
beforeEach(() => { database = new CryKitDatabase(`withdrawn-catalog-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { setDatabaseForTests(undefined); await database.delete() })
const receipt = WITHDRAWN_CATALOGS[0]!
function historicalData(): LocalData {
  return JSON.parse(JSON.stringify(createSampleLocalData(CURRENT_CATALOG)).replaceAll(CURRENT_CATALOG.revisionId, receipt.revisionId)) as LocalData
}
async function seed(snapshot?: CatalogSnapshot) {
  const localData = historicalData()
  await database.localDatas.put({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
  if (snapshot) await database.catalogs.put({ key: JSON.stringify([snapshot.id, snapshot.revisionId]), id: snapshot.id, revisionId: snapshot.revisionId, checksum: snapshot.checksum, snapshot })
  return localData
}

it('preserves withdrawn pins, saved references, undo and backup receipts without substituting definitions', async () => {
  const before = await seed()
  const loaded = await loadLocalData()
  expect(loaded.localData).toEqual(before)
  expect(loaded.catalogs.some(catalog => catalog.revisionId === receipt.revisionId)).toBe(false)
  const changed = createPersonalDefinition(before, { name: 'Synthetic retained entry', kind: 'item' })
  const saved = await saveLocalDataWithStatus(changed, before.revision)
  const backup = await previewImport(await exportBackup(), 'synthetic-withdrawn.zip')
  expect(backup.proposed.localData).toEqual(saved.localData)
  expect(backup.warnings).toContainEqual(expect.objectContaining({ code: 'withdrawn-catalog' }))
  expect(backup.proposed.history).toHaveLength(1)
  const restored = await commitImport(backup)
  expect(restored.localData.buildRevisions).toEqual(saved.localData.buildRevisions)
  expect(restored.localData.gameSetups).toEqual(saved.localData.gameSetups)
  expect(restored.localData.playthroughs).toEqual(saved.localData.playthroughs)
  expect(restored.localData.personalDefinitions).toEqual(saved.localData.personalDefinitions)
  const undone = await undoLocalDataWithStatus(restored.revision)
  expect(undone.localData.buildRevisions).toEqual(before.buildRevisions)
  expect(undone.localData.gameSetups).toEqual(before.gameSetups)
})

it('retains a privately supplied historical snapshot and validates its references normally', async () => {
  const snapshot = { ...CURRENT_CATALOG, ...receipt }
  const localData = await seed(snapshot)
  const loaded = await loadLocalData()
  expect(loaded.catalogs).toContainEqual(snapshot)
  const backup = await previewImport(await exportBackup(), 'synthetic-private-history.zip')
  expect(backup.proposed.catalogs).toContainEqual(snapshot)
  expect(backup.warnings.some(warning => warning.code === 'withdrawn-catalog')).toBe(false)
  const damaged = { ...snapshot, entities: {} }
  expect(() => validateNativeLocalDataGraph(localData, [...BUNDLED_CATALOGS, damaged])).toThrow('missing catalog entity')
})

it('rejects unrelated unavailable revisions, missing entities in available catalogs and forged withdrawal receipts', () => {
  expect(resolveBundledCatalogPins([receipt], BUNDLED_CATALOGS)).toEqual([])
  expect(() => resolveBundledCatalogPins([{ ...receipt, checksum: 'builtin:sha256:forged' }], BUNDLED_CATALOGS)).toThrow('different checksum')
  const unrelated = JSON.parse(JSON.stringify(historicalData()).replaceAll(receipt.revisionId, 'catalog-unregistered')) as LocalData
  expect(() => validateNativeLocalDataGraph(unrelated, BUNDLED_CATALOGS)).toThrow('missing catalog revision')
  const current = createSampleLocalData(CURRENT_CATALOG)
  expect(() => validateNativeLocalDataGraph(current, [{ ...CURRENT_CATALOG, entities: {} }])).toThrow('missing catalog entity')
})

function unavailableCompositionData(): LocalData {
  const original = historicalData()
  const setup = original.gameSetups[original.planningGameSetupRevisionId!]!
  const revisionId = modCatalogRevision(setup.id)
  const data = JSON.parse(JSON.stringify(original).replaceAll(receipt.revisionId, revisionId)) as LocalData
  const layer = WITHDRAWN_CATALOGS.find(value => value.id.startsWith('crystal-edit:'))!
  return { ...data, gameSetups: { ...data.gameSetups, [setup.id]: { ...data.gameSetups[setup.id]!, modComposition: { baseline: { catalogId: receipt.id, catalogRevisionId: receipt.revisionId }, layers: [{ catalogId: layer.id, catalogRevisionId: layer.revisionId, enabled: true }], links: [] } } } }
}

it('preserves unresolved effective references through saves, backups and undo when exact composition dependencies are unavailable', async () => {
  const data = unavailableCompositionData()
  const revision = Object.values(data.buildRevisions)[0]!
  const nativeClass = revision.content.primaryClass as CatalogRef
  // Use a missing mod identity; reviewed unchanged native entries remain available without its source
  const ref: CatalogRef = { ...nativeClass, entityId: 'mod:synthetic-missing:class:9000' as CatalogRef['entityId'] }
  const before = { ...data, buildRevisions: { ...data.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, primaryClass: ref } } } }
  await database.localDatas.put({ id: 'local-data-record', revision: before.revision, updatedAt: before.updatedAt, localData: before, lineage: { rootLocalDataId: before.id } })
  const loaded = await loadLocalData()
  expect(loaded.localData).toEqual(before)
  expect(resolveDefinition(before, loaded.catalogs, nativeClass)).toMatchObject({ id: nativeClass.entityId, name: 'Warrior' })
  expect(resolveDefinition(before, loaded.catalogs, ref)).toBeUndefined()
  const changed = createPersonalDefinition(before, { name: 'Synthetic composition note', kind: 'item' })
  const saved = await saveLocalDataWithStatus(changed, before.revision)
  const backup = await previewImport(await exportBackup(), 'synthetic-unavailable-composition.zip')
  expect(backup.proposed.localData).toEqual(saved.localData)
  expect(backup.proposed.catalogs.some(value => value.revisionId === ref.catalogRevisionId)).toBe(false)
  expect(backup.warnings).toContainEqual(expect.objectContaining({ code: 'withdrawn-catalog' }))
  const restored = await commitImport(backup)
  expect(restored.localData.buildRevisions).toEqual(before.buildRevisions)
  const undone = await undoLocalDataWithStatus(restored.revision)
  expect(undone.localData.gameSetups).toEqual(before.gameSetups)
  expect(resolveDefinition(undone.localData, loaded.catalogs, ref)).toBeUndefined()
})

it('rejects unregistered composition gaps and effective pins with no matching origin', () => {
  const data = unavailableCompositionData()
  const setup = data.gameSetups[data.planningGameSetupRevisionId!]!
  const missingLayer = { ...setup, modComposition: { ...setup.modComposition!, layers: [{ ...setup.modComposition!.layers[0]!, catalogRevisionId: 'unregistered-layer' as CatalogSnapshot['revisionId'] }] } }
  expect(() => validateNativeLocalDataGraph({ ...data, gameSetups: { ...data.gameSetups, [setup.id]: missingLayer } }, BUNDLED_CATALOGS)).toThrow('unavailable catalog revision')
  const wrongOrigin = { ...setup, catalogLock: { [receipt.id]: 'mod-setup:unknown-origin' as CatalogSnapshot['revisionId'] } }
  expect(() => validateNativeLocalDataGraph({ ...data, gameSetups: { ...data.gameSetups, [setup.id]: wrongOrigin } }, BUNDLED_CATALOGS)).toThrow('matching originating Game Setup')
  const wrongSnapshot = { ...CURRENT_CATALOG, revisionId: modCatalogRevision(setup.id), schemaVersion: 'game-setup-mod-catalog-1', legacy: { modBaseline: { ...setup.modComposition!.baseline }, modGameSetupRevisionId: 'unrelated-origin' } }
  expect(() => validateNativeLocalDataGraph(data, [...BUNDLED_CATALOGS, wrongSnapshot])).toThrow('inconsistent effective catalog identity')
})

it('rejects a supplied historical snapshot that contradicts its exact backup receipt without changing stored data', async () => {
  const before = await seed()
  const files = unzipSync(await exportBackup())
  const bundle = JSON.parse(strFromU8(files['bundle.json']!))
  bundle.catalogs.push({ ...CURRENT_CATALOG, ...receipt, checksum: 'synthetic-contradictory-checksum' })
  files['bundle.json'] = new TextEncoder().encode(JSON.stringify(bundle))
  await expect(previewImport(zipSync(files), 'synthetic-mismatched-receipt.zip')).rejects.toThrow('backup checksum pin')
  expect((await loadLocalData()).localData).toEqual(before)
})

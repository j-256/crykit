import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { resolveDefinition } from '../domain'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { loadLocalData } from './local-data'
import { buildDefinitionOptions } from '../ui/definitions'
import type { CatalogRef, LocalData } from '../domain/types'

let database: CryKitDatabase
beforeEach(() => { database = new CryKitDatabase(`unsupported-source-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { setDatabaseForTests(undefined); await database.delete() })

it('rejects a missing historical source without rewriting the stored planner', async () => {
  const localData = JSON.parse(JSON.stringify(createSampleLocalData(CURRENT_CATALOG)).replaceAll(CURRENT_CATALOG.revisionId, 'catalog-v1')) as LocalData
  const record = { id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } }
  await database.localDatas.put(record)
  await expect(loadLocalData()).rejects.toThrow(/missing catalog revision/)
  expect(await database.localDatas.get(record.id)).toEqual(record)
})

it('never substitutes current definitions or editor choices for a missing exact revision', () => {
  const localData = createSampleLocalData(CURRENT_CATALOG)
  const ref: CatalogRef = { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: 'catalog-v1' as never, entityId: Object.values(CURRENT_CATALOG.entities)[0]!.id }
  expect(resolveDefinition(localData, [CURRENT_CATALOG], ref)).toBeUndefined()
  const setupId = localData.planningGameSetupRevisionId!
  const pinned = { ...localData, gameSetups: { ...localData.gameSetups, [setupId]: { ...localData.gameSetups[setupId]!, catalogLock: { [ref.catalogId]: ref.catalogRevisionId } } } }
  expect(buildDefinitionOptions(pinned, [CURRENT_CATALOG]).some(option => option.ref.kind === 'catalog' && option.ref.catalogRevisionId === ref.catalogRevisionId)).toBe(false)
  expect(() => validateNativeLocalDataGraph(pinned, [CURRENT_CATALOG])).toThrow(/missing catalog revision/)
})

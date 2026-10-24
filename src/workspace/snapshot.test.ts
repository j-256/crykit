import { expect, it } from 'vitest'
import type { CatalogSnapshot } from '../domain/types'
import { immutableCatalogSnapshot } from '../interchange/native'
import { editorClosureFixture } from './test-helpers'
import { ownWorkspaceSnapshot } from './snapshot'

it('retains admitted immutable catalogs while isolating mutable captured data', async () => {
  const fixture = await editorClosureFixture()
  const seed: CatalogSnapshot = { id: 'synthetic-catalog' as never, revisionId: 'synthetic-revision' as never, schemaVersion: 'synthetic', checksum: 'synthetic', importedAt: fixture.state.planner.localData.createdAt, applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: {}, claims: [], legacy: { marker: 'Before capture' } }
  const admitted = immutableCatalogSnapshot(structuredClone(seed))
  const unowned = { ...structuredClone(seed), id: 'synthetic-unowned' as CatalogSnapshot['id'] }
  Object.freeze(unowned)
  const state = { ...fixture.state, planner: { ...fixture.state.planner, catalogs: [admitted, unowned] } }
  const id = state.planner.localData.id
  const snapshot = ownWorkspaceSnapshot({ version: 1, snapshotId: 'catalog-ownership', capturedAt: '2026-10-17', revisionVector: {}, state }, { async check() {}, async dispose() {} })
  expect(snapshot.state.planner.catalogs[0]).toBe(admitted)
  Object.assign(unowned.legacy!, { marker: 'Later caller edit' })
  Object.assign(state.planner.localData, { id: 'changed-after-capture' })
  expect(snapshot.state.planner.catalogs[1].legacy).toEqual({ marker: 'Before capture' })
  expect(snapshot.state.planner.localData.id).toBe(id)
  expect(Object.isFrozen(snapshot.state.planner.catalogs[1].legacy)).toBe(true)
})

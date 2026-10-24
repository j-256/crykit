import { expect, it } from 'vitest'
import { addTestBuild, createTestLocalData } from '../domain/test-helpers'
import { privateRecordKey, type WorkspaceDocument } from './documents'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { domainClosureKeys, resolvedDomainClosureKeys } from './domain-closure'
import { modCatalogRevision } from '../domain/mod-layers'

function fixture() {
  const base = Object.values(createTestLocalData().gameSetups)[0]
  const checksum = `sha256:${'a'.repeat(64)}`
  const receipt = { catalogId: 'crystal-edit:missing', catalogRevisionId: `${checksum}:rules-v1:library-v1`, checksum, title: 'Recorded missing source' }
  const baseline = { catalogId: 'baseline', catalogRevisionId: 'exact' }
  const setup = { ...base, catalogLock: { baseline: modCatalogRevision(base.id) }, modComposition: { baseline, layers: [{ catalogId: receipt.catalogId, catalogRevisionId: receipt.catalogRevisionId, enabled: true }], links: [] }, modSourceReceipts: [receipt] }
  const document = { version: 1, kind: 'setup', key: privateRecordKey('setup', setup.id), value: setup } as unknown as WorkspaceDocument
  const catalog = { version: 1, kind: 'catalog', key: privateRecordKey('catalog', 'baseline', 'exact'), value: { id: 'baseline', revisionId: 'exact', checksum: 'baseline-full' } } as unknown as WorkspaceDocument
  const documents = new Map([document, catalog].map(value => [value.key, value]))
  return { document, catalog, documents, setup, receipt }
}
it('retains originating setup evidence for unavailable source and effective catalog pins', () => {
  const { document, catalog, documents, setup } = fixture()
  expect(resolvedDomainClosureKeys(document, documents)).toEqual([catalog.key])
  const copy = { ...setup, id: 'copied-setup' }
  const copied = { ...document, key: privateRecordKey('setup', copy.id), value: copy } as unknown as WorkspaceDocument
  documents.set(copied.key, copied)
  expect(resolvedDomainClosureKeys(copied, documents)).toContain(document.key)
  documents.delete(document.key)
  expect(() => resolvedDomainClosureKeys(copied, documents)).toThrow('originating')
})
it('rejects mismatched receipts and present catalog checksums without hiding unrelated missing pins', () => {
  const { document, documents, setup, receipt } = fixture()
  const mismatched = { ...document, value: { ...setup, modSourceReceipts: [{ ...receipt, checksum: `sha256:${'b'.repeat(64)}` }] } } as unknown as WorkspaceDocument
  expect(() => resolvedDomainClosureKeys(mismatched, new Map(documents).set(document.key, mismatched))).toThrow('receipt')
  const source = { version: 1, kind: 'catalog', key: privateRecordKey('catalog', receipt.catalogId, receipt.catalogRevisionId), value: { ...receipt, id: receipt.catalogId, revisionId: receipt.catalogRevisionId, checksum: 'wrong' } } as unknown as WorkspaceDocument
  expect(() => resolvedDomainClosureKeys(document, new Map(documents).set(source.key, source))).toThrow('checksum')
  const unrelated = { ...document, value: { ...setup, catalogLock: { ...setup.catalogLock, unrelated: 'missing' } } } as unknown as WorkspaceDocument
  expect(resolvedDomainClosureKeys(unrelated, new Map(documents).set(document.key, unrelated))).toContain(privateRecordKey('catalog', 'unrelated', 'missing'))
})

it('retains catalog closure and embedded unavailable receipts for exact immutable history', async () => {
  const { createBlankLocalData } = await import('../domain/local-data')
  const { historyEntry } = await import('../persistence/local-data')
  const { document, catalog, setup } = fixture()
  const localData = { ...createBlankLocalData(), gameSetups: { [setup.id]: setup } } as unknown as ReturnType<typeof createBlankLocalData>
  const history = historyEntry(localData, { ...localData, revision: 1 }, 'import', localData.updatedAt)
  const archived = { version: 1, kind: 'history', key: privateRecordKey('history', history.id), value: history } as unknown as WorkspaceDocument
  expect(resolvedDomainClosureKeys(archived, new Map([[archived.key, archived], [catalog.key, catalog]]))).toEqual([catalog.key])
  expect(resolvedDomainClosureKeys(document, new Map([[document.key, document], [catalog.key, catalog]]))).toEqual([catalog.key])
})
it('retainsRecordedPartyBaselineCheckpointsEvenWhenAnExplicitAssignmentOverridesThem', async () => {
  const { addTestTeam, addTestBuild, TEST_GAME_SETUP_REVISION_ID, TEST_PLAYTHROUGH_ID } = await import('../domain/test-helpers')
  const { createScenario } = await import('../domain')
  const team = addTestTeam(createTestLocalData())
  let state = addTestBuild(team.localData, 'captured', team.memberIds[0], {})
  state = addTestBuild(state, 'override', team.memberIds[0], {})
  const revisions = Object.values(state.buildRevisions)
  state = createScenario(state, { label: 'Baseline plus override', memberIds: team.memberIds, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, baseline: { kind: 'recordedParty', playthroughRevision: state.playthroughs[TEST_PLAYTHROUGH_ID].revision, assignments: { [team.memberIds[0]]: revisions[0].id } }, assignments: { [team.memberIds[0]]: revisions[1].id } })
  const value = Object.values(state.playthroughs[TEST_PLAYTHROUGH_ID].scenarios).find(value => value.label === 'Baseline plus override')!
  const document = { key: privateRecordKey('scenario', TEST_PLAYTHROUGH_ID, value.id), kind: 'scenario', value } as unknown as WorkspaceDocument
  const keys = resolvedDomainClosureKeys(document, new Map())
  expect(keys).toContain(privateRecordKey('build-checkpoint', revisions[0].id))
  expect(keys).toContain(privateRecordKey('build-checkpoint', revisions[1].id))
  expect(resolvedDomainClosureKeys(document, new Map(), 'legacy-s02')).not.toContain(privateRecordKey('build-checkpoint', revisions[0].id))
})

it('validates a dependent Build separately from its setup-owned imported catalogs', () => {
  const { document, catalog, setup, receipt } = fixture()
  const checkpoint = Object.values(addTestBuild(createTestLocalData(), 'dependent', 'unused', {}).buildRevisions)[0]!
  const owner = { ...document, value: { ...setup, modSourceReceipts: undefined } } as unknown as WorkspaceDocument
  const revision = { ...checkpoint, gameSetupRevisionId: setup.id, catalogLock: {} }
  const parent = { version: 1, kind: 'build-checkpoint', key: privateRecordKey('build-checkpoint', revision.id), value: revision } as unknown as WorkspaceDocument
  // The parent retains its setup; that setup must independently authenticate its own source layer
  expect(resolvedDomainClosureKeys(parent, new Map([[parent.key, parent], [owner.key, owner]]))).toContain(owner.key)
  expect(() => resolvedDomainClosureKeys(owner, new Map([[owner.key, owner], [catalog.key, catalog]]))).toThrow('unavailable catalog revision')
  const corrupt = { version: 1, kind: 'catalog', key: privateRecordKey('catalog', receipt.catalogId, receipt.catalogRevisionId), value: { id: receipt.catalogId, revisionId: receipt.catalogRevisionId, checksum: 'wrong' } } as unknown as WorkspaceDocument
  expect(() => resolvedDomainClosureKeys(document, new Map([[document.key, document], [catalog.key, catalog], [corrupt.key, corrupt]]))).toThrow('checksum')
})

it('reuses only deeply immutable catalog edge keys while rejecting changed catalog input', () => {
  const catalog = structuredClone(BUNDLED_CATALOGS[0])
  const first = domainClosureKeys('catalog', catalog)
  expect(domainClosureKeys('catalog', catalog)).toBe(first)
  expect(Object.isFrozen(catalog.entities)).toBe(true)
  expect(Reflect.set(Object.values(catalog.entities)[0]!, 'name', 'Changed')).toBe(false)
  const malformed = { ...structuredClone(catalog), entities: { broken: { name: 'Unvalidated' } } }
  expect(() => domainClosureKeys('catalog', malformed)).toThrow()
})

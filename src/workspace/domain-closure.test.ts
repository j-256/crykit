import { previewCrystalEdit } from '../interchange/crystal-edit'
import { expect, it } from 'vitest'
import { addTestBuild, createTestLocalData } from '../domain/test-helpers'
import { privateRecordKey, type WorkspaceDocument } from './documents'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { domainClosureKeys, resolvedDomainClosureKeys } from './domain-closure'
import { modCatalogRevision, composeModCatalog } from '../domain/mod-layers'

async function fixture() {
  const base = Object.values(createTestLocalData().gameSetups)[0]!
  const preview = await previewCrystalEdit(new TextEncoder().encode('{"ID":"Synthetic retained closure","EditorVersion":34,"Items":[]}'), 'source.json')
  const source = preview.proposed.catalogs[0]!
  const receipt = { catalogId: source.id, catalogRevisionId: source.revisionId, checksum: source.checksum, title: 'Recorded source', contentFingerprint: (source.legacy as Record<string, string>).contentFingerprint }
  const setup = { ...base, catalogLock: { [CURRENT_CATALOG.id]: modCatalogRevision(base.id) }, modComposition: { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] }, modSourceReceipts: [receipt] }
  const document = { version: 1, kind: 'setup', key: privateRecordKey('setup', setup.id), value: setup } as unknown as WorkspaceDocument
  const catalog = { version: 1, kind: 'catalog', key: privateRecordKey('catalog', CURRENT_CATALOG.id, CURRENT_CATALOG.revisionId), value: CURRENT_CATALOG } as unknown as WorkspaceDocument
  const imported = { version: 1, kind: 'catalog', key: privateRecordKey('catalog', source.id, source.revisionId), value: source } as unknown as WorkspaceDocument
  const effective = composeModCatalog(setup, [CURRENT_CATALOG, source])!
  const composed = { version: 1, kind: 'catalog', key: privateRecordKey('catalog', effective.id, effective.revisionId), value: effective } as unknown as WorkspaceDocument
  const documents = new Map([document, catalog, imported, composed].map(value => [value.key, value]))
  return { document, catalog, imported, composed, documents, setup, receipt }
}
it('retains complete private source graphs and originating setup evidence for rekeyed copies', async () => {
  const { document, catalog, imported, composed, documents, setup } = await fixture()
  expect(new Set(resolvedDomainClosureKeys(document, documents))).toEqual(new Set([catalog.key, imported.key, composed.key]))
  const copy = { ...setup, id: 'copied-setup' }
  const copied = { ...document, key: privateRecordKey('setup', copy.id), value: copy } as unknown as WorkspaceDocument
  documents.set(copied.key, copied)
  expect(resolvedDomainClosureKeys(copied, documents)).toContain(document.key)
  documents.delete(document.key)
  expect(() => resolvedDomainClosureKeys(copied, documents)).toThrow('originating')
})
it('rejects missing private source bodies and mismatched receipts without hiding unrelated pins', async () => {
  const { document, imported, documents, setup, receipt } = await fixture()
  const missing = new Map(documents); missing.delete(imported.key)
  expect(() => resolvedDomainClosureKeys(document, missing)).toThrow('unavailable catalog revision')
  const mismatched = { ...document, value: { ...setup, modSourceReceipts: [{ ...receipt, checksum: `payload:sha256:${'b'.repeat(64)}` }] } } as unknown as WorkspaceDocument
  expect(() => resolvedDomainClosureKeys(mismatched, new Map(documents).set(document.key, mismatched))).toThrow('checksum')
  const unrelated = { ...document, value: { ...setup, catalogLock: { ...setup.catalogLock, unrelated: 'missing' } } } as unknown as WorkspaceDocument
  expect(resolvedDomainClosureKeys(unrelated, new Map(documents).set(document.key, unrelated))).toContain(privateRecordKey('catalog', 'unrelated', 'missing'))
})
it('retains exact private source bodies across immutable history endpoints', async () => {
  const { createBlankLocalData } = await import('../domain/local-data')
  const { historyEntry } = await import('../persistence/local-data')
  const { catalog, imported, composed, setup } = await fixture()
  const localData = { ...createBlankLocalData(), gameSetups: { [setup.id]: setup } }
  const history = historyEntry(localData, { ...localData, revision: 1 }, 'import', localData.updatedAt)
  const archived = { version: 1, kind: 'history', key: privateRecordKey('history', history.id), value: history } as unknown as WorkspaceDocument
  const documents = new Map([archived, catalog, imported, composed].map(value => [value.key, value]))
  expect(new Set(resolvedDomainClosureKeys(archived, documents))).toEqual(new Set([catalog.key, imported.key, composed.key]))
  documents.delete(imported.key)
  expect(() => resolvedDomainClosureKeys(archived, documents)).toThrow('unavailable catalog revision')
})
it('retains every explicitly bound original without requiring an artifact or guessing from its digest', async () => {
  const { imported } = await fixture()
  const source = imported.value as unknown as import('../domain/types').CatalogSnapshot
  const original = (id: string, checksum = source.checksum) => ({ version: 1, kind: 'source', key: privateRecordKey('source', id), value: { id, catalogs: [{ id: source.id, revisionId: source.revisionId, checksum }] } }) as unknown as WorkspaceDocument
  const first = original('formatted-one'), second = original('formatted-two'), different = original('different-payload', 'wrong')
  const documents = new Map([imported, first, second, different].map(value => [value.key, value]))
  expect(new Set(resolvedDomainClosureKeys(imported, documents))).toEqual(new Set([first.key, second.key]))
  expect(resolvedDomainClosureKeys(imported, new Map([[imported.key, imported]]))).toEqual([])
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

it('validates a dependent Build separately from its setup-owned imported catalogs', async () => {
  const { document, catalog, setup, receipt } = await fixture()
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

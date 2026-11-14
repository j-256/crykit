import { describe, expect, it } from 'vitest'
import { CURRENT_CATALOG, BUNDLED_CATALOGS } from '../catalog/bundled'
import { createBlankLocalData } from '../domain/local-data'
import { createSampleLocalData } from '../domain/sample-data'
import { createBuild } from '../domain/builds'
import { upsertProgress } from '../domain/characters'
import type { LocalData, CatalogRef } from '../domain/types'
import { createStarterLocalData } from '../persistence/local-data'
import { privateRecordKey, type WorkspaceState } from './documents'
import { editorBlob } from './editor-document'
import { classifySigninLocalData } from './signin-local-data'

function workspace(localData: LocalData = createStarterLocalData()): WorkspaceState {
  return { planner: { localData, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [], lineage: { rootLocalDataId: localData.id } }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
}

// These cases catch sample-tag shortcuts and comparisons against generated IDs instead of semantic content
it('skips empty and untouched starter data across distinct generated identities', () => {
  for (const local of [createBlankLocalData(), createSampleLocalData(CURRENT_CATALOG), createStarterLocalData(), createStarterLocalData()]) {
    expect(classifySigninLocalData(workspace(local))).toMatchObject({ meaningful: false, builds: 0, progress: 0, other: 0, rootKeys: [], reasons: [] })
  }
})

it('ignores timestamps, revision bookkeeping, and device selections', () => {
  const local = createStarterLocalData(), id = Object.keys(local.builds)[0]
  const selected = { ...local, revision: 99, updatedAt: '2030-01-01T00:00:00.000Z' as LocalData['updatedAt'], selectedPlaythroughId: undefined, planningGameSetupRevisionId: undefined, builds: { ...local.builds, [id]: { ...local.builds[id], revision: 15, updatedAt: '2030-01-01T00:00:00.000Z' as LocalData['updatedAt'] } } }
  expect(classifySigninLocalData(workspace(selected)).meaningful).toBe(false)
})

it('recognizes a created Build even when it is tagged sample', () => {
  const starter = createStarterLocalData()
  const local = createBuild(starter, { gameSetupId: Object.values(starter.gameSetups)[0].gameSetupId, title: 'My Build', tags: ['sample'] })
  const id = Object.keys(local.builds).at(-1)!
  expect(classifySigninLocalData(workspace(local))).toMatchObject({ meaningful: true, builds: 1, rootKeys: expect.arrayContaining([privateRecordKey('build', id)]) })
})

it('includes an edited sample Build as a root without losing its sample tag', () => {
  const local = createStarterLocalData(), id = Object.keys(local.builds)[0]
  const edited = { ...local, builds: { ...local.builds, [id]: { ...local.builds[id], title: 'My changed sample' } } }
  const summary = classifySigninLocalData(workspace(edited))
  expect(summary.meaningful).toBe(true)
  expect(summary.builds).toBeGreaterThanOrEqual(1)
  expect(summary.rootKeys).toContain(privateRecordKey('build', id))
  expect(JSON.stringify(summary.reasons)).not.toContain('My changed sample')
})

it('compares samples against their exact retained catalog rather than the latest bundled names', () => {
  const catalog = { ...CURRENT_CATALOG, entities: { ...CURRENT_CATALOG.entities, 'base:job:0': { ...CURRENT_CATALOG.entities['base:job:0'], name: 'Retained class name' } } }
  const state = workspace(createSampleLocalData(catalog))
  expect(classifySigninLocalData({ ...state, planner: { ...state.planner, catalogs: [catalog] } }).meaningful).toBe(false)
})

it('retains sample content when its source catalog identity cannot be proven', () => {
  const state = workspace()
  expect(classifySigninLocalData({ ...state, planner: { ...state.planner, catalogs: [] } }).meaningful).toBe(true)
})

const subject = { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: 'base:job:0' } as CatalogRef

describe('Progress observations', () => {
  it.each(['stage', 'unlocked', 'partyMastery', 'collection', 'masterLocation', 'sources'] as const)('retains a positive or explicit unknown %s observation', field => {
    const local = createStarterLocalData()
    const observation = field === 'stage' ? { stage: { state: 'known', value: 'unlocked' } } : field === 'masterLocation' ? { masterLocation: { state: 'unknown', reason: 'Need to verify' } } : field === 'sources' ? { sources: [{ sourceId: 'personal-note', applicability: 'Check after next fight' }] } : { [field]: { state: 'known', value: true } }
    const next = upsertProgress(local, { subject, displayName: 'Class', ...observation } as Parameters<typeof upsertProgress>[1])
    const playthrough = Object.values(next.playthroughs)[0], id = Object.keys(playthrough.progress)[0]
    expect(classifySigninLocalData(workspace(next))).toMatchObject({ meaningful: true, progress: 1, rootKeys: expect.arrayContaining([privateRecordKey('playthrough', playthrough.id)]), reasons: expect.arrayContaining([expect.objectContaining({ rootKey: privateRecordKey('progress', playthrough.id, id) })]) })
  })
})

it.each(['character', 'inventory', 'scenario', 'setup', 'mod-settings'] as const)('retains changed %s sample data', kind => {
  const local = structuredClone(createStarterLocalData()), playthrough = Object.values(local.playthroughs)[0]
  if (kind === 'character') Object.assign(Object.values(playthrough.characters)[0], { name: 'My character' })
  if (kind === 'inventory') Object.assign(Object.values(playthrough.inventory)[0], { quantity: { kind: 'unknown' }, note: 'Count later' })
  if (kind === 'scenario') Object.assign(Object.values(playthrough.scenarios)[0], { label: 'My draft' })
  if (kind === 'setup') Object.assign(Object.values(local.gameSetups)[0], { label: 'My setup' })
  if (kind === 'mod-settings') Object.assign(local, { modSetup: { version: 1, state: 'completed' } })
  expect(classifySigninLocalData(workspace(local)).meaningful).toBe(true)
})

it('retains imported receipt evidence even when imported Builds look like samples', () => {
  const local = createStarterLocalData()
  const imported = { ...local, importReceipts: { imported: { id: 'imported' as LocalData['importReceipts'][string]['id'], sourceFormat: 'native', sourceIdentity: 'synthetic-import', importedAt: local.createdAt, localDataRevision: 0 } } }
  expect(classifySigninLocalData(workspace(imported))).toMatchObject({ meaningful: true, rootKeys: expect.arrayContaining([privateRecordKey('import-receipt', 'imported')]) })
})

it('retains file content and invalid unfinished drafts without opening their bodies', async () => {
  const state = workspace(createBlankLocalData()), body = await editorBlob(new TextEncoder().encode('{ invalid'), 'utf8')
  const file = { version: 1, id: 'editor', revision: 1, filename: 'synthetic.json', referenceId: '', original: body.ref, originalByteIdentity: 'exact', lastApplied: body.ref, unfinished: { text: body.ref, editedPath: [], fieldState: null, baseRevision: 1, validation: 'invalid' }, createdAt: state.planner.localData.createdAt, updatedAt: state.planner.localData.updatedAt } as const
  expect(classifySigninLocalData({ ...state, editorDocuments: [file], blobs: [{ ...body, content: { byteLength: body.content.byteLength, open() { throw new Error('Classifier must not read content') } } }] })).toMatchObject({ meaningful: true, other: expect.any(Number), rootKeys: expect.arrayContaining([privateRecordKey('editor', file.id)]) })
})

it.each(['conflict', 'retained-content'] as const)('retains %s roots', kind => {
  const state = workspace(createBlankLocalData()), ref = { documentId: 'synthetic', revisionId: 'synthetic', byteLength: 0, sha256: '0'.repeat(64), encoding: 'bytes' as const }, closure = { version: 1 as const, root: ref, index: ref }
  const conflict = { version: 1 as const, id: 'conflict', unit: { kind: 'record' as const, privateKey: privateRecordKey('build', 'synthetic') }, commonAncestor: { kind: 'absent' as const }, branches: [{ role: 'local-pending' as const, closure }, { role: 'accepted-cloud' as const, closure }] as const, disposition: { kind: 'unresolved' as const } }
  const retained = { version: 1 as const, kind: 'pending-content' as const, id: 'draft', groupId: 'draft', unit: conflict.unit, base: conflict.commonAncestor, target: closure }
  const next = kind === 'conflict' ? { ...state, conflicts: [conflict] } : { ...state, retainedContent: [retained] }
  expect(classifySigninLocalData(next)).toMatchObject({ meaningful: true, rootKeys: expect.arrayContaining([privateRecordKey(kind, kind === 'conflict' ? 'conflict' : 'draft')]) })
})

it('is deterministic without mutating the workspace or depending on map insertion order', () => {
  const local = createStarterLocalData(), state = workspace(local), before = structuredClone(local)
  const first = classifySigninLocalData(state), second = classifySigninLocalData(state)
  const reordered = { ...local, builds: Object.fromEntries(Object.entries(local.builds).reverse()), playthroughs: Object.fromEntries(Object.entries(local.playthroughs).map(([id, playthrough]) => [id, { ...playthrough, characters: Object.fromEntries(Object.entries(playthrough.characters).reverse()) }])) }
  expect(first).toEqual(second)
  expect(classifySigninLocalData(workspace(reordered)).meaningful).toBe(false)
  expect(local).toEqual(before)
})

it('retains changed sample checkpoint content and reassigned generated identities', () => {
  for (const change of ['content', 'association'] as const) {
    const local = structuredClone(createStarterLocalData()), revisions = Object.values(local.buildRevisions)
    if (change === 'content') Object.assign(revisions[0].content, { secondaryClass: subject })
    else Object.assign(revisions[0], { buildId: revisions[1].buildId })
    const summary = classifySigninLocalData(workspace(local))
    expect(summary.rootKeys).toContain(privateRecordKey('build', revisions[0].buildId))
    expect(summary.reasons).toContainEqual({ category: 'builds', code: 'build-checkpoint', rootKey: privateRecordKey('build-checkpoint', revisions[0].id) })
  }
})

it('retains additional mod catalogs and library layers around untouched starter records', () => {
  const state = workspace(), mod = { ...CURRENT_CATALOG, id: 'synthetic-mod', revisionId: 'synthetic-mod-revision' } as typeof CURRENT_CATALOG
  const summary = classifySigninLocalData({ ...state, planner: { ...state.planner, catalogs: [...state.planner.catalogs, mod] }, libraryDefaults: { version: 1, layers: [{ catalogId: mod.id, catalogRevisionId: mod.revisionId, enabled: true }] } })
  expect(summary.rootKeys).toContain(privateRecordKey('catalog', mod.id, mod.revisionId))
  expect(summary.rootKeys).toContain(privateRecordKey('library-defaults'))
})

it.each(['inventory', 'character'] as const)('retains added and changed %s observation times', kind => {
  const local = structuredClone(createStarterLocalData()), playthrough = Object.values(local.playthroughs)[0]
  const character = Object.values(playthrough.characters)[0]
  const observation = kind === 'inventory' ? Object.values(playthrough.inventory)[0] : Object.values(character.snapshots)[0]
  expect(classifySigninLocalData(workspace(local)).meaningful).toBe(false)
  for (const observedAt of [local.createdAt, '2026-11-14T04:05:06.000Z']) {
    Object.assign(observation, { observedAt })
    const summary = classifySigninLocalData(workspace(local))
    expect(summary.meaningful).toBe(true)
    expect(summary.rootKeys).toContain(privateRecordKey('playthrough', playthrough.id))
    expect(summary.reasons).toContainEqual({ category: 'other', code: kind, rootKey: kind === 'inventory' ? privateRecordKey('inventory', playthrough.id) : privateRecordKey('character', playthrough.id, character.id) })
  }
})

it('retains changed Character recording provenance while ignoring untouched constructor recordings', () => {
  const local = structuredClone(createStarterLocalData()), playthrough = Object.values(local.playthroughs)[0], character = Object.values(playthrough.characters)[0]
  const snapshot = Object.values(character.snapshots)[0]
  expect(snapshot.recordedAt).toBe(local.createdAt)
  expect(classifySigninLocalData(workspace(local)).meaningful).toBe(false)
  Object.assign(snapshot, { recordedAt: '2026-11-14T04:05:06.000Z' })
  const summary = classifySigninLocalData(workspace(local))
  expect(summary.meaningful).toBe(true)
  expect(summary.rootKeys).toContain(privateRecordKey('playthrough', playthrough.id))
  expect(summary.reasons).toContainEqual({ category: 'other', code: 'character', rootKey: privateRecordKey('character', playthrough.id, character.id) })
})

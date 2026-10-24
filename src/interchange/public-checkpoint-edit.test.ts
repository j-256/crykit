import { expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { addTestBuild, addTestDefinition, createTestLocalData, personalRef, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import { defaultCalculation } from '../domain/calculation-plan'
import { defaultBattleCalculation } from '../domain/battle-plan'
import type { WorkspaceState } from '../workspace/documents'
import { createPublicSnapshot } from './public-share'
import { preparePublicSnapshotCopy } from './public-share-enrichment'
import { editCopiedCheckpoint, type CopiedCheckpointRef } from './public-checkpoint-edit'
import { validateNativeLocalDataGraph } from './native'

function fixture(kind: 'build' | 'team', personal = false) {
  let localData = createTestLocalData()
  const setup = localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  localData = { ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: { ...setup, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId } } } }
  if (personal) localData = addTestDefinition(localData, 'own-sword')
  const ref = personal ? personalRef('own-sword') : { kind: 'catalog' as const, catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: Object.values(CURRENT_CATALOG.entities).find(entity => entity.name === 'Broadsword')!.id }
  localData = addTestBuild(localData, 'Source', '', { hand: { ref } })
  const revision = localData.buildRevisions['Source-revision']!
  localData = { ...localData, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, rotationNotes: 'Original rotation', contextAssumptions: ['Original assumption'], calculation: { ...defaultCalculation(null, 7), level: 7, battle: { ...defaultBattleCalculation(), turnCount: 2, targetTurnCount: 3 } } } } } }
  const before: WorkspaceState = { planner: { localData, catalogs: [CURRENT_CATALOG], lineage: { rootLocalDataId: localData.id }, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], blobs: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
  const source = createPublicSnapshot(before, { kind: 'build', revisionId: revision.id }, { includeNotes: true })
  const snapshot = kind === 'build' ? source : { ...source, kind, slots: [source.slots[0]!, null, null, null], notes: { checkpoint: 'Original Team note', slots: [source.notes!.slots[0]!, null, null, null] } }
  const copied = preparePublicSnapshotCopy(before, snapshot)
  const data = copied.state.planner.localData
  const copiedRef: CopiedCheckpointRef = copied.result.buildId ? { kind: 'build', revisionId: data.builds[copied.result.buildId]!.latestRevisionId! } : { kind: 'team', revisionId: (data.teams[copied.result.teamId!]! as import('../domain/types').SharedTeam).latestRevisionId }
  const checkpoint = copiedRef.kind === 'build' ? data.buildRevisions[copiedRef.revisionId]! : data.teamRevisions[copiedRef.revisionId]!
  return { state: copied.state, copiedRef, checkpoint, setup }
}

for (const kind of ['build', 'team'] as const) {
  it(`adds exact-context ${kind} notes and adapts to an available local setup without rewriting the source`, () => {
    const { state, copiedRef, checkpoint, setup } = fixture(kind)
    const original = structuredClone(state.planner.localData)
    const notes = { ...(kind === 'team' ? { checkpoint: 'My Team note' } : {}), slots: [{ rotationNotes: 'My rotation', contextAssumptions: ['My assumption'], checkpoint: 'My checkpoint' }, ...(kind === 'team' ? [null, null, null] : [])] }
    const edited = editCopiedCheckpoint(state, { checkpoint: copiedRef, notes })
    const saved = edited.checkpoint.kind === 'build' ? edited.localData.buildRevisions[edited.checkpoint.revisionId]! : edited.localData.teamRevisions[edited.checkpoint.revisionId]!
    expect(saved.publicSourceContext).toEqual(checkpoint.publicSourceContext)
    expect(edited.localData.gameSetups).toEqual(original.gameSetups)
    expect('slots' in saved ? saved.slots[0]!.content.rotationNotes : saved.content.rotationNotes).toBe('My rotation')
    expect(saved.note).toBe(kind === 'team' ? 'My Team note' : 'My checkpoint')
    expect(() => validateNativeLocalDataGraph(edited.localData, state.planner.catalogs)).not.toThrow()
    const nextState = { ...state, planner: { ...state.planner, localData: edited.localData } }
    const adapted = editCopiedCheckpoint(nextState, { checkpoint: edited.checkpoint, gameSetupRevisionId: setup.id })
    const next = adapted.checkpoint.kind === 'build' ? adapted.localData.buildRevisions[adapted.checkpoint.revisionId]! : adapted.localData.teamRevisions[adapted.checkpoint.revisionId]!
    expect(next.publicSourceContext).toBeUndefined()
    expect(next.gameSetupRevisionId).toBe(setup.id)
    const content = 'slots' in next ? next.slots[0]!.content : next.content
    expect(content).toMatchObject({ rotationNotes: 'My rotation', contextAssumptions: ['My assumption'], calculation: { level: 7, battle: { turnCount: 2, targetTurnCount: 3 } } })
    expect(adapted.localData.buildRevisions['Source-revision']).toEqual(original.buildRevisions['Source-revision'])
    expect(copiedRef.kind === 'build' ? adapted.localData.buildRevisions[copiedRef.revisionId] : adapted.localData.teamRevisions[copiedRef.revisionId]).toEqual(checkpoint)
    expect(adapted.localData.gameSetups).toEqual(original.gameSetups)
    expect(adapted.localData.playthroughs).toEqual(original.playthroughs)
    expect(() => validateNativeLocalDataGraph(adapted.localData, state.planner.catalogs)).not.toThrow()
    expect(state.planner.localData).toEqual(original)
  })
}
it('maps exact owned personal fingerprints and refuses unavailable sources or a public target setup', () => {
  const { state, copiedRef, checkpoint, setup } = fixture('build', true)
  const adapted = editCopiedCheckpoint(state, { checkpoint: copiedRef, gameSetupRevisionId: setup.id })
  if (adapted.checkpoint.kind !== 'build') throw new Error('Expected a Build')
  expect(adapted.localData.buildRevisions[adapted.checkpoint.revisionId]!.content.equipment.hand!.ref).toEqual(personalRef('own-sword'))
  const missing = { ...state, planner: { ...state.planner, localData: { ...state.planner.localData, personalDefinitions: {} } } }
  expect(() => editCopiedCheckpoint(missing, { checkpoint: copiedRef, gameSetupRevisionId: setup.id })).toThrow(/matching|available/i)
  expect(() => editCopiedCheckpoint(state, { checkpoint: copiedRef, gameSetupRevisionId: checkpoint.gameSetupRevisionId })).toThrow(/local setup/i)
  const native = fixture('build')
  expect(() => editCopiedCheckpoint({ ...native.state, planner: { ...native.state.planner, catalogs: [] } }, { checkpoint: native.copiedRef, gameSetupRevisionId: native.setup.id })).toThrow(/matching|available/i)
})

it('uses catalog identity fields independently of persisted object property order', () => {
  const { state, copiedRef, checkpoint, setup } = fixture('build')
  if ('slots' in checkpoint) throw new Error('Expected a Build')
  const selection = checkpoint.content.equipment.hand!, ref = selection.ref
  if (ref.kind !== 'catalog') throw new Error('Expected a catalog selection')
  const reordered = { entityId: ref.entityId, catalogRevisionId: ref.catalogRevisionId, catalogId: ref.catalogId, kind: ref.kind }
  const data = state.planner.localData
  const changed = { ...state, planner: { ...state.planner, localData: { ...data, buildRevisions: { ...data.buildRevisions, [checkpoint.id]: { ...checkpoint, content: { ...checkpoint.content, equipment: { ...checkpoint.content.equipment, hand: { ...selection, ref: reordered } } } } } } } }
  const adapted = editCopiedCheckpoint(changed, { checkpoint: copiedRef, gameSetupRevisionId: setup.id })
  expect(() => validateNativeLocalDataGraph(adapted.localData, state.planner.catalogs)).not.toThrow()
})

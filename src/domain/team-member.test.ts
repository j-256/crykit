import { describe, expect, it } from 'vitest'
import { asId } from './core'
import { buildBehavior } from './build-behavior'
import { addGameSetupRevision } from './local-data'
import { defaultCalculation } from './calculation-plan'
import { composeModCatalog, composeModLayers, modCatalogRevision } from './mod-layers'
import { syntheticModLayers } from './mod-layers.test-helpers'
import { saveTeam } from './teams'
import { saveTeamMember } from './team-member'
import { addTestBuild, createTestLocalData, HAND_SLOT, TEST_NOW } from './test-helpers'
import type { BuildId, BuildRevisionId, CatalogRef, EntityId, GameSetupRevisionId, TeamId } from './types'
import { validateNativeLocalDataGraph } from '../interchange/native'

const sourceId = asId<BuildRevisionId>('member-revision')
const nextId = asId<BuildRevisionId>('member-next')
const teamId = asId<TeamId>('team')
function fixture() {
  const data = addTestBuild(createTestLocalData(), 'member', '', {})
  const source = data.buildRevisions[sourceId]!
  const revision = { ...source.content, behavior: buildBehavior(data.gameSetups[source.gameSetupRevisionId]!) }
  return { data, source, revision }
}

describe('atomic Team member candidate', () => {
  it('creates a Build and assigns only the chosen slot without changing tracking', () => {
    const { data, revision } = fixture()
    const buildId = asId<BuildId>('new-member')
    const next = saveTeamMember(data, { team: { id: teamId, title: 'Synthetic Team', slots: [sourceId, null, null, null], now: TEST_NOW }, slotIndex: 1, build: { id: buildId, revisionId: nextId, title: 'New member', tags: [] }, revision, revisionId: nextId, expectedRevision: data.revision }, [])
    expect(next.teams[teamId]!.slots).toEqual([sourceId, nextId, null, null])
    expect(next.builds[buildId]!.latestRevisionId).toBe(nextId)
    expect(next.playthroughs).toBe(data.playthroughs)
    expect(data.builds[buildId]).toBeUndefined()
    validateNativeLocalDataGraph(next, [])
  })

  it('edits from the selected checkpoint and preserves other slots and Teams', () => {
    const { data, source, revision } = fixture()
    const saved = saveTeam(data, { id: teamId, title: 'Synthetic Team', slots: [sourceId, sourceId, null, null], now: TEST_NOW })
    const otherId = asId<TeamId>('other-team')
    const before = saveTeam(saved, { id: otherId, title: 'Other Team', slots: [sourceId, null, null, null], now: TEST_NOW })
    const next = saveTeamMember(before, { team: { ...before.teams[teamId]!, title: 'Renamed Team', now: TEST_NOW }, slotIndex: 0, sourceRevisionId: sourceId, revision: { ...revision, rotationNotes: 'New plan' }, revisionId: nextId }, [])
    expect(next.teams[teamId]!.slots).toEqual([nextId, sourceId, null, null])
    expect(next.teams[otherId]).toBe(before.teams[otherId])
    expect(next.buildRevisions[sourceId]).toBe(source)
    expect(next.buildRevisions[nextId]!.parentRevisionId).toBe(sourceId)
    expect(next.buildRevisions[nextId]!.content.rotationNotes).toBe('New plan')
    validateNativeLocalDataGraph(next, [])
  })

  it('rejects an invalid Team after draft creation without mutating the original state', () => {
    const { data, revision } = fixture()
    const original = structuredClone(data)
    expect(() => saveTeamMember(data, { team: { id: teamId, title: '', slots: [null, null, null, null] }, slotIndex: 0, build: { id: asId<BuildId>('new-member'), revisionId: nextId, title: 'New member', tags: [] }, revision, revisionId: nextId }, [])).toThrow('nonempty')
    expect(data).toEqual(original)
  })

  it('rebinds member selections to a reused mod setup while keeping prior checkpoints and failed candidates unchanged', async () => {
    const { data, source, revision } = fixture()
    const { catalogs, composition } = await syntheticModLayers()
    const setupId = asId<GameSetupRevisionId>('saved-member-mod-setup')
    const before = addGameSetupRevision(data, { ...revision.behavior, id: setupId, label: 'Synthetic member mod setup', modComposition: composition, activate: false, now: TEST_NOW })
    const setup = before.gameSetups[setupId]!
    const draftId = asId<GameSetupRevisionId>('member-draft-setup')
    const draftPin = modCatalogRevision(draftId)
    const behavior = { ...buildBehavior(setup), catalogLock: { ...setup.catalogLock, [composition.baseline.catalogId]: draftPin } }
    const effective = composeModLayers(composition, catalogs)
    const ref = (modelKey: string): CatalogRef => ({ kind: 'catalog', catalogId: composition.baseline.catalogId, catalogRevisionId: draftPin, entityId: effective.identities[modelKey]! as EntityId })
    const primaryClass = ref('crystal-edit:Jobs:0')
    const content = { ...revision, behavior, behaviorRevisionId: draftId, primaryClass, secondaryClass: primaryClass, equipment: { [HAND_SLOT]: { ref: ref('crystal-edit:Equipment:50'), observedName: 'Retained item label' } }, passives: [{ ref: ref('crystal-edit:Passives:2') }], calculation: defaultCalculation(primaryClass) }
    const input = { team: { id: teamId, title: 'Synthetic mod Team', slots: [sourceId, sourceId, null, null], now: TEST_NOW }, slotIndex: 0, sourceRevisionId: sourceId, revision: content, revisionId: nextId }
    const original = structuredClone(before)
    expect(() => saveTeamMember(before, { ...input, team: { ...input.team, title: '' } }, catalogs)).toThrow('nonempty')
    expect(before).toEqual(original)
    const next = saveTeamMember(before, input, catalogs)
    const saved = next.buildRevisions[nextId]!
    const pinned = (reference: CatalogRef) => ({ ...reference, catalogRevisionId: setup.catalogLock[reference.catalogId] })
    expect(saved.gameSetupRevisionId).toBe(setupId)
    expect(next.gameSetups).toBe(before.gameSetups)
    expect(saved.content.primaryClass).toEqual(pinned(primaryClass))
    expect(saved.content.secondaryClass).toEqual(pinned(primaryClass))
    expect(saved.content.equipment[HAND_SLOT]).toEqual({ ...content.equipment[HAND_SLOT], ref: pinned(content.equipment[HAND_SLOT].ref) })
    expect(saved.content.passives).toEqual(content.passives.map(selection => ({ ...selection, ref: pinned(selection.ref) })))
    expect(saved.content.calculation!.growth).toEqual(content.calculation.growth.map(row => ({ ...row, classRef: pinned(primaryClass) })))
    expect(next.teams[teamId]!.slots).toEqual([nextId, sourceId, null, null])
    expect(next.buildRevisions[sourceId]).toBe(source)
    expect(next.playthroughs).toBe(before.playthroughs)
    expect(content.primaryClass.catalogRevisionId).toBe(draftPin)
    validateNativeLocalDataGraph(next, [...catalogs, composeModCatalog(setup, catalogs)!])
  })

  it('rejects stale state, unavailable checkpoints, and out-of-range slots', () => {
    const { data, revision } = fixture()
    const input = { team: { id: teamId, title: 'Synthetic Team', slots: [null, null, null, null] }, slotIndex: 0, sourceRevisionId: sourceId, revision, revisionId: nextId }
    expect(() => saveTeamMember(data, { ...input, expectedRevision: data.revision - 1 }, [])).toThrow()
    expect(() => saveTeamMember(data, { ...input, sourceRevisionId: asId<BuildRevisionId>('missing') }, [])).toThrow('unavailable')
    expect(() => saveTeamMember(data, { ...input, slotIndex: 4 }, [])).toThrow('available Team slot')
  })
})

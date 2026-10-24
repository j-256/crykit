import { describe, expect, it } from 'vitest'
import { asId } from './core'
import { buildBehavior } from './build-behavior'
import { addGameSetupRevision } from './local-data'
import { defaultCalculation } from './calculation-plan'
import { composeModCatalog, composeModLayers, modCatalogRevision } from './mod-layers'
import { syntheticModLayers } from './mod-layers.test-helpers'
import { saveTeam } from './teams'
import { saveTeamMember } from './team-member'
import { updateBuild } from './builds'
import { teamSlots } from './team-checkpoints'
import { addTestBuild, createTestLocalData, HAND_SLOT, TEST_NOW } from './test-helpers'
import type { BuildId, BuildRevisionId, CatalogRef, EntityId, GameSetupRevisionId, LocalData, TeamId } from './types'
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

function owned(data: LocalData) {
  const team = data.teams[teamId]!
  if (team.kind !== 'shared') throw new Error('Expected shared Team')
  return data.teamRevisions[team.latestRevisionId]!
}

describe('atomic Team member candidate', () => {
  it('creates a Team-owned slot without creating a Build or changing tracking', () => {
    const { data, revision } = fixture()
    const buildId = asId<BuildId>('new-member')
    const next = saveTeamMember(data, { team: { id: teamId, title: 'Synthetic Team', slots: [sourceId, null, null, null], now: TEST_NOW }, slotIndex: 1, build: { id: buildId, revisionId: nextId, title: 'New member', tags: [] }, revision, revisionId: nextId, expectedRevision: data.revision }, [])
    expect(owned(next).slots.map(slot => slot?.sourceBuildRevisionId ?? null)).toEqual([sourceId, null, null, null])
    expect(owned(next).slots[1]!.content).toEqual(data.buildRevisions[sourceId]!.content)
    expect(owned(next).slots[1]!.name).toBe('New member')
    expect(next.builds).toEqual(data.builds)
    expect(next.buildRevisions).toEqual(data.buildRevisions)
    expect(next.playthroughs).toBe(data.playthroughs)
    expect(data.builds[buildId]).toBeUndefined()
    validateNativeLocalDataGraph(next, [])
  })

  it('edits from the selected checkpoint and preserves other slots and Teams', () => {
    const { data, source, revision } = fixture()
    const saved = saveTeam(data, { id: teamId, title: 'Synthetic Team', slots: [sourceId, sourceId, null, null], now: TEST_NOW })
    const otherId = asId<TeamId>('other-team')
    const before = saveTeam(saved, { id: otherId, title: 'Other Team', slots: [sourceId, null, null, null], now: TEST_NOW })
    const next = saveTeamMember(before, { team: { ...before.teams[teamId]!, slots: teamSlots(before, before.teams[teamId]!), title: 'Renamed Team', now: TEST_NOW }, slotIndex: 0, sourceRevisionId: sourceId, revision: { ...revision, rotationNotes: 'New plan' }, revisionId: nextId }, [])
    expect(owned(next).slots.map(slot => slot?.sourceBuildRevisionId ?? null)).toEqual([sourceId, sourceId, null, null])
    expect(next.teams[otherId]).toBe(before.teams[otherId])
    expect(next.buildRevisions[sourceId]).toBe(source)
    expect(owned(next).parentRevisionId).toBe(owned(before).id)
    expect(owned(next).slots[0]!.content.rotationNotes).toBe('New plan')
    expect(owned(next).slots[1]).toEqual(owned(before).slots[1])
    expect(next.buildRevisions).toEqual(before.buildRevisions)
    validateNativeLocalDataGraph(next, [])
  })

  it('owns an editable member name without changing source Build metadata or checkpoints', () => {
    const { data, source, revision } = fixture()
    const tagged = updateBuild(data, { buildId: source.buildId, tags: ['Frontline'], favorite: true, now: TEST_NOW })
    const otherId = asId<TeamId>('other-team')
    const before = saveTeam(tagged, { id: otherId, title: 'Other Team', slots: [sourceId, null, null, null], now: TEST_NOW })
    const original = structuredClone(before)
    const next = saveTeamMember(before, { team: { id: teamId, title: 'Synthetic Team', slots: [sourceId, sourceId, null, null], now: TEST_NOW }, slotIndex: 0, sourceRevisionId: sourceId, buildTitle: '  Renamed member  ', revision, revisionId: nextId }, [])
    expect(next.builds).toEqual(before.builds)
    expect(owned(next).slots.map(slot => slot?.sourceBuildRevisionId ?? null)).toEqual([sourceId, sourceId, null, null])
    expect(next.teams[otherId]).toBe(before.teams[otherId])
    expect(next.buildRevisions[sourceId]).toBe(source)
    expect(owned(next).slots[0]!.content).toEqual(source.content)
    expect(owned(next).slots[0]!.name).toBe('Renamed member')
    expect(owned(next).slots[1]!.name).toBe(before.builds[source.buildId]!.title)
    expect(next.buildRevisions).toEqual(before.buildRevisions)
    expect(next.playthroughs).toBe(before.playthroughs)
    expect(before).toEqual(original)
    validateNativeLocalDataGraph(next, [])
    const renamed = saveTeamMember(next, { team: { ...next.teams[teamId]!, slots: teamSlots(next, next.teams[teamId]!), now: TEST_NOW }, slotIndex: 0, sourceRevisionId: teamSlots(next, next.teams[teamId]!)[0]!, buildTitle: 'Aster', revision, revisionId: nextId }, [])
    expect(owned(renamed).slots[0]!.name).toBe('Aster')
    expect(renamed.teamRevisions[owned(next).id]).toBe(owned(next))
    expect(renamed.builds).toEqual(before.builds)
    expect(renamed.buildRevisions).toEqual(before.buildRevisions)
  })

  it('rejects failed Team candidates without changing saved names', () => {
    const { data, revision } = fixture()
    const original = structuredClone(data)
    const input = { team: { id: teamId, title: 'Synthetic Team', slots: [sourceId, null, null, null], now: TEST_NOW }, slotIndex: 0, sourceRevisionId: sourceId, revision, revisionId: nextId }
    expect(() => saveTeamMember(data, { ...input, buildTitle: 'Renamed member', team: { ...input.team, title: '' } }, [])).toThrow('nonempty')
    expect(data).toEqual(original)
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
    const saved = { ...owned(next), content: owned(next).slots[0]!.content }
    const pinned = (reference: CatalogRef) => ({ ...reference, catalogRevisionId: setup.catalogLock[reference.catalogId] })
    expect(saved.gameSetupRevisionId).toBe(setupId)
    expect(next.gameSetups).toBe(before.gameSetups)
    expect(saved.content.primaryClass).toEqual(pinned(primaryClass))
    expect(saved.content.secondaryClass).toEqual(pinned(primaryClass))
    expect(saved.content.equipment[HAND_SLOT]).toEqual({ ...content.equipment[HAND_SLOT], ref: pinned(content.equipment[HAND_SLOT].ref) })
    expect(saved.content.passives).toEqual(content.passives.map(selection => ({ ...selection, ref: pinned(selection.ref) })))
    expect(saved.content.calculation!.growth).toEqual(content.calculation.growth.map(row => ({ ...row, classRef: pinned(primaryClass) })))
    expect(owned(next).slots.map(slot => slot?.sourceBuildRevisionId ?? null)).toEqual([sourceId, sourceId, null, null])
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

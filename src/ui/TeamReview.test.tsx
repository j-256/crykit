import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { asId, saveBuildRevision } from '../domain'
import { addTestBuild, addTestDefinition, createTestLocalData, HAND_SLOT, known, personalRef, SECOND_HAND_SLOT, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import type { BuildRevisionId } from '../domain/types'
import { newerTeamCheckpoint, reviewTeam, TeamReview } from './TeamReview'

describe('Team review', () => {
  it('keeps a partial draft separate from the validity of its selected checkpoint', () => {
    const data = addTestBuild(createTestLocalData(), 'draft', '', {})
    const slots = [asId<BuildRevisionId>('draft-revision'), null, null, null]
    expect(reviewTeam(slots, data, [])).toMatchObject({ filled: 1, classesSelected: 0, valid: 1, invalid: 0, unresolved: 0 })
    const markup = renderToStaticMarkup(<TeamReview catalogs={[]} localData={data} saved slots={slots}/>)
    expect(markup).toContain('Saved draft Team')
    expect(markup).toContain('1/4 slots filled')
    expect(markup).toContain('member still needs')
    expect(markup).toContain("Teams can be saved with empty slots.")
  })

  it('counts both hands occupied by a two-handed weapon while retaining unresolved checks', () => {
    let data = addTestDefinition(addTestDefinition(addTestDefinition(createTestLocalData(), 'caster', { kind: 'class' }), 'staff'), 'uncertain-passive', { kind: 'passive', ppCost: { state: 'unknown' } })
    const setup = data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    data = {
      ...data,
      gameSetups: { ...data.gameSetups, [setup.id]: { ...setup, slots: setup.slots.map((slot, index) => ({ ...slot, equipmentRole: index === 0 ? 'mainHand' : 'offHand' })) } },
      personalDefinitions: { ...data.personalDefinitions, staff: { ...data.personalDefinitions.staff!, fields: { Category: known(['Staves']), Hands: known(2) } } },
    }
    data = addTestBuild(data, 'caster-build', '', { [HAND_SLOT]: { ref: personalRef('staff') } }, { primaryClass: personalRef('caster'), passives: [{ ref: personalRef('uncertain-passive') }] })
    const id = asId<BuildRevisionId>('caster-build-revision')
    expect(reviewTeam([id, id, id, id], data, [])).toMatchObject({ filled: 4, classesSelected: 4, unresolved: 4, emptyEquipment: [] })
    const conflicted = saveBuildRevision(data, { buildId: data.buildRevisions[id]!.buildId, gameSetupRevisionId: setup.id, content: { ...data.buildRevisions[id]!.content, equipment: { [HAND_SLOT]: { ref: personalRef('staff') }, [SECOND_HAND_SLOT]: { ref: personalRef('staff') } } } })
    const newest = conflicted.builds[data.buildRevisions[id]!.buildId]!.latestRevisionId!
    expect(reviewTeam([newest, null, null, null], conflicted, [])).toMatchObject({ filled: 1, classesSelected: 1, invalid: 1 })
  })

  it('does not label a fully assigned Team as a draft for intentional empty equipment', () => {
    let data = addTestDefinition(createTestLocalData(), 'caster', { kind: 'class' })
    data = addTestBuild(data, 'caster-build', '', {}, { primaryClass: personalRef('caster') })
    const id = asId<BuildRevisionId>('caster-build-revision')
    const markup = renderToStaticMarkup(<TeamReview catalogs={[]} localData={data} saved slots={[id, id, id, id]}/>)
    expect(markup).toContain('Saved Team')
    expect(markup).not.toContain('draft Team')
    expect(markup).not.toContain('still needs')
    expect(markup).toContain('No known build issues')
    expect(markup).toContain('Slot 4:')
    expect(markup).toContain('Review empty equipment slots')
  })

  it('announces a newer checkpoint without changing the pinned Team slot', () => {
    const original = addTestBuild(createTestLocalData(), 'member', '', {})
    const revision = original.buildRevisions['member-revision']!
    const data = saveBuildRevision(original, { buildId: revision.buildId, gameSetupRevisionId: revision.gameSetupRevisionId, content: { ...revision.content, rotationNotes: 'Changed plan' } })
    const slots = [revision.id, revision.id, null, null]
    expect(newerTeamCheckpoint(data, revision)?.revision).toBe(2)
    expect(reviewTeam(slots, data, [])).toMatchObject({ filled: 2, newer: 2 })
    expect(slots).toEqual([revision.id, revision.id, null, null])
    expect(data.buildRevisions[revision.id]).toEqual(original.buildRevisions[revision.id])
  })
})

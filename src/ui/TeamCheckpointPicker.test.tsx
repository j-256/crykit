import { describe, expect, it } from 'vitest'
import { saveBuildRevision } from '../domain'
import { addTestBuild, addTestDefinition, createTestLocalData, HAND_SLOT, known, personalRef } from '../domain/test-helpers'
import { teamCheckpointOptions } from './TeamCheckpointPicker'

describe('Team checkpoint choices', () => {
  it('describes each pinned revision using its own classes and equipment', () => {
    let data = addTestDefinition(createTestLocalData(), 'caster', { kind: 'class' })
    data = { ...data, personalDefinitions: { ...data.personalDefinitions, caster: { ...data.personalDefinitions.caster!, fields: { Command: known('Prayer') } } } }
    data = addTestDefinition(data, 'staff')
    data = addTestBuild(data, 'caster-build', 'Dawn Keeper', { [HAND_SLOT]: { ref: personalRef('staff') } }, { primaryClass: personalRef('caster'), secondaryClass: personalRef('caster') })
    const original = data.buildRevisions['caster-build-revision']!
    data = saveBuildRevision(data, { buildId: original.buildId, gameSetupRevisionId: original.gameSetupRevisionId, content: { ...original.content, equipment: {} }, note: 'Unarmed option' })
    const options = teamCheckpointOptions(data, [], original.id)
    expect(options).toHaveLength(2)
    expect(options[0]).toMatchObject({ revision: { revision: 2 }, equipment: [], command: 'Prayer (caster)' })
    expect(options[0]!.search).toContain('unarmed option')
    expect(options[1]).toMatchObject({ revision: { id: original.id }, equipment: ['Hand: staff'] })
    expect(data.buildRevisions[original.id]).toEqual(original)
  })

  it('distinguishes tagged samples and retains only the selected checkpoint of an archived build', () => {
    let data = addTestBuild(addTestBuild(createTestLocalData(), 'sample', 'Sample', {}), 'personal', 'Personal', {})
    const sample = data.builds.sample!
    data = { ...data, builds: { ...data.builds, sample: { ...sample, tags: ['sample'] }, personal: { ...data.builds.personal!, archived: true } } }
    expect(teamCheckpointOptions(data, [], null).map(option => [option.title, option.sample])).toEqual([['sample', true]])
    const retained = teamCheckpointOptions(data, [], data.buildRevisions['personal-revision']!.id)
    expect(retained.map(option => option.title)).toEqual(['personal', 'sample'])
    expect(retained[0]!.archived).toBe(true)
  })
})

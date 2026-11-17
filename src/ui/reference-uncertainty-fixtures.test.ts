import { describe, expect, it } from 'vitest'
import { REFERENCE_UNCERTAINTY_CATALOG, REFERENCE_UNCERTAINTY_ENTITIES, RETAINED_STUDY_SOURCES } from '../../e2e/reference-uncertainty-fixtures'
import { sourcePayloadValid } from '../domain/source-fulfillment'
import { skillAcceptsWeapon, skillWeaponRule } from '../domain/skill-weapons'
import { buildReferenceSearchItems, partitionReferenceItems } from './search'

describe('independent browser uncertainty sources', () => {
  it('admits the complete body and rejects changed attributed content with the original checksum', () => {
    expect(sourcePayloadValid(REFERENCE_UNCERTAINTY_CATALOG)).toBe(true)
    const study = REFERENCE_UNCERTAINTY_ENTITIES.study
    expect(sourcePayloadValid({ ...REFERENCE_UNCERTAINTY_CATALOG, entities: { ...REFERENCE_UNCERTAINTY_CATALOG.entities, [study.id]: { ...study, name: study.name.replace('study', 'Study') } } })).toBe(false)
    expect(REFERENCE_UNCERTAINTY_CATALOG.id).toMatch(/^crystal-project\/imported\//)
    expect(new Set(RETAINED_STUDY_SOURCES.map(source => source.sourceId)).size).toBe(RETAINED_STUDY_SOURCES.length)
    expect(study.fields.Duration).toMatchObject({ state: 'unknown' })
    for (const source of RETAINED_STUDY_SOURCES) expect(source.locator).toContain('missing HP')
  })

  it('keeps unknown and contradictory weapon requirements possible, never confirmed', () => {
    const { unknownSkill, conflictingSkill } = REFERENCE_UNCERTAINTY_ENTITIES
    expect(skillWeaponRule(unknownSkill)).toMatchObject({ state: 'unknown' })
    const rule = skillWeaponRule(conflictingSkill)
    expect(rule).toMatchObject({ state: 'conflicting', claims: [{ value: { weapons: ['Dagger'] } }, { value: { weapons: ['Bow'] } }] })
    expect(skillAcceptsWeapon(rule, 'Dagger')).toMatchObject({ state: 'conflicting', claims: [{ value: true }, { value: false }] })
    const partition = partitionReferenceItems(buildReferenceSearchItems([REFERENCE_UNCERTAINTY_CATALOG]), { query: '', kinds: [], categories: [], sources: [], weapon: 'Dagger' })
    expect(partition.confirmed).toEqual([])
    expect(partition.possible.map(item => item.entity.id).sort()).toEqual([unknownSkill.id, conflictingSkill.id].sort())
    expect(REFERENCE_UNCERTAINTY_CATALOG.claims).toHaveLength(2)
  })
})

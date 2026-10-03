import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import type { EntityId } from '../domain/types'
import { isReferenceArtifact, referenceAudience, referenceCategoryGroup, referenceCategoryKnowledge, referenceFieldFacets } from './reference-facets'
import { EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_KEY, referenceCategoryKey } from './reference-categories'

describe('reference facet organization', () => {
  it('uses native equipment codes for categories without carrying supplemental classifications', () => {
    expect(referenceCategoryKnowledge({ kind: 'item', fields: { 'Native source record': { state: 'known', value: { EquipmentType: 15 } }, 'Equipment type': { state: 'known', value: 'Light Armor' } } })).toEqual([{ state: 'known', value: [EQUIPMENT_CATEGORY_KEY, EQUIPMENT_CATEGORIES['Heavy Body'].key] }])
    expect(referenceCategoryKnowledge({ kind: 'item', fields: { 'Native source record': { state: 'known', value: { EquipmentType: 0 } } } })).toEqual([{ state: 'known', value: [EQUIPMENT_CATEGORY_KEY, EQUIPMENT_CATEGORIES.Sword.key] }])
  })
  it('groups equipment identities and source-defined category tags', () => {
    expect(referenceCategoryGroup(referenceCategoryKey('Staff'), ['item'])).toBe('Weapons')
    expect(referenceCategoryGroup(referenceCategoryKey('Staves'), ['item'])).toBe('Weapons')
    expect(referenceCategoryGroup(referenceCategoryKey('Heavy Armor'), ['item'])).toBe('Armor & headgear')
    expect(referenceCategoryGroup(referenceCategoryKey('Heavy armor'), ['item'])).toBe('Armor & headgear')
    expect(referenceCategoryGroup(referenceCategoryKey('Accessory'), ['item'])).toBe('Accessories & shields')
    expect(referenceCategoryGroup(referenceCategoryKey('Monsters found in Synthetic Valley'), ['monster'])).toBe('Enemy locations & levels')
    expect(referenceCategoryGroup(referenceCategoryKey('Monsters that use Ability Synthetic Strike'), ['monster', 'item'])).toBe('Enemy drops & abilities')
    expect(referenceCategoryGroup(referenceCategoryKey('Abilities that inflict Armor Up'), ['ability'])).toBe('Skill types & effects')
    expect(referenceCategoryGroup(referenceCategoryKey('Synthetic skill tree'), ['command', 'passive'])).toBe('Classes & skills')
    expect(referenceCategoryGroup(referenceCategoryKey('Imported custom group'), ['other'])).toBe('Other categories')
  })

  it('leaves unsupported facts unknown while respecting explicit inapplicability and conflicts', () => {
    const projected = referenceFieldFacets({ kind: 'ability', name: 'Fire Sword', fields: { Element: { state: 'notApplicable' }, 'Source mod': { state: 'conflicting', claims: [{ value: 'Pack A', sources: [] }, { value: 'Pack B', sources: [] }] } } })
    expect(projected.classes.state).toBe('unknown')
    expect(projected.elements.state).toBe('notApplicable')
    expect(projected.mods.state).toBe('conflicting')
    expect(projected.slots.state).toBe('notApplicable')
  })

  it('classifies native source origins without treating vanilla records as possible mod matches', () => {
    const entity = Object.values(DEFAULT_CATALOG.entities).find(value => value.name === 'Warrior' && value.id === 'base:class:warrior')!
    expect(referenceFieldFacets(entity).mods).toEqual({ state: 'known', value: ['Base game'] })
    expect(referenceFieldFacets(entity, [], 'Reviewed mod replacement').mods).toEqual({ state: 'known', value: ['Reviewed mod replacement'] })
    expect(referenceFieldFacets({ kind: 'item', name: 'Warrior', fields: {} }).mods.state).toBe('unknown')
  })

  it('retains a documented mod candidate alongside conflicting imported evidence', () => {
    const projected = referenceFieldFacets({ kind: 'item', fields: { 'Source mod': { state: 'conflicting', claims: [{ value: 'Pack A', sources: [] }, { value: 'Pack B', sources: [] }] } } }, [], 'Documented expansion')
    expect(projected.mods).toEqual({ state: 'conflicting', claims: [{ value: ['Pack A'], sources: [] }, { value: ['Pack B'], sources: [] }, { value: ['Documented expansion'], sources: [] }] })
  })

  it('classifies bundled supplemental records by stable identity without guessing imported content', () => {
    const entities = Object.values(DEFAULT_CATALOG.entities)
    expect(entities.filter(entity => referenceAudience(entity) === 'technical')).toHaveLength(300)
    expect(entities.filter(entity => referenceAudience(entity) === 'diagnostic')).toHaveLength(1)
    expect(entities.filter(entity => referenceAudience(entity) === 'about')).toHaveLength(5)
    expect(entities.filter(entity => referenceAudience(entity) === 'tooling')).toHaveLength(1)
    expect(entities.filter(isReferenceArtifact).map(entity => entity.name).sort()).toEqual(['Bgtest', 'Defender'])
    expect(referenceAudience({ id: 'imported:other:AbilityItemConsumptionDown' as EntityId })).toBe('default')
  })
})

import { describe, expect, it } from 'vitest'
import { referenceCategoryGroup, referenceFieldFacets } from './reference-facets'

describe('reference facet organization', () => {
  it('groups equipment aliases and technical wiki tags without changing their values', () => {
    expect(referenceCategoryGroup('Staff', ['item'])).toBe('Weapons')
    expect(referenceCategoryGroup('Staves', ['item'])).toBe('Weapons')
    expect(referenceCategoryGroup('Heavy Armor', ['item'])).toBe('Armor & headgear')
    expect(referenceCategoryGroup('Heavy armor', ['item'])).toBe('Armor & headgear')
    expect(referenceCategoryGroup('Accessory', ['item'])).toBe('Accessories & shields')
    expect(referenceCategoryGroup('Monsters found in Synthetic Valley', ['monster'])).toBe('Enemy locations & levels')
    expect(referenceCategoryGroup('Monsters that use Ability Synthetic Strike', ['monster', 'item'])).toBe('Enemy drops & abilities')
    expect(referenceCategoryGroup('Abilities that inflict Armor Up', ['ability'])).toBe('Skill types & effects')
    expect(referenceCategoryGroup('Synthetic skill tree', ['command', 'passive'])).toBe('Classes & skills')
    expect(referenceCategoryGroup('Imported custom group', ['other'])).toBe('Other categories')
  })

  it('leaves unsupported facts unknown while respecting explicit inapplicability and conflicts', () => {
    const projected = referenceFieldFacets({ kind: 'ability', name: 'Fire Sword', fields: { Element: { state: 'notApplicable' }, 'Source mod': { state: 'conflicting', claims: [{ value: 'Pack A', sources: [] }, { value: 'Pack B', sources: [] }] } } })
    expect(projected.classes.state).toBe('unknown')
    expect(projected.elements.state).toBe('notApplicable')
    expect(projected.mods.state).toBe('conflicting')
    expect(projected.slots.state).toBe('notApplicable')
  })

  it('retains a documented mod candidate alongside conflicting imported evidence', () => {
    const projected = referenceFieldFacets({ kind: 'item', fields: { 'Source mod': { state: 'conflicting', claims: [{ value: 'Pack A', sources: [] }, { value: 'Pack B', sources: [] }] } } }, [], 'Documented expansion')
    expect(projected.mods).toEqual({ state: 'conflicting', claims: [{ value: ['Pack A'], sources: [] }, { value: ['Pack B'], sources: [] }, { value: ['Documented expansion'], sources: [] }] })
  })
})

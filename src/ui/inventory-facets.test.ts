import { describe, expect, it } from 'vitest'
import { groupCategoryFacetValues } from './inventory-facets'
import { EQUIPMENT_CATEGORIES, referenceCategoryKey } from './reference-categories'

describe('inventory category facets', () => {
  it('counts shared equipment identities once per item while rendering separate labels', () => {
    const groups = groupCategoryFacetValues([
      ['Heavy armor', 'Heavy Armor'],
      ['Light armor'],
      ['Shield', 'Shields'],
      ['Shield'],
      ['Daggers'],
    ].map(record => record.map(referenceCategoryKey)))

    expect(groups).toEqual([
      { value: EQUIPMENT_CATEGORIES.Dagger.key, label: 'Daggers', count: 1 },
      { value: EQUIPMENT_CATEGORIES['Heavy Body'].key, label: 'Heavy armor', count: 1 },
      { value: EQUIPMENT_CATEGORIES['Light Body'].key, label: 'Light armor', count: 1 },
      { value: EQUIPMENT_CATEGORIES.Shield.key, label: 'Shields', count: 2 },
    ])
  })

  it('retains distinct arbitrary source tags and their exact labels', () => {
    const labels = ['Imported Status', 'Imported Statu', 'Custom / group: 100%']
    const groups = groupCategoryFacetValues(labels.map(label => [referenceCategoryKey(label)]))
    expect(groups.map(group => group.value).sort()).toEqual(labels.map(referenceCategoryKey).sort())
    expect(groups.map(group => group.label).sort()).toEqual([...labels].sort())
  })
})

import { describe, expect, it } from 'vitest'
import { expandCategoryFacetValues, groupCategoryFacetValues, selectedCategoryFacetValues } from './inventory-facets'

describe('inventory category facets', () => {
  it('groups case and simple singular variants without double-counting one item', () => {
    const groups = groupCategoryFacetValues([
      ['Heavy armor', 'Heavy Armor'],
      ['Light armor'],
      ['Shield', 'Shields'],
      ['Shield'],
      ['Daggers'],
    ])

    expect(groups).toEqual([
      { value: 'Daggers', count: 1, members: ['Daggers'] },
      { value: 'Heavy armor', count: 1, members: ['Heavy armor', 'Heavy Armor'] },
      { value: 'Light armor', count: 1, members: ['Light armor'] },
      { value: 'Shields', count: 2, members: ['Shield', 'Shields'] },
    ])
  })

  it('keeps exact claim values behind one display selection', () => {
    const groups = groupCategoryFacetValues([['Heavy armor', 'Heavy Armor'], ['Shield', 'Shields']])

    expect(selectedCategoryFacetValues(groups, ['Heavy Armor', 'Shield'])).toEqual(['Heavy armor', 'Shields'])
    expect(expandCategoryFacetValues(groups, ['Heavy armor', 'Shields'])).toEqual(['Heavy armor', 'Heavy Armor', 'Shield', 'Shields'])
  })
})

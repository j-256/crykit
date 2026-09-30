import { describe, expect, it } from 'vitest'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, growthRatings } from './crystal-edit'
import type { CatalogEntity } from './types'

describe('class rating precedence', () => {
  it('prefers native zero and differing values without filling native gaps from the editor copy', () => {
    expect(growthRatings({ fields: {
      [CLASS_FIELDS.ratings]: { state: 'known', value: { HP: 0, STR: 75 } },
      [CRYSTAL_EDIT_FIELDS.ratings]: { state: 'known', value: { HP: 80, STR: 90, MP: 30 } },
    } })).toEqual({ HP: 0, STR: 75 })
  })

  it('retains legacy and imported editor ratings when no preferred field exists', () => {
    expect(growthRatings({ fields: { [CRYSTAL_EDIT_FIELDS.ratings]: { state: 'known', value: { HP: 80 } } } })).toEqual({ HP: 80 })
  })

  it('preserves unknown, conflicting, and invalid preferred ratings', () => {
    const alternatives: CatalogEntity['fields'][string][] = [
      { state: 'unknown' },
      { state: 'conflicting', claims: [{ value: { HP: 80 }, sources: [] }, { value: { HP: 90 }, sources: [] }] },
      { state: 'known', value: { HP: -1, MP: 10_001, STR: '80' } },
    ]
    for (const preferred of alternatives) expect(growthRatings({ fields: { [CLASS_FIELDS.ratings]: preferred, [CRYSTAL_EDIT_FIELDS.ratings]: { state: 'known', value: { HP: 80 } } } })).toEqual({})
  })
})

import { describe, expect, it } from 'vitest'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, growthRatings } from './crystal-edit'
import { classRatingField, statRatingValues, WIKI_STAT_RATING_FIELD } from './stat-ratings'

describe('class rating presentation', () => {
  it('uses native ratings and preserves explicit unknowns ahead of legacy export or wiki values', () => {
    expect(statRatingValues(CLASS_FIELDS.ratings, { HP: 80, MND: 10, SPD: 0 })).toMatchObject({ HP: 4, MND: .5, SPD: 0 })
    const entity = { fields: { [CLASS_FIELDS.ratings]: { state: 'unknown' as const }, [CRYSTAL_EDIT_FIELDS.ratings]: { state: 'known' as const, value: { HP: 100 } } } }
    expect(classRatingField(entity)).toEqual([CLASS_FIELDS.ratings, { state: 'unknown' }])
    expect(growthRatings(entity)).toEqual({})
  })

  it('keeps source-native points separate from wiki stars', () => {
    expect(statRatingValues(CRYSTAL_EDIT_FIELDS.ratings, { HP: 80, MP: 20, MND: 10 })).toMatchObject({ HP: 4, MP: 1, MND: .5, STR: null })
    expect(statRatingValues(WIKI_STAT_RATING_FIELD, { 'Max. HP': '4 Stars', Mind: .5, Luck: '1 Star' })).toMatchObject({ HP: 4, MND: .5, LUK: 1, STR: null })
  })

  it('does not substitute a wiki value for an unresolved exported rating', () => {
    const conflicting = { state: 'conflicting' as const, claims: [{ value: { HP: 80 }, sources: [] }, { value: { HP: 50 }, sources: [] }] }
    for (const knowledge of [conflicting, { state: 'unknown' as const }]) {
      expect(classRatingField({ fields: { [CRYSTAL_EDIT_FIELDS.ratings]: knowledge, [WIKI_STAT_RATING_FIELD]: { state: 'known', value: { 'Max. HP': 4 } } } })).toEqual([CRYSTAL_EDIT_FIELDS.ratings, knowledge])
    }
  })

  it('preserves explicit zero, missing data, unsupported text, and above-scale values', () => {
    expect(statRatingValues(WIKI_STAT_RATING_FIELD, { Strength: 0, Mind: 'High', Spirit: -1, Luck: null, Speed: '4.5 Stars', Agility: '4 stars of 5' })).toMatchObject({ STR: 0, MND: null, SPI: null, LUK: null, SPD: 4.5, AGI: null })
    expect(statRatingValues(CRYSTAL_EDIT_FIELDS.ratings, { HP: 150, MP: Infinity })).toMatchObject({ HP: 7.5, MP: null })
    expect(classRatingField({ fields: {} })).toEqual([WIKI_STAT_RATING_FIELD, { state: 'unknown' }])
  })
})

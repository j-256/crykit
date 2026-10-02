import { describe, expect, it } from 'vitest'
import parity from '../calculations/pc-parity-v1.json'
import { NATIVE_DATA, PC_RULES } from './calculation-rules'
import { STAT_KEYS } from './crystal-edit'
import { calculateGrowth } from './growth'

const ratings = (value: number) => Object.fromEntries(STAT_KEYS.map(stat => [PC_RULES.stats[stat]!.rating!, value]))

describe('native base growth', () => {
  it('matches independent compiled native growth vectors for real gender semantics and integer steps', () => {
    for (const gender of [undefined, 'male', 'female'] as const) {
      const record = gender ? NATIVE_DATA.records.gender.find(record => record.ID === PC_RULES.genders[gender]) as Record<string, unknown> : undefined
      for (const vector of parity.cases.filter(vector => /^member/.test(vector.formula) && vector.input[0]! >= 1 && vector.input[0]! <= 60 && vector.input[2]! % vector.input[0]! === 0 && vector.input[2]! / vector.input[0]! <= 100)) {
        const [level, rating, accumulated, boosted] = vector.input as [number, number, number, number]
        const result = calculateGrowth(level, ratings(rating), [{ levels: level, record: ratings(accumulated / level) }], gender)
        for (const stat of STAT_KEYS) {
          const descriptor = PC_RULES.stats[stat]!
          if (descriptor.formula === vector.formula && Number(record?.[descriptor.gender!] === true) === boosted) expect(result.stats[stat], `${gender}:${stat}:${vector.input}`).toBe(vector.expected)
        }
      }
    }
  })

  it('preserves unknown ratings and refuses incomplete, invalid and oversized inputs', () => {
    const partial = calculateGrowth(1, { HPRating: 80, MPRating: 0 }, [{ levels: 1, record: { HPRating: 20, MPRating: 0 } }])
    expect(partial.stats.HP).toBe(145)
    expect(partial.stats.MP).toBe(6)
    expect(partial.stats.STR).toBeNull()
    expect(calculateGrowth(60, ratings(50), []).stats.HP).toBeNull()
    expect(calculateGrowth(60, ratings(50), [{ levels: 59, record: ratings(50) }]).issues).toContain('Allocate 60 growth levels; 59 assigned')
    expect(calculateGrowth(1, ratings(10), [{ levels: 1, record: ratings(10) }, { levels: 0 }]).issues).toEqual([])
    for (const level of [0, 61, NaN, 1.5, Infinity]) expect(calculateGrowth(level, ratings(10), [{ levels: level, record: ratings(10) }]).stats.HP).toBeNull()
    for (const rating of [-1, 1.5, Number.MAX_VALUE]) expect(calculateGrowth(1, ratings(rating), [{ levels: 1, record: ratings(rating) }]).stats.HP).toBeNull()
  })
})

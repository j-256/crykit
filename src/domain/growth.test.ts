import { describe, expect, it } from 'vitest'
import { STAT_KEYS, type GrowthRatings } from './crystal-edit'
import { estimateGrowth } from './growth'

const ratings = (value: number): GrowthRatings => Object.fromEntries(STAT_KEYS.map(stat => [stat, value]))

describe('guide growth estimates', () => {
  it('uses class and weighted history separately, including MP weighting and optional bonuses', () => {
    const result = estimateGrowth(10, ratings(80), [{ levels: 3, ratings: ratings(20) }, { levels: 7, ratings: ratings(60) }], ['HP', 'MP', 'DEX'])
    expect(result.issues).toEqual([])
    expect(result.stats.HP.value).toBeCloseTo(322.65)
    expect(result.stats.MP.value).toBeCloseTo(59.886)
    expect(result.stats.STR.value).toBeCloseTo(43.1)
    expect(result.stats.DEX.value).toBeCloseTo(48.1)
    expect(result.stats.HP.growth).toBeCloseTo(72.32)
  })

  it('does not manufacture complete stats from partial ratings or an unassigned growth history', () => {
    const partial = estimateGrowth(1, { HP: 80, MP: 0 }, [{ levels: 1, ratings: { HP: 20, MP: 0 } }])
    expect(partial.stats.HP.value).toBeCloseTo(145.183)
    expect(partial.stats.MP.value).toBeCloseTo(6.25)
    expect(partial.stats.STR.value).toBeNull()
    expect(estimateGrowth(60, ratings(50), []).stats.HP.value).toBeNull()
    expect(estimateGrowth(60, ratings(50), [{ levels: 59, ratings: ratings(50) }]).issues).toContain('Allocate 60 growth levels; 59 assigned')
  })

  it('ignores unused history rows and rejects invalid levels, ratings, and allocations', () => {
    expect(estimateGrowth(1, ratings(10), [{ levels: 1, ratings: ratings(10) }, { levels: 0, ratings: {} }]).issues).toEqual([])
    for (const level of [0, 61, NaN, 1.5, Infinity]) expect(estimateGrowth(level, ratings(10), [{ levels: level, ratings: ratings(10) }]).stats.HP.value).toBeNull()
    expect(estimateGrowth(1, ratings(10), [{ levels: -1, ratings: ratings(10) }]).stats.HP.value).toBeNull()
    expect(estimateGrowth(1, ratings(-1), [{ levels: 1, ratings: ratings(10) }]).stats.HP.value).toBeNull()
  })
})

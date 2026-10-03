import { describe, expect, it } from 'vitest'
import { interpretCrystalEditBattleConfig, interpretCrystalEditRecord, supportsCrystalEditVersion } from './crystal-edit-compatibility'

describe('Windows PC 1.6.9 legacy mod interpretation', () => {
  it.each([0, 1, 4, 6, 7, 9, 14, 20, 27, 33, 34])('accepts supported editor format %s without changing its marker', version => {
    expect(supportsCrystalEditVersion(version)).toBe(true)
    const original = { ID: 9000, Name: 'Synthetic legacy passive', StatMods: [{ Tag: 482, Value1: 12, Value2: 0 }, { Tag: 483, Value1: -5, Value2: 0 }], Extension: { arbitrary: 'retained' } }
    const saved = structuredClone(original)
    const record = interpretCrystalEditRecord(original, 'Passives', version)
    expect(record.StatMods).toEqual([{ Tag: 482, Value1: version < 8 ? -1 : 12, Value2: 0 }, { Tag: 483, Value1: version < 10 ? 233 : -5, Value2: version < 10 ? -5 : 0 }])
    expect(record.Extension).toEqual(original.Extension)
    expect(original).toEqual(saved)
  })

  it.each(['Equipment', 'Monsters', 'Passives', 'Statuses'])('converts pre-format-4 command targets in %s', family => {
    const record = { StatMods: [{ Tag: 534, Value1: 999, Value2: 7 }] }
    expect(interpretCrystalEditRecord(record, family, 3).StatMods).toEqual([{ Tag: 534, Value1: 14, Value2: 7 }])
    expect(interpretCrystalEditRecord(record, family, 4).StatMods).toEqual(record.StatMods)
  })

  it.each([22, 23, 32, 33])('converts ability values at their format boundaries for %s', version => {
    const record = { HideIfUnusable: true, AbilityMods: [{ Tag: 29, Value1: 90, Value2: 0 }, { Tag: 37, Value1: 10, Value2: 0 }, { Tag: 45, Value1: 3, Value2: 5 }] }
    const interpreted = interpretCrystalEditRecord(record, 'Abilities', version)
    expect(interpreted.HideIfUnusable).toBe(version >= 33)
    expect(interpreted.AbilityMods).toEqual([{ Tag: 29, Value1: 90, Value2: version < 33 ? 1 : 0 }, { Tag: 37, Value1: 10, Value2: version < 23 ? 6 : 0 }, { Tag: 45, Value1: 3, Value2: 5 }])
  })

  it('applies explicit historical defaults and preserves values after each boundary', () => {
    expect(interpretCrystalEditRecord({ SortOrder: 9, Rating: 7 }, 'Difficulties', 4).Rating).toBe(9)
    expect(interpretCrystalEditRecord({ SortOrder: 9, Rating: 7 }, 'Difficulties', 6).Rating).toBe(7)
    expect(interpretCrystalEditRecord({ VisualPriority: 6 }, 'Statuses', 11).VisualPriority).toBe(0)
    expect(interpretCrystalEditRecord({ DisableSunlight: true }, 'Biomes', 12).DisableSunlight).toBe(false)
    expect(interpretCrystalEditRecord({ IsDefaultLocked: true }, 'Passives', 12).IsDefaultLocked).toBe(false)
    expect(interpretCrystalEditRecord({ IsDefaultLocked: true }, 'Passives', 13).IsDefaultLocked).toBe(true)
    expect(interpretCrystalEditRecord({ ID: 263, IsCombat: false }, 'Items', 14).IsCombat).toBe(true)
    expect(interpretCrystalEditRecord({ ID: 9000, IsConsumable: true, Cost: 1 }, 'Items', 23).AutoLostAndFound).toBe(true)
    expect(interpretCrystalEditRecord({ ID: 157 }, 'Items', 23).AutoLostAndFound).toBe(true)
    expect(interpretCrystalEditRecord({ ID: 9000 }, 'Items', 23).AutoLostAndFound).toBe(false)
    expect(interpretCrystalEditBattleConfig({ LearnAllJobZeroJPAbilities: true }, 4)).toEqual({ LearnAllJobZeroJPAbilities: false })
    expect(interpretCrystalEditBattleConfig({ LearnAllJobZeroJPAbilities: true }, 7)).toEqual({ LearnAllJobZeroJPAbilities: true })
  })

  it.each([-1, 3.5, 35, 99, undefined])('preserves unsupported editor marker %s without claiming compatibility', version => {
    expect(supportsCrystalEditVersion(version)).toBe(false)
  })
})

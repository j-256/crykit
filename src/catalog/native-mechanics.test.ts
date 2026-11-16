import { describe, expect, it } from 'vitest'
import { CURRENT_CATALOG } from './bundled'
import { nativeMechanic } from './native-mechanics'
import { calculateCombat } from '../domain/combat-calculations'

const entry = (id: string) => CURRENT_CATALOG.entities[id]!

describe('standalone native mechanics', () => {
  it('uses the native parameter order for AP costs and secondary resource damage', () => {
    expect(nativeMechanic(entry('mechanic:stat:467'))?.description).toContain('Value1 (X) is the native ability ID')
    expect(calculateCombat('apCost', [{ Stats: { Tags: [], APCostsFlat: 0, AbilityAPCostFlat: [{ ID: 100, Value: 6 }], APCostsMult: 100 } }, { ID: 100, APCost: 0 }])).toBe(6)
    expect(calculateCombat('apCost', [{ Stats: { Tags: [], APCostsFlat: 0, AbilityAPCostFlat: [{ ID: 101, Value: 6 }], APCostsMult: 100 } }, { ID: 100, APCost: 0 }])).toBe(0)
    expect(nativeMechanic(entry('mechanic:ability:2'))?.description).toContain('Value2 (Y) supplies the percentage rate')
    expect(calculateCombat('secondaryAttributeDamage', [201, [20, 30]])).toBe(100)
  })

  it('uses nonlinear steal chance and leaves loot availability separate', () => {
    const description = nativeMechanic(entry('mechanic:stat:526'))?.description
    expect(description).toContain('100 * (base chance + bonus) / (100 + bonus)')
    expect(description).toContain('Loot availability is a separate roll')
    expect(calculateCombat('stealChance', [20, 50])).toBe(46)
    expect(() => calculateCombat('stealChance', [20, -100])).toThrow()
  })

  it('keeps native source scope attached to unchanged mechanics and rejects altered claims', () => {
    const original = entry('mechanic:stat:467')
    expect(nativeMechanic(original)?.scope).toBe('PC 1.7.0.1')
    expect(nativeMechanic({ ...original, name: 'Changed modifier' })).toBeUndefined()
    expect(nativeMechanic({ ...original, rawDescription: 'Changed claim' })).toBeUndefined()
    expect(nativeMechanic({ ...original, sources: [] })).toBeUndefined()
    expect(nativeMechanic({ ...original, fields: {} })).toBeUndefined()
    expect(nativeMechanic(entry('base:job:0'))).toBeUndefined()
  })
})

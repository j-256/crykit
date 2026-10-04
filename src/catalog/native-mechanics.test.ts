import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG, compileBundledSourceId } from './bundled'
import { nativeMechanic } from './native-mechanics'
import facts from './native-mechanics.json' with { type: 'json' }
import code from './game-code-evidence.json' with { type: 'json' }
import { NATIVE_GAME_DATA } from './native-game'
import { calculateCombat } from '../domain/combat-calculations'
import combatRules from '../calculations/combat-v1.json' with { type: 'json' }

const entry = (sourceId: string) => DEFAULT_CATALOG.entities[compileBundledSourceId(sourceId)]!
const FLAT_AP_COST = 'base:mechanic:stat:Flat%20AbilityAPCost%20%5BX%5D%20%5BY%5D'
const ATTRIBUTE_RATE = 'base:mechanic:ability:AttributeDamageRate%20%5BX%5D%20%5BY%5D'
const STEAL_BONUS = 'base:mechanic:stat:StealChanceUp%20%5BX%5D'
const FORMULA_REFERENCE = 'base:mechanic:growth-and-damage'

describe('native mechanic reference replacements', () => {
  it('requires matching native code pins and preserves the complete original claims without changing catalogs', () => {
    const before = JSON.stringify(DEFAULT_CATALOG)
    expect(facts.source.executableSha256).toBe(NATIVE_GAME_DATA.source.executable.sha256)
    for (const [path, digest] of Object.entries(facts.files)) expect((code.files as Record<string, string>)[path]).toBe(digest)
    for (const [path, digest] of Object.entries(facts.calculationFiles)) expect((combatRules.source.files as Record<string, string>)[path]).toBe(digest)
    for (const receipt of facts.entries) {
      const original = entry(receipt.sourceId)
      const projected = nativeMechanic(original)
      expect(projected, receipt.sourceId).toBeDefined()
      expect(projected?.scope).toBe('Windows 1.6.9')
      expect(projected?.originalDescription).toBe(original.rawDescription)
      for (const field of projected!.replacedFields) expect(projected?.originalFields[field]).toBe(original.fields[field])
    }
    expect(JSON.stringify(DEFAULT_CATALOG)).toBe(before)
  })

  it('uses the native parameter order and calculation behavior for AP costs and secondary resource damage', () => {
    const ap = nativeMechanic(entry(FLAT_AP_COST))!
    expect(ap.description).toContain('Value1 (X) is the native ability ID. Value2 (Y) is the flat AP-cost adjustment')
    expect(calculateCombat('apCost', [{ Stats: { Tags: [], APCostsFlat: 0, AbilityAPCostFlat: [{ ID: 100, Value: 6 }], APCostsMult: 100 } }, { ID: 100, APCost: 0 }])).toBe(6)
    expect(calculateCombat('apCost', [{ Stats: { Tags: [], APCostsFlat: 0, AbilityAPCostFlat: [{ ID: 101, Value: 6 }], APCostsMult: 100 } }, { ID: 100, APCost: 0 }])).toBe(0)
    const secondary = nativeMechanic(entry(ATTRIBUTE_RATE))!
    expect(secondary.description).toContain('Value1 (X) selects the native HP, MP, or AP attribute. Value2 (Y) supplies the percentage rate')
    expect(secondary.description).toContain('potential damage before the target\'s resource cap')
    expect(calculateCombat('secondaryAttributeDamage', [201, [20, 30]])).toBe(100)
  })

  it('replaces the linear steal bonus claim with the native nonlinear chance and separate availability', () => {
    const projected = nativeMechanic(entry(STEAL_BONUS))!
    expect(projected.description).toContain('100 * (base chance + bonus) / (100 + bonus)')
    expect(projected.description).toContain('Loot availability is a separate roll')
    expect(calculateCombat('stealChance', [20, 50])).toBe(46)
    expect(() => calculateCombat('stealChance', [20, -100])).toThrow()
  })

  it('leads the formula article with verified native packages and keeps old unresolved claims in provenance', () => {
    const projected = nativeMechanic(entry(FORMULA_REFERENCE))!
    expect(projected.description).toContain('verified Windows PC 1.6.9 calculation package')
    expect(projected.replacedFields).toContain('Unresolved damage details')
    expect(projected.originalFields['Unresolved damage details']).toBeDefined()
    expect(projected.calculationLinks?.map(link => link.href)).toEqual(['https://github.com/j-256/crykit/blob/main/docs/calculation-reference.md', 'https://github.com/j-256/crykit/blob/main/docs/calculations.md'])
  })

  it('does not promote renamed, edited, foreign-source or unreviewed guide claims', () => {
    const original = entry(FLAT_AP_COST)
    expect(nativeMechanic({ ...original, name: 'Different modifier' })).toBeUndefined()
    expect(nativeMechanic({ ...original, rawDescription: 'A different community claim' })).toBeUndefined()
    expect(nativeMechanic({ ...original, sources: [] })).toBeUndefined()
    expect(nativeMechanic({ ...original, fields: { ...original.fields, Description: { state: 'known', value: 'A changed claim' } } })).toBeUndefined()
    expect(nativeMechanic(entry('base:mechanic:stat:Addi%20MVariance%20%5BX%5D'))).toBeUndefined()
  })
})

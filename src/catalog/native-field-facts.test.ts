import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { nativeFieldFacts } from './native-field-facts'
import { nativeIdentity, nativeRecord, nativeSourceRecord, NATIVE_RECORD_FIELD, NATIVE_SOURCE_PREFIX } from '../domain/native-game'

describe('native reference field facts', () => {
  it('projects the native light-armor classification without mutating source evidence', () => {
    const dress = DEFAULT_CATALOG.entities['base:equipment:134']!
    const before = JSON.stringify(dress)
    const facts = nativeFieldFacts(DEFAULT_CATALOG, dress)
    const type = facts.find(fact => fact.field === 'Equipment Type')!
    const alias = facts.find(fact => fact.field === 'Type')

    expect(type).toMatchObject({ original: { value: 'LightBody (code 17)' }, value: { state: 'known', value: 'Light armor' }, differs: false, evidence: 'Database/equipment.dat/134/EquipmentType; EquipmentType.LightBody = 17' })
    expect(alias).toBeUndefined()
    expect(dress.fields.Type).toBeUndefined()
    expect(type.value.state === 'known' && type.value.sources?.every(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX))).toBe(true)
    expect(JSON.stringify(dress)).toBe(before)
  })

  it.each([
    [0, 'Sword'], [1, 'Axe'], [2, 'Dagger'], [3, 'Rapier'], [4, 'Katana'], [5, 'Spear'], [6, 'Scythe'], [7, 'Bow'], [8, 'Staff'], [9, 'Wand'], [10, 'Book'], [11, 'Shield'], [12, 'Heavy helmet'], [13, 'Medium headgear'], [14, 'Light hat'], [15, 'Heavy armor'], [16, 'Medium armor'], [17, 'Light armor'], [18, 'Accessory'],
  ] as const)('renders verified native equipment type %s as %s', (code, label) => {
    const entity = Object.values(DEFAULT_CATALOG.entities).find(entity => nativeIdentity(entity)?.database === 'equipment' && nativeIdentity(entity)?.mode === 'base' && nativeSourceRecord(entity)?.EquipmentType === code)!
    const fact = nativeFieldFacts(DEFAULT_CATALOG, entity).find(fact => fact.field === 'Equipment Type')!
    expect(fact.value).toMatchObject({ state: 'known', value: label })
    expect(fact.differs).toBe(false)
    expect(fact.redundantWith).toBeUndefined()
  })

  it('does not replace a classification on imports or changed native records', () => {
    const dress = DEFAULT_CATALOG.entities['base:equipment:134']!
    expect(nativeFieldFacts({ ...DEFAULT_CATALOG, id: 'imported:synthetic' as typeof DEFAULT_CATALOG.id }, dress)).toEqual([])
    for (const value of [15, 999, null]) {
      const changed = { ...dress, fields: { ...dress.fields, [NATIVE_RECORD_FIELD]: { state: 'known' as const, value: { ...nativeSourceRecord(dress), EquipmentType: value } } } }
      expect(nativeFieldFacts(DEFAULT_CATALOG, changed)).toEqual([])
    }
    expect(nativeFieldFacts(DEFAULT_CATALOG, { ...dress, fields: { ...dress.fields, Type: { state: 'known', value: 'Heavy Armor' } } })).toEqual([])
  })

  it('keeps type labels separate from numeric stats and item effects', () => {
    const shoes = DEFAULT_CATALOG.entities['base:equipment:320']!
    expect(nativeFieldFacts(DEFAULT_CATALOG, shoes).map(fact => fact.field)).toEqual(['Equipment Type'])
    const stew = DEFAULT_CATALOG.entities['base:item:132']!
    expect(nativeFieldFacts(DEFAULT_CATALOG, stew)).toEqual([])
  })

  it('does not reinterpret imports, revised catalogs, or edited definitions', () => {
    const shoes = DEFAULT_CATALOG.entities['base:equipment:320']!
    expect(nativeFieldFacts({ ...DEFAULT_CATALOG, checksum: 'changed' }, shoes)).toEqual([])
    expect(nativeFieldFacts({ ...DEFAULT_CATALOG, legacy: { ...(nativeRecord(DEFAULT_CATALOG.legacy) ? DEFAULT_CATALOG.legacy : {}), sourceContentDigest: 'changed' } }, shoes)).toEqual([])
    for (const changes of [{ name: 'Custom shoes' }, { fields: { ...shoes.fields, Dexterity: { state: 'known' as const, value: 90 } } }]) expect(nativeFieldFacts(DEFAULT_CATALOG, { ...shoes, ...changes })).toEqual([])
  })
})

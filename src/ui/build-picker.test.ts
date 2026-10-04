import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import { entityDefinitionKey } from '../domain/core'
import type { BuildRevisionContent, CatalogEntity, EntityId, EntityRef, JsonValue } from '../domain/types'
import type { DefinitionOption } from './definitions'
import { pickerAvailableForSetup, pickerCategoryKey, pickerEquipmentAssessment, pickerHandedness, pickerListedStat, pickerRemainingPp, pickerSearchEntry, pickerSearchMatch } from './build-picker'
import { subCommandLabel } from './definition-fields'

const known = (value: JsonValue) => ({ state: 'known' as const, value })
const setup = createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!
const ref = (id: string): EntityRef => ({ kind: 'personal', definitionId: id as Extract<EntityRef, { kind: 'personal' }>['definitionId'] })
function option(id: string, fields: CatalogEntity['fields'], kind: CatalogEntity['kind'] = 'item'): DefinitionOption {
  const record: CatalogEntity = { id: id as EntityId, name: `Synthetic ${id}`, kind, fields, aliases: [], sources: [] }
  return { key: entityDefinitionKey(ref(id)), ref: ref(id), name: record.name, kind, record, aliases: [], sourceLabel: 'Synthetic source', stockLabel: 'Unknown', preferred: true }
}
const job = option('job', { [CRYSTAL_EDIT_FIELDS.equipment]: known(['Sword', 'Book', 'Shield', 'Accessory']), 'Innate passive(s)': known('Synthetic bonus: Max HP +20%') }, 'class')
const sword = option('sword', { Category: known(['Swords']), Hands: known(1), Attack: known(30) })
const book = option('book', { Category: known(['Books']), Hands: known(2) })
const shield = option('shield', { Category: known(['Shields']) })
const dualWield = option('dual-wield', { Description: known('Equip two One-Handed weapons at the same time to attack with each one, but decrease Attack by 35%.') }, 'passive')
const unknownPassive = option('unknown', {}, 'passive')
const knownPassive = { ...option('known', {}, 'passive'), record: { ...option('known', {}, 'passive').record, ppCost: { state: 'known' as const, value: 6 } } }
const definitions = [job, sword, book, shield, dualWield, unknownPassive, knownPassive]
const resolve = (value: EntityRef) => definitions.find(candidate => candidate.key === entityDefinitionKey(value))?.record
const content: BuildRevisionContent = { primaryClass: job.ref, secondaryClass: null, equipment: { 'plan-main-hand': { ref: sword.ref } }, passives: [], contextAssumptions: [] }
const offHand = SUGGESTED_BUILD_SLOTS.find(slot => slot.equipmentRole === 'offHand')!

describe('build picker decisions', () => {
  it('searches displayed contributions and ranks actual names ahead of incidental detail matches', () => {
    const shoes = option('Acrobat Shoes', { Agility: known(16) })
    const shoesEntry = pickerSearchEntry(shoes, 'Acrobat Shoes')
    expect(pickerSearchMatch(shoesEntry, 'agility')).toEqual({ rank: 4, explanation: 'Matched details: Agility: 16' })
    const silver = pickerSearchEntry(option('Silver Dagger', {}), 'Silver Dagger')
    const gold = pickerSearchEntry({ ...option('Gold Dagger', {}), description: 'Upgraded from Silver Dagger' }, 'Gold Dagger')
    expect(pickerSearchMatch(silver, 'silver dagger')!.rank).toBeLessThan(pickerSearchMatch(gold, 'silver dagger')!.rank)
    expect(pickerSearchMatch(gold, 'silver dagger')!.explanation).toBe('Matched details: Upgraded from Silver Dagger')
    expect(pickerSearchMatch(shoesEntry, 'unrecorded effect')).toBeUndefined()
  })

  it('labels sourced commands with their class and leaves unknown commands explicit', () => {
    expect(subCommandLabel({ name: 'Synthetic healer', record: { ...job.record, fields: { Command: known('Synthetic healing command') } } })).toBe('Synthetic healing command (Synthetic healer)')
    expect(subCommandLabel(job)).toBe('Unknown command (Synthetic job)')
  })

  it('preflights both handedness and other occupied slots before selection', () => {
    expect(pickerEquipmentAssessment(sword, content, offHand, SUGGESTED_BUILD_SLOTS, resolve)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('Dual Wield') })
    expect(pickerEquipmentAssessment(book, content, offHand, SUGGESTED_BUILD_SLOTS, resolve)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('occupies both hands') })
    expect(pickerEquipmentAssessment(shield, { ...content, equipment: { 'plan-main-hand': { ref: book.ref } } }, offHand, SUGGESTED_BUILD_SLOTS, resolve)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('occupies both hands') })
    expect(pickerEquipmentAssessment(shield, content, offHand, SUGGESTED_BUILD_SLOTS, resolve).status).toBe('valid')
    expect(pickerEquipmentAssessment(sword, { ...content, passives: [{ ref: dualWield.ref }] }, offHand, SUGGESTED_BUILD_SLOTS, resolve).status).toBe('valid')
    expect(pickerHandedness(book)).toBe('Two-handed: occupies both hands')
  })

  it('retains valid shared allocation for the current choice and never mutates the draft', () => {
    const shared = { ref: book.ref, allocationId: 'same-copy' }
    const grouped = { ...content, equipment: { 'plan-main-hand': shared, 'plan-off-hand': shared } }
    expect(pickerEquipmentAssessment(book, grouped, offHand, SUGGESTED_BUILD_SLOTS, resolve).status).toBe('valid')
    expect(pickerEquipmentAssessment(shield, grouped, offHand, SUGGESTED_BUILD_SLOTS, resolve).status).toBe('invalid')
    expect(grouped.equipment['plan-main-hand']).toBe(shared)
    expect(grouped.equipment['plan-off-hand']).toBe(shared)
  })

  it('keeps unsupported compatibility unresolved', () => {
    expect(pickerEquipmentAssessment(sword, { ...content, passives: [{ ref: unknownPassive.ref }] }, offHand, SUGGESTED_BUILD_SLOTS, resolve).status).toBe('undetermined')
  })

  it('defaults to enabled mod choices while retaining unavailable selections', () => {
    for (const state of ['disabled', 'unknown', 'conflicting'] as const) {
      const mod = { ...sword, modAvailability: { requiredMod: 'Synthetic mod', state } }
      expect(pickerAvailableForSetup(mod, false)).toBe(false)
      expect(pickerAvailableForSetup(mod, true)).toBe(true)
      expect(pickerAvailableForSetup(mod, false, mod.key)).toBe(true)
    }
    expect(pickerAvailableForSetup(sword, false)).toBe(true)
    expect(pickerAvailableForSetup({ ...sword, modAvailability: { requiredMod: 'Synthetic mod', state: 'enabled' } }, false)).toBe(true)
  })

  it('returns the replaced passive budget without inventing unknown costs or limits', () => {
    const ppSetup = { ...setup, ppLimit: { state: 'known' as const, value: 10 } }
    const passives = [{ ref: knownPassive.ref }]
    expect(pickerRemainingPp({ ...content, passives }, 0, ppSetup, resolve)).toBe(10)
    expect(pickerRemainingPp({ ...content, passives }, 1, ppSetup, resolve)).toBe(4)
    expect(pickerRemainingPp({ ...content, passives: [...passives, { ref: unknownPassive.ref }] }, 0, ppSetup, resolve)).toBeUndefined()
    expect(pickerRemainingPp(content, 0, { ...ppSetup, ppLimit: { state: 'unknown' } }, resolve)).toBeUndefined()
  })

  it('uses stable equipment categories and sorts only comparable listed numeric values', () => {
    expect(pickerCategoryKey(sword)).toBe('equipment:sword')
    expect(pickerListedStat(sword, 'Attack')).toBe(30)
    const modifier = { ...sword, record: { ...sword.record, fields: {}, listedContributions: { Attack: { state: 'known' as const, value: { value: 25, unit: 'percent' } } } } }
    expect(pickerListedStat(modifier, 'Attack')).toBeUndefined()
    expect(pickerListedStat({ ...modifier, record: { ...modifier.record, listedContributions: { Attack: { state: 'known', value: { value: 12, unit: 'listed flat value' } } } } }, 'Attack')).toBe(12)
  })

  it('sorts native equipment by the same authoritative flat values shown in result summaries', () => {
    const nativeOption = (name: string) => {
      const record = Object.values(DEFAULT_CATALOG.entities).find(entity => entity.name === name)!
      return { ...option(name, record.fields), record }
    }
    expect(pickerListedStat(nativeOption('Acrobat Shoes'), 'Dexterity')).toBe(14)
    expect(pickerListedStat(nativeOption("Cleric's Robe"), 'Defense')).toBeGreaterThan(0)
    const shoes = pickerSearchEntry({ ...nativeOption('Acrobat Shoes'), description: 'Supplemental Dexterity +6' }, 'Acrobat Shoes')
    expect(pickerSearchMatch(shoes, 'dexterity +6')?.explanation).toBe('Matched original source text; see provenance for differing stat claims')
  })
})

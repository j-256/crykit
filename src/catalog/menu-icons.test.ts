import { describe, expect, it } from 'vitest'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import { fieldIconKey, fieldIconKeys } from './menu-icons'

describe('native permission icon identity', () => {
  it('uses the same known taxonomy for native and imported permission names', () => {
    for (const field of [CLASS_FIELDS.equipment, CRYSTAL_EDIT_FIELDS.equipment]) {
      expect(fieldIconKey(field, 'Sword')).toBe('equipment:swords')
      expect(fieldIconKey(field, 'Shield')).toBe('equipment:shields')
      expect(fieldIconKey(field, 'Heavy Head')).toBe('equipment:heavy helmets')
      expect(fieldIconKey(field, 'Light Body')).toBe('equipment:light armor')
      expect(fieldIconKey(field, 'Accessory')).toBeUndefined()
      expect(fieldIconKey(field, 'Swords')).toBeUndefined()
      expect(fieldIconKey(field, 'Synthetic future type')).toBeUndefined()
    }
  })

  it('preserves legacy names without interpreting unrelated source fields as permissions', () => {
    expect(fieldIconKey('Weapons', 'Swords')).toBe('equipment:swords')
    expect(fieldIconKey('Armor', 'Heavy helmets')).toBe('equipment:heavy helmets')
    expect(fieldIconKey('Accessories', 'Shields')).toBe('equipment:shields')
    expect(fieldIconKey('Location', 'Sword')).toBeUndefined()
    expect(fieldIconKey('Synthetic Class equipment types', 'Sword')).toBeUndefined()
  })

  it('does not invent icon values for unknown or conflicting source knowledge', () => {
    expect(fieldIconKeys({ [CLASS_FIELDS.equipment]: { state: 'unknown' } })).toEqual([])
    expect(fieldIconKeys({ [CLASS_FIELDS.equipment]: { state: 'conflicting', claims: [{ value: ['Sword'], sources: [] }, { value: ['Shield'], sources: [] }] } })).toEqual([])
    expect(fieldIconKeys({ [CLASS_FIELDS.equipment]: { state: 'known', value: ['Sword', 'Heavy Body', 'Synthetic future type'] } })).toEqual(['equipment:swords', 'equipment:heavy armor'])
  })
})

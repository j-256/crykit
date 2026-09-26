import type { CatalogEntity, JsonValue, Knowledge } from './types'
import type { ModState } from './mods'

export const WEAPON_TYPES = ['Axe', 'Book', 'Bow', 'Dagger', 'Katana', 'Rapier', 'Scythe', 'Spear', 'Staff', 'Sword', 'Unarmed', 'Wand'] as const
export type WeaponType = typeof WEAPON_TYPES[number]
export const UNRESTRICTED_WEAPON_SKILLS_MOD = 'Unrestricted Weapon Skills'

export type SkillWeaponRule =
  | { readonly kind: 'weaponSkill'; readonly weapons: 'any' | readonly WeaponType[] }
  | { readonly kind: 'nonWeaponAction' }

export function normalizeWeaponType(value: unknown): WeaponType | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return WEAPON_TYPES.find(weapon => normalized === weapon.toLowerCase() || normalized === `${weapon.toLowerCase()}s` || (weapon === 'Staff' && normalized === 'staves'))
}

function parseType(value: JsonValue): SkillWeaponRule | undefined {
  if (typeof value !== 'string') return undefined
  const firstLine = value.trim().split('\n')[0]?.trim() ?? ''
  const skill = /^(?:single target|multi-target) (.+) skill$/i.exec(firstLine)
  if (skill) {
    if (skill[1]?.toLowerCase() === 'weapon') return { kind: 'weaponSkill', weapons: 'any' }
    const weapons = skill[1]!.split('/').map(normalizeWeaponType)
    if (weapons.every((weapon): weapon is WeaponType => weapon !== undefined)) return { kind: 'weaponSkill', weapons: [...new Set(weapons)] }
    return undefined
  }
  if (/\b(?:magic|ability)$/i.test(firstLine) || /^stance change(?: \(magic\))?$/i.test(firstLine)) return { kind: 'nonWeaponAction' }
  return undefined
}

export function skillWeaponRule(entity: Pick<CatalogEntity, 'kind' | 'fields'>): Knowledge<SkillWeaponRule> {
  if (entity.kind !== 'ability' && entity.kind !== 'monsterMagic') return { state: 'notApplicable' }
  const typeFields = Object.entries(entity.fields).filter(([key]) => key.trim().toLowerCase() === 'type')
  if (typeFields.length !== 1) return { state: 'unknown', reason: 'No unambiguous skill type was supplied' }
  const type = typeFields[0]![1]
  if (type.state === 'known') {
    const value = parseType(type.value)
    return value ? { state: 'known', value, sources: type.sources } : { state: 'unknown', reason: 'The listed type does not establish weapon requirements', sources: type.sources }
  }
  if (type.state === 'conflicting') {
    const claims = type.claims.flatMap(claim => {
      const value = parseType(claim.value)
      return value ? [{ ...claim, value }] : []
    })
    return claims.length === type.claims.length && claims.length > 0
      ? { state: 'conflicting', claims }
      : { state: 'unknown', reason: 'Conflicting types include undocumented weapon requirements' }
  }
  return type.state === 'notApplicable' ? { state: 'unknown', reason: 'Weapon requirements were not supplied' } : type
}

export function skillAcceptsWeapon(rule: Knowledge<SkillWeaponRule>, weapon: WeaponType, unrestricted: ModState = 'unknown'): Knowledge<boolean> {
  const accepts = (value: SkillWeaponRule) => value.kind === 'weaponSkill' && (unrestricted === 'enabled' || value.weapons === 'any' || value.weapons.includes(weapon))
  if (rule.state === 'notApplicable') return { state: 'known', value: false }
  if (rule.state === 'conflicting') return { state: 'conflicting', claims: rule.claims.map(claim => ({ ...claim, value: accepts(claim.value) })) }
  if (rule.state === 'unknown') return rule
  const value = accepts(rule.value)
  if (!value && rule.value.kind === 'weaponSkill' && unrestricted === 'conflicting') return { state: 'unknown', reason: 'Unrestricted Weapon Skills has conflicting settings' }
  return { state: 'known', value, sources: rule.sources }
}

export function skillWeaponLabel(rule: Knowledge<SkillWeaponRule>): string {
  if (rule.state === 'conflicting') return 'Conflicting weapon requirements'
  if (rule.state !== 'known') return 'Weapon requirements unknown'
  if (rule.value.kind === 'nonWeaponAction') return 'No weapon requirement'
  return rule.value.weapons === 'any' ? 'Any weapon' : rule.value.weapons.join(' / ')
}

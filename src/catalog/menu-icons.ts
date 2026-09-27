import { MENU_ICON_KEYS, menuIcon } from './sprites'
import type { CatalogEntity } from '../domain/types'

const EQUIPMENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  sword: 'swords', axe: 'axes', dagger: 'daggers', spear: 'spears', bow: 'bows',
  rapier: 'rapiers', scythe: 'scythes', staff: 'staves', 'two-handed staff': 'staves',
  wand: 'wands', book: 'books', katana: 'katanas', shield: 'shields',
  'heavy helmet': 'heavy helmets', 'light hat': 'light hats',
})
const EQUIPMENT_FIELDS = new Set(['weapon', 'weapons', 'armor', 'armors', 'category'])
const SKILL_TYPES = MENU_ICON_KEYS.filter(key => key.startsWith('skill:')).map(key => key.slice('skill:'.length)).sort((left, right) => right.length - left.length)

export function fieldIconKey(field: string, value: string): string | undefined {
  const label = value.trim().toLowerCase().replace(/\s+/g, ' ')
  const name = field.trim().toLowerCase()
  let key = EQUIPMENT_FIELDS.has(name) ? `equipment:${EQUIPMENT_ALIASES[label] ?? label}`
    : name === 'element' || name === 'elements' ? `element:${label}`
      : name === 'command' ? `command:${label}`
        : name === 'type' ? `skill:${label}` : undefined
  if (name === 'type') {
    const type = SKILL_TYPES.find(type => (` ${label} `).includes(` ${type} `))
    if (type) key = `skill:${type}`
  }
  if (name === 'category' && key && !menuIcon(key)) key = `skill:${label}`
  return key && menuIcon(key) ? key : undefined
}

export function definitionIconKey(entity: Pick<CatalogEntity, 'kind' | 'name' | 'fields'>): string | undefined {
  if (entity.kind === 'passive') return 'skill:passive'
  if (entity.kind === 'monsterMagic') return 'skill:monster magic'
  if (entity.kind === 'command') return fieldIconKey('Command', entity.name)
  if (entity.kind !== 'ability') return undefined
  const type = entity.fields.Type
  if (type?.state === 'conflicting') return undefined
  if (type?.state === 'known' && typeof type.value === 'string') {
    const key = fieldIconKey('Type', type.value)
    if (key) return key
  }
  const category = entity.fields.Category
  if (category?.state !== 'known') return undefined
  const values = Array.isArray(category.value) ? category.value : [category.value]
  const keys = [...new Set(values.flatMap(value => typeof value === 'string' && menuIcon(`skill:${value.toLowerCase()}`) ? [`skill:${value.toLowerCase()}`] : []))]
  return keys.length === 1 ? keys[0] : undefined
}

export function fieldIconKeys(fields: CatalogEntity['fields']): readonly string[] {
  const keys = new Set<string>()
  const visit = (field: string, value: unknown) => {
    if (Array.isArray(value)) value.forEach(entry => visit(field, entry))
    else if (typeof value === 'string') for (const part of value.split(',')) {
      const key = fieldIconKey(field, part)
      if (key) keys.add(key)
    }
  }
  for (const [field, knowledge] of Object.entries(fields)) {
    if (knowledge.state === 'known') visit(field, knowledge.value)
    else if (knowledge.state === 'conflicting') knowledge.claims.forEach(claim => visit(field, claim.value))
  }
  return [...keys]
}

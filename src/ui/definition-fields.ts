import type { DefinitionOption } from './definitions'

const WEAPON_CATEGORIES = ['Axes', 'Bows', 'Daggers', 'Katanas', 'Rapiers', 'Scythes', 'Spears', 'Staves', 'Swords', 'Wands', 'Wand', 'Two-Handed Staff']
const HAND_CATEGORIES = [...WEAPON_CATEGORIES, 'Shields', 'Books', 'Pouches', 'Tools']
const HEAD_CATEGORIES = ['Heavy helmets', 'Light hats', 'Medium headgear']
const BODY_CATEGORIES = ['Heavy armor', 'Light armor', 'Medium armor']
const KNOWN_CATEGORIES = new Set([...HAND_CATEGORIES, ...HEAD_CATEGORIES, ...BODY_CATEGORIES, 'Accessories', 'Consumables', 'Crafting', 'Fishing', 'Key Items', 'Keys', 'Maps', 'Seeds'])

export function commandName(option: DefinitionOption): string | undefined {
  const command = Object.entries(option.record.fields).find(([key]) => key.toLowerCase() === 'command')?.[1]
  return command?.state === 'known' && typeof command.value === 'string' ? command.value : undefined
}

export function matchesSlot(option: DefinitionOption, label: string) {
  if (option.kind !== 'item' || option.category?.state !== 'known') return true
  const categories = Array.isArray(option.category.value) ? option.category.value : [option.category.value]
  const known = categories.filter((value): value is string => typeof value === 'string' && KNOWN_CATEGORIES.has(value))
  if (!known.length) return true
  const slot = label.toLowerCase()
  const expected = slot.includes('accessory') ? ['Accessories'] : slot === 'head' ? HEAD_CATEGORIES : slot === 'body' ? BODY_CATEGORIES : slot.includes('hand') ? HAND_CATEGORIES : undefined
  return !expected || known.some((category) => expected.includes(category))
}

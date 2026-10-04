import { EQUIPMENT_TYPES } from './crystal-edit'

export const EQUIPMENT_CATEGORIES = Object.freeze({
  Sword: { key: 'equipment:sword', label: 'Swords', typeLabel: 'Sword', group: 'Weapons', sourceLabels: ['Sword', 'Swords'] },
  Axe: { key: 'equipment:axe', label: 'Axes', typeLabel: 'Axe', group: 'Weapons', sourceLabels: ['Axe', 'Axes'] },
  Dagger: { key: 'equipment:dagger', label: 'Daggers', typeLabel: 'Dagger', group: 'Weapons', sourceLabels: ['Dagger', 'Daggers'] },
  Rapier: { key: 'equipment:rapier', label: 'Rapiers', typeLabel: 'Rapier', group: 'Weapons', sourceLabels: ['Rapier', 'Rapiers'] },
  Katana: { key: 'equipment:katana', label: 'Katanas', typeLabel: 'Katana', group: 'Weapons', sourceLabels: ['Katana', 'Katanas'] },
  Spear: { key: 'equipment:spear', label: 'Spears', typeLabel: 'Spear', group: 'Weapons', sourceLabels: ['Spear', 'Spears'] },
  Scythe: { key: 'equipment:scythe', label: 'Scythes', typeLabel: 'Scythe', group: 'Weapons', sourceLabels: ['Scythe', 'Scythes'] },
  Bow: { key: 'equipment:bow', label: 'Bows', typeLabel: 'Bow', group: 'Weapons', sourceLabels: ['Bow', 'Bows'] },
  Staff: { key: 'equipment:staff', label: 'Staves', typeLabel: 'Staff', group: 'Weapons', sourceLabels: ['Staff', 'Staves', 'Staffs', 'Two-handed staff'] },
  Wand: { key: 'equipment:wand', label: 'Wands', typeLabel: 'Wand', group: 'Weapons', sourceLabels: ['Wand', 'Wands'] },
  Book: { key: 'equipment:book', label: 'Books', typeLabel: 'Book', group: 'Weapons', sourceLabels: ['Book', 'Books'] },
  Shield: { key: 'equipment:shield', label: 'Shields', typeLabel: 'Shield', group: 'Accessories & shields', sourceLabels: ['Shield', 'Shields'] },
  'Heavy Head': { key: 'equipment:heavy-head', label: 'Heavy helmets', typeLabel: 'Heavy helmet', group: 'Armor & headgear', sourceLabels: ['Heavy Head', 'Heavy helmets'] },
  'Medium Head': { key: 'equipment:medium-head', label: 'Medium headgear', typeLabel: 'Medium headgear', group: 'Armor & headgear', sourceLabels: ['Medium Head', 'Medium headgear'] },
  'Light Head': { key: 'equipment:light-head', label: 'Light hats', typeLabel: 'Light hat', group: 'Armor & headgear', sourceLabels: ['Light Head', 'Light hats'] },
  'Heavy Body': { key: 'equipment:heavy-body', label: 'Heavy armor', typeLabel: 'Heavy armor', group: 'Armor & headgear', sourceLabels: ['Heavy Body', 'Heavy armor'] },
  'Medium Body': { key: 'equipment:medium-body', label: 'Medium armor', typeLabel: 'Medium armor', group: 'Armor & headgear', sourceLabels: ['Medium Body', 'Medium armor'] },
  'Light Body': { key: 'equipment:light-body', label: 'Light armor', typeLabel: 'Light armor', group: 'Armor & headgear', sourceLabels: ['Light Body', 'Light armor'] },
  Accessory: { key: 'equipment:accessory', label: 'Accessories', typeLabel: 'Accessory', group: 'Accessories & shields', sourceLabels: ['Accessory', 'Accessories'] },
} as const)

export function equipmentCategory(code: number) {
  const type = EQUIPMENT_TYPES[code]
  return type ? EQUIPMENT_CATEGORIES[type as keyof typeof EQUIPMENT_CATEGORIES] : undefined
}

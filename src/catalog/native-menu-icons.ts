import equipmentTypesUrl from '../assets/menu-icons/equipment-types.png?url&no-inline'
import type { MenuIcon } from './sprites'

const ICON_COLUMNS = 7
const ICON_STRIDE = 34
const ICON_INSET = 2
const ICON_SIZE = 32
const EQUIPMENT_ICON_INDICES: Readonly<Record<string, number>> = Object.freeze({
  'equipment:medium headgear': 42,
  'equipment:medium armor': 43,
})
export const NATIVE_MENU_ICON_KEYS = Object.keys(EQUIPMENT_ICON_INDICES)

export function nativeMenuIcon(key: string): MenuIcon | undefined {
  const index = EQUIPMENT_ICON_INDICES[key]
  if (index === undefined) return undefined
  const name = key.slice('equipment:'.length)
  return {
    asset: { file: 'equipment-types.png', title: 'Crystal Project equipment type icons', width: 240, height: 240, license: 'Copyrighted Crystal Project game artwork; no separate license grant asserted' },
    binding: { name, asset: 'equipment-types.png', sources: [{ title: 'Crystal Project PC 1.6.9.0 equipment menu', locator: `Icon/SystemB, cell ${index}` }], region: { x: index % ICON_COLUMNS * ICON_STRIDE + ICON_INSET, y: Math.floor(index / ICON_COLUMNS) * ICON_STRIDE + ICON_INSET, width: ICON_SIZE, height: ICON_SIZE } },
    provenance: 'installed-game',
    url: equipmentTypesUrl,
  }
}

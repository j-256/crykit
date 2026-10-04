import equipmentTypesUrl from '../assets/menu-icons/equipment-types.png?url&no-inline'
import gameArtwork from './game-artwork.json'
import type { MenuIcon } from './sprites'

const urls = import.meta.glob<string>('../assets/game-assets/*', { eager: true, query: '?url&no-inline', import: 'default' })
const menuBindings: Readonly<Record<string, { readonly name: string; readonly asset: string; readonly locator: string }>> = gameArtwork.menuIcons
const menuAssets: Readonly<Record<string, { readonly file: string; readonly width: number; readonly height: number; readonly rights: string }>> = gameArtwork.assets
const ICON_COLUMNS = 7
const ICON_STRIDE = 34
const ICON_INSET = 2
const ICON_SIZE = 32
const EQUIPMENT_ICON_INDICES: Readonly<Record<string, number>> = Object.freeze({
  'equipment:shields': 39,
  'equipment:heavy helmets': 40,
  'equipment:heavy armor': 41,
  'equipment:medium headgear': 42,
  'equipment:medium armor': 43,
  'equipment:light hats': 44,
  'equipment:light armor': 45,
})
export const NATIVE_MENU_ICON_KEYS = [...Object.keys(EQUIPMENT_ICON_INDICES), ...Object.keys(menuBindings)]

export function nativeMenuIcon(key: string): MenuIcon | undefined {
  const binding = menuBindings[key]
  const asset = binding && menuAssets[binding.asset]
  const url = asset && urls[`../assets/game-assets/${asset.file}`]
  if (binding && asset && url) return {
    asset: { ...asset, title: `Crystal Project ${binding.name} icon`, license: asset.rights },
    binding: { name: binding.name, asset: binding.asset, sources: [{ title: `Crystal Project ${gameArtwork.sources.nativeDefinitions.platform} ${gameArtwork.sources.nativeDefinitions.gameVersion}`, locator: binding.locator }] },
    provenance: 'installed-game',
    url,
  }
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

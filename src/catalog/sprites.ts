import type { CatalogEntity } from '../domain/types'
import manifestJson from './wiki-sprites.json'
import { STARTER_CATALOG_ID } from './starter'

interface SpriteAsset {
  readonly file: string
  readonly title: string
  readonly descriptionUrl: string
  readonly width: number
  readonly height: number
  readonly license: string
}

interface SpriteBinding {
  readonly kind: string
  readonly name: string
  readonly asset: string
  readonly sources: readonly { readonly title: string; readonly url: string; readonly locator: string }[]
}

interface SpriteManifest {
  readonly assets: Readonly<Record<string, SpriteAsset>>
  readonly entities: Readonly<Record<string, SpriteBinding>>
  readonly icons: Readonly<Record<string, MenuIconBinding>>
}

interface MenuIconBinding {
  readonly name: string
  readonly asset: string
  readonly sources: SpriteBinding['sources']
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

const manifest: SpriteManifest = manifestJson
export const MENU_ICON_KEYS = Object.keys(manifest.icons)
const urls = import.meta.glob<string>('../assets/wiki-sprites/*', { eager: true, query: '?url&no-inline', import: 'default' })

export interface WikiSprite {
  readonly asset: SpriteAsset
  readonly binding: SpriteBinding
  readonly url: string
}

export interface MenuIcon {
  readonly asset: SpriteAsset
  readonly binding: MenuIconBinding
  readonly url: string
}

export function menuIcon(key: string): MenuIcon | undefined {
  const binding = manifest.icons[key]
  const asset = binding && manifest.assets[binding.asset]
  const url = asset && urls[`../assets/wiki-sprites/${asset.file}`]
  return binding && asset && url ? { asset, binding, url } : undefined
}

export function wikiSprite(catalogId: string, entity: Pick<CatalogEntity, 'id' | 'kind'>): WikiSprite | undefined {
  if (catalogId !== STARTER_CATALOG_ID) return undefined
  const binding = manifest.entities[entity.id]
  if (!binding || binding.kind !== entity.kind) return undefined
  const asset = manifest.assets[binding.asset]
  const url = asset && urls[`../assets/wiki-sprites/${asset.file}`]
  return asset && url ? { asset, binding, url } : undefined
}

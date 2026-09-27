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
}

const manifest: SpriteManifest = manifestJson
const urls = import.meta.glob<string>('../assets/wiki-sprites/*', { eager: true, query: '?url&no-inline', import: 'default' })

export interface WikiSprite {
  readonly asset: SpriteAsset
  readonly binding: SpriteBinding
  readonly url: string
}

export function wikiSprite(catalogId: string, entity: Pick<CatalogEntity, 'id' | 'kind'>): WikiSprite | undefined {
  if (catalogId !== STARTER_CATALOG_ID) return undefined
  const binding = manifest.entities[entity.id]
  if (!binding || binding.kind !== entity.kind) return undefined
  const asset = manifest.assets[binding.asset]
  const url = asset && urls[`../assets/wiki-sprites/${asset.file}`]
  return asset && url ? { asset, binding, url } : undefined
}

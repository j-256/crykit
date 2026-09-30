import type { CatalogEntity } from '../domain/types'
import gameArtworkJson from './game-artwork.json'
import manifestJson from './wiki-sprites.json'
import { STARTER_CATALOG_ID } from './starter'

interface SpriteAsset {
  readonly file: string
  readonly title: string
  readonly descriptionUrl: string
  readonly width: number
  readonly height: number
  readonly license: string
  readonly contentBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

interface SpriteBinding {
  readonly kind: string
  readonly name: string
  readonly asset: string
  readonly sources: readonly { readonly title: string; readonly url: string; readonly locator: string }[]
}

interface GameArtworkAsset {
  readonly file: string
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly rights: string
  readonly contentBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

interface GameArtworkBinding {
  readonly kind: string
  readonly name: string
  readonly asset: string
  readonly database: { readonly name: string; readonly id: number; readonly recordName: string }
  readonly identity: { readonly sourceKey: string; readonly locator: string; readonly upstreamName?: string; readonly upstreamCode?: number; readonly url?: string; readonly databaseSha256?: string }
  readonly rendering: {
    readonly extraction: string
    readonly sourceTextures: readonly { readonly field?: string; readonly texturePath: string; readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }[]
  }
}

interface GameArtworkManifest {
  readonly gameInputDigest: string
  readonly sources: {
    readonly executable: { readonly path: string; readonly sha256: string }
    readonly identityCrosswalk: { readonly commit: string; readonly repository: string }
  }
  readonly assets: Readonly<Record<string, GameArtworkAsset>>
  readonly entities: Readonly<Record<string, GameArtworkBinding>>
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
const gameArtwork: GameArtworkManifest = gameArtworkJson
export const MENU_ICON_KEYS = Object.keys(manifest.icons)
const urls = import.meta.glob<string>('../assets/wiki-sprites/*', { eager: true, query: '?url&no-inline', import: 'default' })
const gameArtworkUrls = import.meta.glob<string>('../assets/game-assets/*', { eager: true, query: '?url&no-inline', import: 'default' })

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

export type CatalogArtwork = {
  readonly source: 'native'
  readonly asset: GameArtworkAsset
  readonly binding: GameArtworkBinding
  readonly gameInputDigest: string
  readonly executable: GameArtworkManifest['sources']['executable']
  readonly identityCrosswalk: GameArtworkManifest['sources']['identityCrosswalk']
  readonly url: string
} | {
  readonly source: 'wiki'
  readonly asset: SpriteAsset
  readonly binding: SpriteBinding
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

export function catalogArtwork(catalogId: string, entity: Pick<CatalogEntity, 'id' | 'kind'>): CatalogArtwork | undefined {
  if (catalogId !== STARTER_CATALOG_ID) return undefined
  const nativeBinding = gameArtwork.entities[entity.id]
  const nativeAsset = nativeBinding && gameArtwork.assets[nativeBinding.asset]
  const nativeUrl = nativeAsset && gameArtworkUrls[`../assets/game-assets/${nativeAsset.file}`]
  if (nativeBinding?.kind === entity.kind && nativeAsset && nativeUrl) return {
    source: 'native',
    asset: nativeAsset,
    binding: nativeBinding,
    gameInputDigest: gameArtwork.gameInputDigest,
    executable: gameArtwork.sources.executable,
    identityCrosswalk: gameArtwork.sources.identityCrosswalk,
    url: nativeUrl,
  }
  const wiki = wikiSprite(catalogId, entity)
  return wiki && { source: 'wiki', ...wiki }
}

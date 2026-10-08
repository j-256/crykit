import type { CatalogEntity } from '../domain/types'
import gameArtworkJson from './game-artwork.json'
import wikiManifestJson from './wiki-sprites.json'
import { STARTER_CATALOG_ID } from './catalog-ids'
import { nativeMenuIcon, NATIVE_MENU_ICON_KEYS } from './native-menu-icons'
import { compileBundledSourceBindings } from './bundled'
import { modSourceArtwork, type ModArtworkIdentity } from './mod-artwork'
import { MOD_PROJECT_FIELD } from '../domain/mod-library'

type ArtworkIdentity = Pick<CatalogEntity, 'id' | 'kind'> & ModArtworkIdentity

interface SpriteAsset {
  readonly file: string
  readonly title: string
  readonly descriptionUrl?: string
  readonly width: number
  readonly height: number
  readonly license: string
  readonly contentBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly atlas?: { readonly width: number; readonly height: number; readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }
}

interface SpriteBinding {
  readonly kind: string
  readonly name: string
  readonly asset: string
  readonly origin?: 'mod-export' | 'base-game-archive'
  readonly sources: readonly { readonly title: string; readonly url?: string; readonly locator: string; readonly applicability?: string }[]
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
  readonly nativeRecord?: { readonly database: string; readonly databaseId: number; readonly mode: string; readonly locator: string; readonly databaseSha256: string }
  readonly identity?: { readonly sourceKey: string; readonly locator: string; readonly upstreamName?: string; readonly upstreamCode?: number; readonly url?: string; readonly databaseSha256?: string }
  readonly rendering: {
    readonly extraction: string
    readonly sourceTextures: readonly { readonly field?: string; readonly texturePath: string; readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }[]
  }
}

interface GameArtworkManifest {
  readonly gameInputDigest: string
  readonly sources: {
    readonly executable: { readonly path: string; readonly sha256: string }
    readonly nativeDefinitions: { readonly platform: string; readonly gameVersion: string }
    readonly identityCrosswalk: { readonly commit: string; readonly repository: string }
  }
  readonly assets: Readonly<Record<string, GameArtworkAsset>>
  readonly entities: Readonly<Record<string, GameArtworkBinding>>
  readonly classWorld: Readonly<Record<string, GameArtworkBinding>>
  readonly quintarGuide: Readonly<Record<QuintarGuideArtworkKey, { readonly label: string; readonly asset: string }>>
  readonly uiArtwork: Readonly<Record<NativeUiArtworkKey, { readonly label: string; readonly asset: string }>>
}

export type QuintarGuideArtworkKey = 'babel' | 'ocarina' | 'egg' | 'trustyBlue' | 'trustyRed' | 'wokeRiver' | 'brutishDesert' | 'golden'
export type NativeUiArtworkKey = 'classSeal' | 'goldCoin' | 'silverCoin' | 'copperCoin'

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

const gameArtwork: GameArtworkManifest = { ...gameArtworkJson, entities: compileBundledSourceBindings(gameArtworkJson.entities), classWorld: compileBundledSourceBindings(gameArtworkJson.classWorld) }
const gameArtworkUrls = import.meta.glob<string>('../assets/game-assets/*', { eager: true, query: '?url&no-inline', import: 'default' })
const wikiManifest: SpriteManifest = { ...wikiManifestJson, entities: compileBundledSourceBindings(wikiManifestJson.entities) }
export const MENU_ICON_KEYS = [...new Set([...Object.keys(wikiManifest.icons), ...NATIVE_MENU_ICON_KEYS])]
const wikiUrls = import.meta.glob<string>('../assets/wiki-sprites/*', { eager: true, query: '?url&no-inline', import: 'default' })

export interface WikiSprite {
  readonly asset: SpriteAsset
  readonly binding: SpriteBinding
  readonly url: string
  readonly provenance: 'community-wiki' | 'mod-export' | 'base-game-archive'
}

export interface MenuIcon {
  readonly asset: SpriteAsset
  readonly binding: MenuIconBinding
  readonly url: string
  readonly provenance: 'community-wiki' | 'installed-game'
}

export type CatalogArtwork = {
  readonly source: 'native'
  readonly asset: GameArtworkAsset
  readonly binding: GameArtworkBinding
  readonly gameInputDigest: string
  readonly executable: GameArtworkManifest['sources']['executable']
  readonly nativeDefinitions: GameArtworkManifest['sources']['nativeDefinitions']
  readonly identityCrosswalk: GameArtworkManifest['sources']['identityCrosswalk']
  readonly url: string
} | {
  readonly source: 'wiki' | 'mod'
  readonly asset: SpriteAsset
  readonly binding: SpriteBinding
  readonly url: string
  readonly provenance: WikiSprite['provenance']
}

export function menuIcon(key: string): MenuIcon | undefined {
  const native = nativeMenuIcon(key)
  if (native) return native
  const binding = wikiManifest.icons[key]
  const asset = binding && wikiManifest.assets[binding.asset]
  const url = asset && wikiUrls[`../assets/wiki-sprites/${asset.file}`]
  return binding && asset && url ? { asset, binding, url, provenance: 'community-wiki' } : undefined
}

export function wikiSprite(catalogId: string, entity: ArtworkIdentity): WikiSprite | undefined {
  if (catalogId !== STARTER_CATALOG_ID) return undefined
  const binding = wikiManifest.entities[entity.id]
  if (!binding || binding.kind !== entity.kind) return undefined
  const asset = wikiManifest.assets[binding.asset]
  const url = asset && wikiUrls[`../assets/wiki-sprites/${asset.file}`]
  return asset && url ? { asset, binding, url, provenance: 'community-wiki' } : undefined
}

export function catalogArtwork(catalogId: string, entity: ArtworkIdentity): CatalogArtwork | undefined {
  const mod = modSourceArtwork(entity)
  if (mod) return mod
  if (entity.fields?.[MOD_PROJECT_FIELD]) return undefined
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
    nativeDefinitions: gameArtwork.sources.nativeDefinitions,
    url: nativeUrl,
  }
  const wiki = wikiSprite(catalogId, entity)
  return wiki && { source: 'wiki', ...wiki }
}

export function classWorldArtwork(catalogId: string, entity: ArtworkIdentity): CatalogArtwork | undefined {
  if (entity.kind === 'class') {
    const mod = modSourceArtwork(entity)
    if (mod) return mod
    if (entity.fields?.[MOD_PROJECT_FIELD]) return undefined
  }
  if (catalogId !== STARTER_CATALOG_ID || entity.kind !== 'class') return undefined
  const binding = gameArtwork.classWorld[entity.id]
  const asset = binding && gameArtwork.assets[binding.asset]
  const url = asset && gameArtworkUrls[`../assets/game-assets/${asset.file}`]
  if (binding?.kind === entity.kind && asset && url) return { source: 'native', asset, binding, gameInputDigest: gameArtwork.gameInputDigest, executable: gameArtwork.sources.executable, nativeDefinitions: gameArtwork.sources.nativeDefinitions, identityCrosswalk: gameArtwork.sources.identityCrosswalk, url }
  const wiki = wikiSprite(catalogId, entity)
  return wiki && { source: 'wiki', ...wiki }
}

export function quintarGuideArtwork(key: QuintarGuideArtworkKey): { readonly asset: GameArtworkAsset; readonly url: string } | undefined {
  const binding = gameArtwork.quintarGuide[key]
  const asset = binding && gameArtwork.assets[binding.asset]
  const url = asset && gameArtworkUrls[`../assets/game-assets/${asset.file}`]
  return asset && url ? { asset, url } : undefined
}

export function nativeUiArtwork(key: NativeUiArtworkKey): { readonly asset: GameArtworkAsset; readonly url: string } | undefined {
  const binding = gameArtwork.uiArtwork[key]
  const asset = binding && gameArtwork.assets[binding.asset]
  const url = asset && gameArtworkUrls[`../assets/game-assets/${asset.file}`]
  return asset && url ? { asset, url } : undefined
}

import manifestJson from './mod-artwork-runtime.json'
import { BUNDLED_MOD_LIBRARY } from './mod-library-metadata'
import { bundledModIdentity } from '../domain/bundled-mods'
import { GAME_RECORD_FIELD } from '../domain/game-record-facts'
import { nativeRecord } from '../domain/native-game'
import { modArtworkReference } from '../domain/mod-artwork'
import type { CatalogEntity } from '../domain/types'
import { MOD_PROJECT_FIELD } from '../domain/mod-library'

interface ArtworkBinding {
  readonly kind: string
  readonly asset: string
  readonly reference: readonly (string | number | null)[]
  readonly sourceTextures: readonly { readonly texturePath: string; readonly origin: 'mod-export' | 'base-game-archive' }[]
}
interface ModArtworkManifest {
  readonly assets: Readonly<Record<string, { readonly file: string; readonly sha256: string; readonly width: number; readonly height: number; readonly license: string; readonly contentBounds: Region; readonly atlas: string; readonly region: Region }>>
  readonly atlases: Readonly<Record<string, { readonly file: string; readonly width: number; readonly height: number }>>
  readonly projects: Readonly<Record<string, { readonly projectId: string; readonly title: string; readonly version: string; readonly entities: Readonly<Record<string, ArtworkBinding>> }>>
}
interface Region { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export type ModArtworkIdentity = Partial<Pick<CatalogEntity, 'fields' | 'legacy'>>
const manifest = manifestJson as unknown as ModArtworkManifest
const urls = import.meta.glob<string>('../assets/mod-artwork-atlases/*.png', { eager: true, query: '?url&no-inline', import: 'default' })
const libraryByRevision = new Map(BUNDLED_MOD_LIBRARY.map(mod => [`${mod.key}:${mod.declaredVersion}`, mod]))

export function modSourceArtwork(entity: Pick<CatalogEntity, 'kind'> & ModArtworkIdentity) {
  const fields = entity.fields
  const recordField = fields?.[GAME_RECORD_FIELD]
  if (recordField?.state !== 'known' || !nativeRecord(recordField.value)) return undefined
  const record = recordField.value
  const bundled = bundledModIdentity(entity)
  const projectField = fields?.[MOD_PROJECT_FIELD]
  const familyField = fields?.['Crystal Edit model type']
  const family = bundled?.family ?? (familyField?.state === 'known' && typeof familyField.value === 'string' ? familyField.value : undefined)
  if (!family || typeof record.ID !== 'number' || bundled && bundled.modelId !== record.ID) return undefined
  const library = bundled && libraryByRevision.get(`${bundled.key}:${bundled.version}`)
  const bundledMetadata = nativeRecord(entity.legacy) && nativeRecord(entity.legacy.bundledMod) ? entity.legacy.bundledMod : undefined
  const digest = library ? typeof bundledMetadata?.sourceDigest === 'string' ? bundledMetadata.sourceDigest : library.sourceDigest.replace(/^sha256:/, '') : recordField.sources?.find(source => /^source:sha256:[a-f0-9]{64}$/.test(source.sourceId))?.sourceId.slice('source:sha256:'.length)
  if (!digest) return undefined
  const project = manifest.projects[digest]
  const projectId = library?.id ?? (projectField?.state === 'known' && typeof projectField.value === 'string' ? projectField.value : undefined)
  if (!project || projectId !== `crystal-edit:${project.projectId}`) return undefined
  const binding = project.entities[`${family}:${record.ID}`]
  const reference = modArtworkReference(family, record)
  if (!binding || binding.kind !== entity.kind || !reference || JSON.stringify(reference) !== JSON.stringify(binding.reference)) return undefined
  const asset = manifest.assets[binding.asset]
  const atlas = asset && manifest.atlases[asset.atlas]
  const url = atlas && urls[`../assets/mod-artwork-atlases/${atlas.file}`]
  if (!asset || !atlas || !url) return undefined
  const provenance = binding.sourceTextures.some(source => source.origin === 'mod-export') ? 'mod-export' as const : 'base-game-archive' as const
  return {
    source: 'mod' as const, asset: { ...asset, atlas: { width: atlas.width, height: atlas.height, region: asset.region }, title: `${project.title} ${project.version} artwork` }, url, provenance,
    binding: { kind: binding.kind, name: project.title, asset: binding.asset, origin: provenance, sources: binding.sourceTextures.map(source => ({ title: `${project.title} ${project.version}`, locator: `${source.origin === 'base-game-archive' ? 'Base game: ' : ''}${source.texturePath}${typeof binding.reference[1] === 'number' ? `, cell ${binding.reference[1]}` : ''}`, applicability: 'Exact texture reference from this mod source revision; other platforms and combined mod texture overrides are unverified' })) },
  }
}

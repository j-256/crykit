import manifestJson from './mod-artwork-runtime.json'
import { BUNDLED_MOD_LIBRARY } from './mod-library-metadata'
import { GAME_RECORD_FIELD } from '../domain/game-record-facts'
import { nativeRecord } from '../domain/native-game'
import { modArtworkReference } from '../domain/mod-artwork'
import type { CatalogEntity } from '../domain/types'
import { MOD_PROJECT_FIELD } from '../domain/mod-library'
import { parseSourceRevision } from '../domain/source-identity'

interface ArtworkBinding {
  readonly kind: string
  readonly asset: string
  readonly reference: readonly (string | number | null)[]
  readonly sourceTextures: readonly { readonly texturePath: string; readonly origin: 'mod-export' | 'base-game-archive' }[]
}
export interface ModArtworkManifest {
  readonly assets: Readonly<Record<string, { readonly file: string; readonly sha256: string; readonly width: number; readonly height: number; readonly license: string; readonly contentBounds: Region; readonly atlas: string; readonly region: Region }>>
  readonly atlases: Readonly<Record<string, { readonly file: string; readonly width: number; readonly height: number }>>
  readonly projects: Readonly<Record<string, { readonly projectId: string; readonly payloadSource: { readonly catalogId: string; readonly catalogRevisionId: string }; readonly title: string; readonly version: string; readonly entities: Readonly<Record<string, ArtworkBinding>> }>>
}
interface Region { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export type ModArtworkIdentity = Partial<Pick<CatalogEntity, 'fields' | 'legacy' | 'origins'>>
const manifest = manifestJson as unknown as ModArtworkManifest
const urls = import.meta.glob<string>('../assets/mod-artwork-atlases/*.png', { eager: true, query: '?url&no-inline', import: 'default' })
export const modSourceArtwork = createModArtworkResolver(manifest, urls, BUNDLED_MOD_LIBRARY)

export function createModArtworkResolver(manifest: ModArtworkManifest, urls: Readonly<Record<string, string>>, library: readonly import('../domain/mod-library').BundledLibraryMod[]) {
  const libraryByRevision = new Map(library.map(mod => [JSON.stringify([mod.id, mod.revisionId]), mod]))
  const projectsByPayload = new Map(Object.values(manifest.projects).map(project => [JSON.stringify([project.payloadSource.catalogId, project.payloadSource.catalogRevisionId]), project]))
  return function modSourceArtwork(entity: Pick<CatalogEntity, 'kind'> & ModArtworkIdentity) {
    const fields = entity.fields
    const recordField = fields?.[GAME_RECORD_FIELD]
    if (recordField?.state !== 'known' || !nativeRecord(recordField.value)) return undefined
    const record = recordField.value
    const origin = entity.origins?.mechanical
    if (!origin) return undefined
    const bundled = libraryByRevision.get(JSON.stringify([origin.catalogId, origin.catalogRevisionId]))
    const payloadSource = bundled?.payloadSource ?? origin
    const project = projectsByPayload.get(JSON.stringify([payloadSource.catalogId, payloadSource.catalogRevisionId]))
    const revision = parseSourceRevision('imported', payloadSource.catalogRevisionId)
    const projectField = fields?.[MOD_PROJECT_FIELD]
    const familyField = fields?.['Crystal Edit model type']
    const family = familyField?.state === 'known' && typeof familyField.value === 'string' ? familyField.value : undefined
    // Remapping changes runtime numeric IDs, but artwork belongs to the original source record
    const originalId = origin.entityId.split(':').at(-1)
    if (!project || revision?.kind !== 'imported' || revision.encoding !== 'j1' || !family || !originalId || !/^(0|[1-9][0-9]*)$/.test(originalId) || projectField?.state !== 'known' || projectField.value !== payloadSource.catalogId) return undefined
    if (!recordField.sources?.some(source => source.sourceId === `source:json-content-v1:sha256:${revision.digest}`)) return undefined
    const binding = project.entities[`${family}:${originalId}`]
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
}

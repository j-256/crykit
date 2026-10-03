import { jsonRecord } from '../domain/crystal-edit'
import { z } from 'zod'
import { MAX_MOD_SOURCE_BYTES, MAX_MOD_SOURCE_NODES } from '../domain/mod-library'
import { modCatalogForPin, modCatalogTitle } from '../domain/mod-layers'
import { WORLD_MARKER_KINDS, worldMapModLayer, worldMapTargetRef as targetRef } from '../domain/world-map'
import type { WorldMapDefinition, WorldMapManifest, WorldMapModLayer, WorldMapLayer, WorldMapTarget } from '../domain/world-map'
import type { CatalogRef, CatalogSnapshot, ModCatalogPin } from '../domain/types'
import { parseBoundedJson } from '../interchange/json'
import { readModSource } from '../persistence/mod-library'
import { BUNDLED_MOD_LIBRARY, bundledModEditableSource } from './mod-library'
import { NATIVE_GAME_DATA } from './native-game'

export function worldMapTargetRef(target: WorldMapTarget, catalogs: readonly CatalogSnapshot[]): CatalogRef | undefined { return targetRef(target, catalogs, BUNDLED_MOD_LIBRARY) }

const MANIFEST_URLS = import.meta.glob<string>('./world-map.json', { query: '?url', import: 'default', eager: true })
const IMAGE_URLS = import.meta.glob<string>('../assets/world-map/*.png', { query: '?url', import: 'default', eager: true })
const NATIVE_ID = z.number().int().nonnegative().max(0xffffffff)
const COORDINATE = z.number().finite()
const TARGET = z.object({ family: z.string(), id: NATIVE_ID, name: z.string(), sourceId: z.string(), sourceRevisionId: z.string().optional() })
const PROVENANCE = { sourceId: z.string().optional(), sourceName: z.string().optional(), sourceRevisionId: z.string().optional(), change: z.enum(['base', 'added', 'modified']).optional() }
const MANIFEST_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ platform: z.string(), gameVersion: z.string() }).passthrough(),
  bounds: z.object({ x: COORDINATE, z: COORDINATE, width: COORDINATE.positive(), height: COORDINATE.positive() }),
  layers: z.array(z.object({ id: NATIVE_ID, label: z.string(), image: z.string() })).min(1).max(32),
  regions: z.array(z.object({ id: NATIVE_ID, name: z.string(), layer: NATIVE_ID, x: COORDINATE, z: COORDINATE, ...PROVENANCE })).max(20_000),
  markers: z.array(z.object({ id: z.string(), entityId: NATIVE_ID, kind: z.enum(WORLD_MARKER_KINDS), sourceId: z.string(), sourceName: z.string(), sourceRevisionId: z.string().optional(), change: z.enum(['base', 'added', 'modified']), name: z.string(), region: z.string().nullable(), biomeId: NATIVE_ID, layer: NATIVE_ID.nullable(), x: COORDINATE, y: COORDINATE, z: COORDINATE, description: z.string(), targets: z.array(TARGET).max(20_000), conditions: z.array(z.string()).optional(), warnings: z.array(z.string()).optional() })).max(100_000),
}).passthrough()
let manifestPromise: Promise<WorldMapManifest> | undefined
const modPromises = new Map<string, Promise<WorldMapModLayer>>()

export function mapModPinKey(pin: ModCatalogPin): string { return JSON.stringify([pin.catalogId, pin.catalogRevisionId]) }

export function worldMapImage(layer: number | Pick<WorldMapLayer, 'image'>): string {
  return IMAGE_URLS[`../assets/world-map/${typeof layer === 'number' ? `layer-${layer}.png` : layer.image}`] ?? ''
}

export function validateWorldMapSource(manifest: WorldMapManifest): void {
  const system = NATIVE_GAME_DATA.source.files.find(file => file.path === 'Database/system.dat')
  const biomes = NATIVE_GAME_DATA.source.files.find(file => file.path === 'Database/biome.dat')
  const sourceBiomes = jsonRecord(manifest.source.biomes) ? manifest.source.biomes : undefined
  const sourceMatches = manifest.source.platform === NATIVE_GAME_DATA.source.platform && manifest.source.gameVersion === NATIVE_GAME_DATA.source.gameVersion && manifest.source.gameExecutableSha256 === NATIVE_GAME_DATA.source.executable.sha256 && manifest.source.nativeContentDigest === NATIVE_GAME_DATA.contentDigest && manifest.source.systemSha256 === system?.sha256 && sourceBiomes?.sha256 === biomes?.sha256
  const bounds = manifest.bounds
  const validBounds = [bounds.x, bounds.z, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0
  const layerIds = new Set(manifest.layers.map(layer => layer.id))
  const validImages = manifest.layers.length > 0 && layerIds.size === manifest.layers.length && manifest.layers.every(layer => Number.isSafeInteger(layer.id) && /^layer-\d+\.png$/.test(layer.image) && worldMapImage(layer))
  if (manifest.schemaVersion !== 1 || !sourceMatches || !validBounds || !validImages) throw new Error('The bundled world map does not match its native source or image assets.')
}

export function loadWorldMap(): Promise<WorldMapManifest> {
  manifestPromise ??= (async () => {
    const url = MANIFEST_URLS['./world-map.json']
    if (!url) throw new Error('The bundled world map is unavailable.')
    const response = await fetch(url)
    if (!response.ok) throw new Error(`The bundled world map could not be loaded (HTTP ${response.status}).`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > MAX_MOD_SOURCE_BYTES) throw new Error('The bundled world map exceeds its safe size limit.')
    const parsed = MANIFEST_SCHEMA.safeParse(parseBoundedJson(bytes, 'Bundled world map'))
    if (!parsed.success) throw new Error('The bundled world map is malformed.')
    const manifest: WorldMapManifest = parsed.data
    validateWorldMapSource(manifest)
    const definitions: WorldMapDefinition[] = []
    for (const [family, value] of Object.entries(NATIVE_GAME_DATA.databases)) {
      if (!Array.isArray(value)) continue
      for (const record of value) if (jsonRecord(record) && typeof record.ID === 'number' && typeof record.Name === 'string') definitions.push({ family, id: record.ID, name: record.Name, sourceId: 'base', record })
    }
    return { ...manifest, definitions }
  })().catch(error => { manifestPromise = undefined; throw error })
  return manifestPromise
}

export function loadMapModLayer(pin: ModCatalogPin, catalogs: readonly CatalogSnapshot[]): Promise<WorldMapModLayer> {
  const key = mapModPinKey(pin)
  const existing = modPromises.get(key)
  if (existing) return existing
  const catalog = modCatalogForPin(catalogs, pin)
  const bundled = BUNDLED_MOD_LIBRARY.find(mod => mod.id === pin.catalogId && (mod.sourceDigest === pin.catalogRevisionId || mod.sourceDigest === catalog?.checksum))
  const identity = { sourceId: pin.catalogId, sourceName: catalog ? modCatalogTitle(catalog) : bundled?.title ?? pin.catalogId, revisionId: pin.catalogRevisionId }
  const promise = (async () => {
    try {
      const source = catalog ? await readModSource(pin).catch(error => { if (bundled) return bundledModEditableSource(bundled); throw error }) : bundled ? await bundledModEditableSource(bundled) : undefined
      if (!source) return { ...identity, entities: [], definitions: [], warnings: ['This exact mod revision is unavailable. Import its original Crystal Edit JSON to preview it.'] }
      const root = parseBoundedJson(new TextEncoder().encode(source.text), source.filename, { maxNodes: MAX_MOD_SOURCE_NODES })
      if (!jsonRecord(root) || typeof root.ID !== 'string' || `crystal-edit:${root.ID}` !== pin.catalogId || typeof root.EditorVersion !== 'number' || !Number.isSafeInteger(root.EditorVersion) || root.EditorVersion < 0) throw new Error('The mod source project identity does not match its pinned catalog.')
      return worldMapModLayer(identity, root)
    } catch (error) {
      modPromises.delete(key)
      return { ...identity, entities: [], definitions: [], warnings: [error instanceof Error ? error.message : 'The original mod source could not be read.'] }
    }
  })()
  modPromises.set(key, promise)
  void promise.then(layer => { if (layer.warnings.length && !layer.entities.length && !layer.definitions.length) modPromises.delete(key) })
  return promise
}

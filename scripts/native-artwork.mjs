import { buildNativeCatalog, nativeIdentity, nativeSourceRecord } from '../src/domain/native-game.ts'
import { actorIconRegion, gameIconRegion, validateRegion } from './game-assets.mjs'

export const NO_NATIVE_ARTWORK = 'Native record has no supported direct artwork reference'
const INDEXED_FAMILIES = new Set(['item', 'equipment', 'ability', 'status'])

export function nativeArtworkEntries(snapshot) {
  const files = new Map(snapshot.source.files.map(file => [file.path, file]))
  return Object.values(buildNativeCatalog(snapshot).entities).filter(entity => nativeIdentity(entity) && nativeSourceRecord(entity)).map(entity => {
    const identity = nativeIdentity(entity)
    const file = identity.mode === 'base' ? `Database/${identity.database}.dat` : 'Database/patch.dat'
    return {
      id: entity.id, kind: entity.kind, name: entity.name,
      record: nativeSourceRecord(entity),
      nativeRecord: { ...identity, locator: entity.sources[0].locator, databaseSha256: files.get(file).sha256 },
    }
  })
}

export function nativeArtworkPlan(entry, textures) {
  const record = entry.record
  const family = entry.nativeRecord.database
  const source = (path, region, field) => {
    const texture = textures.get(path)
    if (!texture) throw new Error(`Native artwork texture is absent: ${path}`)
    validateRegion(region, texture, `Native artwork ${entry.id}`)
    return { ...(field ? { field } : {}), texturePath: path, textureSha256: texture.sha256, region }
  }
  if (family === 'job') {
    const variants = ['ActorTexturePathM', 'ActorTexturePathF']
    if (variants.some(field => typeof record[field] !== 'string' || !record[field])) return undefined
    const sources = variants.map(field => {
      const texture = textures.get(record[field])
      if (!texture) throw new Error(`Native artwork texture is absent: ${record[field]}`)
      return source(record[field], actorIconRegion(texture), field)
    })
    return { type: 'class', extraction: 'paired actor-sheet class icons', sourceTextures: sources }
  }
  if (typeof record.TexturePath !== 'string' || !record.TexturePath) return undefined
  const texture = textures.get(record.TexturePath)
  if (!texture) throw new Error(`Native artwork texture is absent: ${record.TexturePath}`)
  if (INDEXED_FAMILIES.has(family)) {
    return { type: 'icon', extraction: '32x32 indexed game icon cell', sourceTextures: [source(record.TexturePath, gameIconRegion(record.TextureIndex, texture))] }
  }
  if (family === 'monster') {
    return { type: 'monster', extraction: 'named monster texture', sourceTextures: [source(record.TexturePath, { x: 0, y: 0, width: texture.width, height: texture.height })] }
  }
  return undefined
}

export function validateNativeArtworkCoverage(manifest, entries, textures) {
  if (!Array.isArray(manifest.coverage?.nativeDefinitionGaps)) throw new Error('Native definition artwork coverage is absent')
  const gaps = new Map()
  for (const gap of manifest.coverage.nativeDefinitionGaps) {
    if (gaps.has(gap.id)) throw new Error(`Duplicate native definition artwork gap: ${gap.id}`)
    gaps.set(gap.id, gap)
  }
  const bound = new Set()
  for (const entry of entries) {
    const plan = nativeArtworkPlan(entry, textures)
    const binding = manifest.entities[entry.id]
    if (!plan) {
      const expected = { id: entry.id, kind: entry.kind, name: entry.name, nativeRecord: entry.nativeRecord, reason: NO_NATIVE_ARTWORK }
      if (JSON.stringify(gaps.get(entry.id)) !== JSON.stringify(expected) || binding?.nativeRecord) throw new Error(`Native definition artwork gap is stale: ${entry.id}`)
      gaps.delete(entry.id)
      continue
    }
    if (!binding || binding.kind !== entry.kind || (!binding.identity && binding.name !== entry.name) || JSON.stringify(binding.nativeRecord) !== JSON.stringify(entry.nativeRecord) || binding.database?.name !== entry.nativeRecord.database || binding.database.id !== entry.record.ID || binding.database.recordName !== entry.record.Name || JSON.stringify(binding.rendering) !== JSON.stringify({ extraction: plan.extraction, sourceTextures: plan.sourceTextures })) throw new Error(`Native definition artwork binding is stale: ${entry.id}`)
    if (plan.type === 'monster' && binding.asset !== plan.sourceTextures[0].textureSha256) throw new Error(`Native monster artwork differs from its full texture: ${entry.id}`)
    bound.add(entry.id)
  }
  if (gaps.size || Object.entries(manifest.entities).some(([id, binding]) => binding.nativeRecord && !bound.has(id))) throw new Error('Native definition artwork coverage contains unknown identities')
}

import { assertActiveProfile, trackProfileUrl, type ProfileToken } from '../account/profile'
import { MOD_PROJECT_FIELD } from '../domain/mod-library'
import { modArtworkReference } from '../domain/mod-artwork'
import { jsonRecord } from '../domain/crystal-edit'
import type { CatalogEntity, ModCatalogPin } from '../domain/types'
import { sha256 } from '../interchange/util'
import { openAccountRepository } from './account-repository'
import { blobIdentity, memoryBlob, readBlob } from './blobs'
import type { WorkspaceState } from './documents'
import type { WorkspaceAsset } from './file-types'
import { validateArtwork } from './artwork-validation'
import type { WorkspaceRepository } from './repository'
import { normalizeProjectPath } from './project-path'

const KEY_PREFIX = 'private-mod-artwork-v1:'

interface Binding { readonly source: ModCatalogPin; readonly archiveId: string; readonly digest: string; readonly family: string; readonly modelId: number; readonly kind: string; readonly reference: readonly (string | number | null)[]; readonly texturePath: string; readonly sourcePath?: string }
type ArtworkEntity = Pick<CatalogEntity, 'id' | 'kind' | 'fields'>

export function artworkSourceKey(bindings: readonly Binding[]): string { return `${KEY_PREFIX}${JSON.stringify(bindings)}` }

function parsedBindings(sourceKey: string): readonly Binding[] | undefined {
  if (!sourceKey.startsWith(KEY_PREFIX)) return undefined
  try { const value: unknown = JSON.parse(sourceKey.slice(KEY_PREFIX.length)); return Array.isArray(value) && value.length ? value as Binding[] : undefined }
  catch { return undefined }
}

function texturePaths(family: string, record: Readonly<Record<string, unknown>>): readonly string[] {
  if (family === 'Jobs') return [record.ActorTexturePathM, record.ActorTexturePathF].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return typeof record.TexturePath === 'string' && record.TexturePath ? [record.TexturePath] : []
}

function bindingForEntity(state: WorkspaceState, pin: ModCatalogPin, entity: ArtworkEntity, texturePath: string, sourcePath?: string): Binding | undefined {
  const catalog = state.planner.catalogs.find(value => value.id === pin.catalogId && value.revisionId === pin.catalogRevisionId)
  const digest = catalog?.checksum.replace(/^sha256:/, '')
  const source = state.planner.sources.find(value => value.digest === digest && value.original.sha256 === digest)
  const recordField = entity.fields['Crystal Edit source record']
  const projectField = entity.fields[MOD_PROJECT_FIELD]
  const familyField = entity.fields['Crystal Edit model type']
  const family = familyField?.state === 'known' && typeof familyField.value === 'string' ? familyField.value : undefined
  const record = recordField?.state === 'known' && jsonRecord(recordField.value) ? recordField.value : undefined
  const reference = family && record ? modArtworkReference(family, record) : undefined
  if (!catalog || !source || !family || !record || !reference || typeof record.ID !== 'number' || !Number.isSafeInteger(record.ID) || !texturePaths(family, record).includes(texturePath) || projectField?.state !== 'known' || projectField.value !== catalog.id || recordField?.state !== 'known' || !recordField.sources?.some(value => value.sourceId === source.id)) return undefined
  // Keep original archive identity distinct from the semantic json-content-v1 fingerprint
  return { source: pin, archiveId: source.id, digest: source.digest, family, modelId: record.ID, kind: entity.kind, reference, texturePath, ...(sourcePath === undefined ? {} : { sourcePath }) }
}

function textureMatchesFile(texturePath: string, relativePath: string): boolean {
  // Crystal Edit references omit an image extension; accept only that exact path with a supported suffix
  const stem = relativePath.replace(/\.(png|jpe?g|webp)$/i, '')
  return texturePath === relativePath || texturePath === stem
}

function textureFilePaths(sourcePath: string, relativePath: string): readonly string[] {
  // A companion directory is anchored to the selected JSON path captured at admission, not any matching suffix elsewhere
  const companionRoot = `${sourcePath.slice(0, -'.json'.length)}/`
  return relativePath.startsWith(companionRoot) ? [relativePath, relativePath.slice(companionRoot.length)] : [relativePath]
}

function artworkBindingForPath(state: WorkspaceState, pin: ModCatalogPin, relativePath: string, selectedSourcePath?: string, legacy = false): string {
  // Preserve the selected spelling in the private asset, but match only its safe normalized path
  const safeRelativePath = normalizeProjectPath(relativePath)
  const catalog = state.planner.catalogs.find(value => value.id === pin.catalogId && value.revisionId === pin.catalogRevisionId)
  if (!catalog) throw new Error('The exact mod revision is unavailable for artwork')
  const digest = catalog.checksum.replace(/^sha256:/, '')
  const source = state.planner.sources.find(value => value.digest === digest && value.original.sha256 === digest)
  if (!source) throw new Error('The exact mod source is unavailable for artwork')
  const sourcePath = legacy ? undefined : normalizeProjectPath(selectedSourcePath ?? source.filename)
  if (sourcePath && (selectedSourcePath && sourcePath !== selectedSourcePath || !/\.json$/i.test(sourcePath))) throw new Error('Artwork source path must be the chosen JSON path')
  const filePaths = sourcePath ? textureFilePaths(sourcePath, safeRelativePath) : [safeRelativePath]
  const matches = Object.values(catalog.entities).flatMap(entity => {
    const recordField = entity.fields['Crystal Edit source record']
    const familyField = entity.fields['Crystal Edit model type']
    const family = familyField?.state === 'known' && typeof familyField.value === 'string' ? familyField.value : undefined
    const record = recordField?.state === 'known' && jsonRecord(recordField.value) ? recordField.value : undefined
    return family && record ? texturePaths(family, record).filter(path => filePaths.some(filePath => textureMatchesFile(path, filePath))).flatMap(path => {
      const binding = bindingForEntity(state, pin, entity, path, sourcePath)
      return binding ? [binding] : []
    }) : []
  })
  if (!matches.length) throw new Error('Artwork path has no exact model texture match')
  if (new Set(matches.map(value => value.texturePath)).size !== 1) throw new Error('Artwork path ambiguously matches multiple texture paths')
  // One atlas may serve many exact models; retain each model's full declared reference
  return artworkSourceKey(matches.sort((left, right) => `${left.family}:${left.modelId}`.localeCompare(`${right.family}:${right.modelId}`)))
}

export function findArtworkBinding(state: WorkspaceState, pin: ModCatalogPin, relativePath: string, selectedSourcePath?: string): string {
  return artworkBindingForPath(state, pin, relativePath, selectedSourcePath)
}

function matchesStoredArtworkBinding(state: WorkspaceState, pin: ModCatalogPin, asset: WorkspaceAsset): boolean {
  const bindings = parsedBindings(asset.sourceKey)
  if (!bindings || bindings.some(value => value.sourcePath !== bindings[0]!.sourcePath)) return false
  // Earlier private bindings omitted sourcePath and matched only flat paths
  try { return asset.sourceKey === artworkBindingForPath(state, pin, asset.relativePath, bindings[0]!.sourcePath, bindings[0]!.sourcePath === undefined) }
  catch { return false }
}

function sameArtworkTarget(left: string, right: string): boolean {
  const leftBindings = parsedBindings(left), rightBindings = parsedBindings(right)
  if (!leftBindings || !rightBindings) return left === right
  // Reimporting identical source bytes under another folder replaces the same model artwork
  const target = (bindings: readonly Binding[]) => JSON.stringify(bindings.map(({ sourcePath: _sourcePath, ...binding }) => binding))
  return target(leftBindings) === target(rightBindings)
}

export function findPrivateArtwork(state: WorkspaceState, pin: ModCatalogPin, entity: ArtworkEntity): WorkspaceAsset | undefined {
  const field = entity.fields['Crystal Edit source record']
  const familyField = entity.fields['Crystal Edit model type']
  const family = familyField?.state === 'known' && typeof familyField.value === 'string' ? familyField.value : undefined
  const record = field?.state === 'known' && jsonRecord(field.value) ? field.value : undefined
  if (!family || !record) return undefined
  for (const path of texturePaths(family, record)) {
    const matches = state.assets.filter(asset => {
      const bindings = parsedBindings(asset.sourceKey)
      const binding = bindingForEntity(state, pin, entity, path, bindings?.[0]?.sourcePath)
      return Boolean(binding && bindings?.some(value => JSON.stringify(value) === JSON.stringify(binding)) && matchesStoredArtworkBinding(state, pin, asset))
    })
    if (matches.length === 1) return matches[0]
  }
  return undefined
}

export function findPrivateArtworkForEntity(state: WorkspaceState, catalogId: string, entity: ArtworkEntity, catalogRevisionId?: string): WorkspaceAsset | undefined {
  const recordField = entity.fields['Crystal Edit source record']
  const sourceId = recordField?.state === 'known' ? recordField.sources?.find(value => /^source:sha256:[a-f0-9]{64}$/.test(value.sourceId))?.sourceId : undefined
  if (!sourceId) return undefined
  const candidates = state.planner.catalogs.filter(value => value.id === catalogId && (!catalogRevisionId || value.revisionId === catalogRevisionId) && value.checksum === `sha256:${sourceId.slice('source:sha256:'.length)}` && value.entities[entity.id])
  if (candidates.length !== 1) return undefined
  return findPrivateArtwork(state, { catalogId: candidates[0]!.id, catalogRevisionId: candidates[0]!.revisionId }, entity)
}

export function privateArtworkRegion(entity: ArtworkEntity, asset: WorkspaceAsset): { x: number; y: number; width: number; height: number } | undefined {
  const familyField = entity.fields['Crystal Edit model type']
  const recordField = entity.fields['Crystal Edit source record']
  const family = familyField?.state === 'known' ? familyField.value : undefined
  const record = recordField?.state === 'known' && jsonRecord(recordField.value) ? recordField.value : undefined
  if (!record) return undefined
  let region: { x: number; y: number; width: number; height: number }
  if (family === 'Jobs') {
    // Same proportional actor icon region used by the source-backed native artwork extractor
    region = { x: Math.trunc(asset.width * 30 / 75), y: Math.trunc(asset.height * 7 / 144), width: Math.trunc(asset.width * 15 / 75), height: Math.trunc(asset.height * 15 / 144) }
  } else if (family === 'Monsters') region = { x: 0, y: 0, width: asset.width, height: asset.height }
  else {
    const index = record.TextureIndex
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return undefined
    // TextureIndex selects a 32x32 cell in a seven-column atlas; it is never a full-image hint
    region = { x: index % 7 * 34 + 2, y: Math.floor(index / 7) * 34 + 2, width: 32, height: 32 }
  }
  return region.width > 0 && region.height > 0 && region.x >= 0 && region.y >= 0 && region.x + region.width <= asset.width && region.y + region.height <= asset.height ? region : undefined
}

export async function prepareArtworkFile(state: WorkspaceState, pin: ModCatalogPin, relativePath: string, file: File, selectedSourcePath?: string, originalRelativePath = relativePath): Promise<{ state: WorkspaceState; asset: WorkspaceAsset }> {
  if (normalizeProjectPath(originalRelativePath) !== relativePath) throw new Error('Artwork original path differs from its reviewed path')
  const sourceKey = findArtworkBinding(state, pin, relativePath, selectedSourcePath)
  const { bytes, mediaType, width, height } = await validateArtwork(file)
  const id = crypto.randomUUID()
  const ref = { documentId: `asset:${id}`, revisionId: crypto.randomUUID(), byteLength: bytes.length, sha256: await sha256(bytes), encoding: 'bytes' as const }
  const asset: WorkspaceAsset = { version: 1, id, sourceKey, relativePath: originalRelativePath, original: ref, mediaType, width, height }
  const catalog = state.planner.catalogs.find(value => value.id === pin.catalogId && value.revisionId === pin.catalogRevisionId)!
  for (const binding of parsedBindings(sourceKey) ?? []) {
    const entity = Object.values(catalog.entities).find(value => value.kind === binding.kind && value.fields['Crystal Edit model type']?.state === 'known' && value.fields['Crystal Edit model type']?.value === binding.family && value.fields['Crystal Edit model ID']?.state === 'known' && value.fields['Crystal Edit model ID']?.value === binding.modelId)
    if (!entity || !privateArtworkRegion(entity, asset)) throw new Error('Texture atlas index or crop exceeds the selected image')
  }
  // The asset ID is an independent private manifest revision; the immutable catalog and source never change
  // Historical account closures may still point at the replaced encrypted original
  return { state: { ...state, assets: [...state.assets.filter(value => !sameArtworkTarget(value.sourceKey, sourceKey)), asset], blobs: [...state.blobs, { ref, content: memoryBlob(bytes) }] }, asset }
}

export async function attachSourceArtwork(repository: WorkspaceRepository, source: ModCatalogPin, assets: readonly WorkspaceAsset[]): Promise<void> {
  const before = await repository.readWorkspace()
  const catalog = before.planner.catalogs.find(value => value.id === source.catalogId && value.revisionId === source.catalogRevisionId)
  if (!catalog) throw new Error('The exact mod revision is unavailable')
  const referenced = new Set(before.blobs.map(value => blobIdentity(value.ref)))
  for (const asset of assets) {
    if (!asset.sourceKey.startsWith(KEY_PREFIX) || !referenced.has(blobIdentity(asset.original)) || asset.thumbnail && !referenced.has(blobIdentity(asset.thumbnail))) throw new Error('Artwork bytes must be staged in this captured workspace')
    if (!matchesStoredArtworkBinding(before, source, asset)) throw new Error('Artwork does not match the exact source and model')
    const original = before.blobs.find(value => blobIdentity(value.ref) === blobIdentity(asset.original))!
    const bytes = await readBlob(original.content, asset.original.byteLength)
    if (asset.original.encoding !== 'bytes' || await sha256(bytes) !== asset.original.sha256) throw new Error('Artwork original bytes changed')
    const checked = await validateArtwork(new File([bytes as BlobPart], asset.relativePath, { type: asset.mediaType }))
    if (checked.width !== asset.width || checked.height !== asset.height || checked.mediaType !== asset.mediaType) throw new Error('Artwork metadata differs from its decoded original')
    for (const binding of parsedBindings(asset.sourceKey) ?? []) {
      const entity = Object.values(catalog.entities).find(value => value.kind === binding.kind && value.fields['Crystal Edit model type']?.state === 'known' && value.fields['Crystal Edit model type']?.value === binding.family && value.fields['Crystal Edit model ID']?.state === 'known' && value.fields['Crystal Edit model ID']?.value === binding.modelId)
      if (!entity || !privateArtworkRegion(entity, asset)) throw new Error('Texture atlas index or crop exceeds the selected image')
    }
  }
  if (!assets.length) return
  if (assets.some((asset, index) => assets.slice(index + 1).some(value => sameArtworkTarget(value.sourceKey, asset.sourceKey)))) throw new Error('Duplicate artwork binding')
  await repository.commitWorkspace({ ...before, assets: [...before.assets.filter(value => !assets.some(asset => sameArtworkTarget(value.sourceKey, asset.sourceKey))), ...assets] }, before.planner.localData.revision)
}

export async function attachArtworkFile(repository: WorkspaceRepository, source: ModCatalogPin, relativePath: string, file: File): Promise<WorkspaceAsset> {
  const before = await repository.readWorkspace()
  const prepared = await prepareArtworkFile(before, source, normalizeProjectPath(relativePath), file, undefined, relativePath)
  await repository.commitWorkspace(prepared.state, before.planner.localData.revision)
  return prepared.asset
}

async function openFromRepository(repository: WorkspaceRepository, assetId: string, check: () => void): Promise<{ url: string; revoke: () => void }> {
  check()
  const state = await repository.readWorkspace()
  check()
  const asset = state.assets.find(value => value.id === assetId && value.sourceKey.startsWith(KEY_PREFIX))
  const body = asset && state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(asset.original))
  if (!asset || !body) throw new Error('Private artwork is unavailable')
  const bytes = await readBlob(body.content, asset.original.byteLength)
  check()
  if (await sha256(bytes) !== asset.original.sha256) throw new Error('Private artwork bytes changed')
  const file = new File([bytes as BlobPart], asset.relativePath, { type: asset.mediaType })
  const checked = await validateArtwork(file)
  check()
  if (checked.mediaType !== asset.mediaType || checked.width !== asset.width || checked.height !== asset.height) throw new Error('Private artwork metadata changed')
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: asset.mediaType }))
  try { check(); return { url, revoke: () => URL.revokeObjectURL(url) } }
  catch (error) { URL.revokeObjectURL(url); throw error }
}

export async function openPrivateArtwork(token: ProfileToken, assetId: string): Promise<{ url: string; revoke: () => void }> {
  const opened = await openFromRepository(await openAccountRepository(token), assetId, () => assertActiveProfile(token))
  try { trackProfileUrl(token, opened.url); return opened }
  catch (error) { opened.revoke(); throw error }
}

export function openLocalArtwork(repository: WorkspaceRepository, assetId: string): Promise<{ url: string; revoke: () => void }> {
  if (repository.kind !== 'guest') throw new Error('A captured local guest workspace is required')
  return openFromRepository(repository, assetId, () => {})
}

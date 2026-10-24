import { commitOwnedFile, type OwnedFileCommand, type OwnedFileOutcome } from './owned-file-command'
import { jsonRecord } from '../domain/crystal-edit'
import { chooseLibraryDefault, chooseLibraryVisibility, enableLibrarySourceForBuild, type LibraryImportChoices } from '../domain/mod-library-actions'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import type { CatalogId, CatalogRevisionId, ModCatalogPin, Timestamp } from '../domain/types'
import type { ImportFormat, ImportPreview } from '../interchange/types'
import { sha256 } from '../interchange/util'
import { modContentFingerprint } from '../interchange/mod-content'
import { prepareWorkspaceImport } from './import-commands'
import { blobIdentity, readBlob } from './blobs'
import type { WorkspaceRepository } from './repository'
import type { WorkspaceState } from './documents'

export interface LibrarySource {
  readonly sourceArchiveId: string
  readonly originalDigest: string
  readonly semanticFingerprint: string
  readonly catalogId: CatalogId
  readonly catalogRevisionId: CatalogRevisionId
  readonly filename: string
  readonly importedAt: Timestamp
  readonly format: ImportFormat
  readonly mediaType: string
  readonly declaredWorkshopId?: string
}
export interface LibraryImportReceipt extends LibrarySource {
  readonly checkpointId?: string
  readonly defaultTemplateRevision?: number
  readonly savedArtworkCount?: number
  readonly excludedArtwork?: readonly { readonly relativePath: string; readonly reason: string }[]
}

export async function readLibrarySource(repository: WorkspaceRepository, pin: ModCatalogPin): Promise<{ readonly filename: string; readonly bytes: Uint8Array; readonly text: string }> {
  const state = await repository.readWorkspace()
  const catalog = state.planner.catalogs.find(value => value.id === pin.catalogId && value.revisionId === pin.catalogRevisionId && value.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA)
  if (!catalog) throw new Error('The saved mod revision is unavailable')
  // Semantic matches cannot authorize a different original archive for this exact catalog pin
  const digest = catalog.checksum.replace(/^sha256:/, '')
  const source = state.planner.sources.find(value => value.digest === digest && value.original.sha256 === digest)
  const body = source && state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(source.original))
  if (!source || !body) throw new Error('The original mod source is unavailable')
  const bytes = await readBlob(body.content, source.original.byteLength)
  if (await sha256(bytes) !== digest) throw new Error('The original mod source changed')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  await repository.load()
  return { filename: source.filename, bytes, text }
}

export async function previewLibrarySource(preview: ImportPreview): Promise<LibrarySource> {
  const catalog = preview.proposed.catalogs[0]
  const source = preview.proposed.sources[0]
  if (preview.detectedFormat !== CRYSTAL_EDIT_CATALOG_SCHEMA || preview.errors.length || preview.proposed.catalogs.length !== 1 || preview.proposed.sources.length !== 1 || !catalog || !source || catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA || catalog.checksum !== `sha256:${source.digest}` || preview.sourceDigest !== source.digest || source.id !== `source:sha256:${source.digest}` || await sha256(source.bytes) !== source.digest) throw new Error('A verified single-project Crystal Edit source is required')
  const legacy = jsonRecord(catalog.legacy) ? catalog.legacy : undefined
  const fingerprint = legacy?.contentFingerprint
  if (typeof fingerprint !== 'string' || !/^json-content-v1:sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new Error('The mod source has no verified content fingerprint')
  if (await modContentFingerprint(source.bytes) !== fingerprint) throw new Error('The mod source fingerprint does not match its original bytes')
  return { sourceArchiveId: source.id, originalDigest: source.digest, semanticFingerprint: fingerprint, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, filename: source.filename, importedAt: source.importedAt, format: source.format, mediaType: source.mediaType, ...(typeof legacy?.steamWorkshopFileId === 'string' ? { declaredWorkshopId: legacy.steamWorkshopFileId } : {}) }
}

export async function importLibrarySource(repository: WorkspaceRepository, preview: ImportPreview, choices: LibraryImportChoices): Promise<LibraryImportReceipt> {
  const before = await repository.readWorkspace()
  const prepared = await prepareLibrarySourceImport(before, preview, choices)
  await repository.commitWorkspace(prepared.state, before.planner.localData.revision)
  return prepared.receipt
}

// Folder artwork joins this prepared state before the single repository commit
export async function prepareLibrarySourceImport(before: WorkspaceState, preview: ImportPreview, choices: LibraryImportChoices): Promise<{ state: WorkspaceState; receipt: LibraryImportReceipt }> {
  const source = await previewLibrarySource(preview)
  if (choices.enableTarget?.kind === 'team') throw new Error('Team checkpoint mod changes will be available after shared Team setup is added')
  const prepared = await prepareWorkspaceImport(before, preview, { mode: 'add-reference', targetLocalDataId: before.planner.localData.id, expectedRevision: before.planner.localData.revision })
  const archived = prepared.state.planner.sources.find(value => value.id === source.sourceArchiveId && value.digest === source.originalDigest)
  if (!archived) throw new Error('The exact imported source archive is unavailable')
  const catalog = prepared.state.planner.catalogs.find(value => value.id === source.catalogId && value.revisionId === source.catalogRevisionId)
  if (!catalog) throw new Error('The exact imported catalog is unavailable')
  let localData = chooseLibraryVisibility(prepared.state.planner.localData, catalog, choices.inReference)
  if (choices.enableTarget?.kind === 'build') localData = enableLibrarySourceForBuild(localData, catalog, prepared.state.planner.catalogs, choices.enableTarget.id, choices.enableTarget.expectedRevision)
  const next = { ...prepared.state, planner: { ...prepared.state.planner, localData }, libraryDefaults: chooseLibraryDefault(prepared.state.libraryDefaults, catalog, choices.futureDefault) }
  return { state: next, receipt: { ...source, filename: archived.filename, importedAt: archived.importedAt, format: archived.format, mediaType: archived.mediaType, ...(choices.enableTarget ? { checkpointId: localData.builds[choices.enableTarget.id]?.latestRevisionId } : {}), ...(choices.futureDefault ? { defaultTemplateRevision: before.planner.localData.revision + 1 } : {}) } }
}

// Picker imports add only source ownership; enabled selections remain in the unsaved form
export async function importOwnedLibrarySource(repository: WorkspaceRepository, preview: ImportPreview, command: OwnedFileCommand, expected: { readonly id: string; readonly revision: number }): Promise<OwnedFileOutcome> {
  if (command.operation !== 'libraryImport') throw new Error('A captured library import is required')
  const captured = structuredClone(preview)
  let before: Awaited<ReturnType<WorkspaceRepository['readWorkspace']>>, next: Awaited<ReturnType<WorkspaceRepository['readWorkspace']>>
  try {
    command.assertMayActivate()
    await previewLibrarySource(captured)
    command.assertMayActivate()
    before = await repository.readWorkspace()
    if (before.planner.localData.id !== expected.id || before.planner.localData.revision !== expected.revision) throw new Error('The saved Build base changed before importing')
    const prepared = await prepareWorkspaceImport(before, captured, { mode: 'add-reference', targetLocalDataId: before.planner.localData.id, expectedRevision: expected.revision })
    command.assertMayActivate()
    const catalog = captured.proposed.catalogs[0]!
    // Reference defaults to inclusion for unknown IDs, so a newly owned private source needs explicit exclusion
    // Importing another version of an existing project must retain that project's visibility choice
    const localData = before.planner.catalogs.some(value => value.id === catalog.id)
      ? prepared.state.planner.localData
      : chooseLibraryVisibility(prepared.state.planner.localData, catalog, false)
    next = { ...prepared.state, planner: { ...prepared.state.planner, localData } }
  } catch (error) { return { status: 'not-saved', error } }
  // The committer reconciles publication failures; never label a rejected post-pointer result as rollback
  try { return await commitOwnedFile(repository, before, next, command) }
  catch (error) { return { status: 'uncertain', error } }
}

import { MAX_MOD_SOURCE_BYTES } from '../domain/mod-library'
import { jsonRecord } from '../domain/crystal-edit'
import { modCatalogTitle } from '../domain/mod-layers'
import type { LibraryImportChoices } from '../domain/mod-library-actions'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import type { ImportPreview } from '../interchange/types'
import { prepareLibrarySourceImport, previewLibrarySource, type LibraryImportReceipt } from './mod-repository'
import { validateArtwork, maxImageBytes } from './artwork-validation'
import { prepareArtworkFile } from './artwork-repository'
import { normalizeProjectPath } from './project-path'
export { normalizeProjectPath } from './project-path'
import type { WorkspaceRepository } from './repository'

export interface FolderFile { readonly relativePath: string; readonly file: File }
export interface FolderProjectCandidate {
  readonly projectId: string
  readonly sourceId: string
  readonly relativePath: string
  readonly originalRelativePath: string
  readonly title: string
  readonly declaredVersion?: string
  readonly byteLength: number
  readonly importPreview: ImportPreview
}
export interface FolderAssetCandidate {
  readonly relativePath: string
  readonly originalRelativePath: string
  readonly byteLength: number
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly width: number
  readonly height: number
  readonly file: File
}
export interface FolderImportPreview {
  readonly projects: readonly FolderProjectCandidate[]
  readonly uploadCandidates: readonly FolderAssetCandidate[]
  readonly selectedArtwork: readonly []
  readonly excludedFiles: readonly { readonly relativePath: string; readonly reason: string }[]
  readonly unresolvedAssociations: readonly string[]
  readonly totalBytes: number
}
export interface FolderSelection {
  readonly projects: readonly { readonly projectId: string; readonly sourceId: string; readonly relativePath: string; readonly choices: LibraryImportChoices }[]
  readonly assets: readonly { readonly relativePath: string; readonly projectId: string; readonly sourceId: string; readonly projectRelativePath?: string }[]
}

const MAX_FILES = 4096
const MAX_PREVIEW_BYTES = 256 * 1024 * 1024
const MAX_IMAGE_BYTES = maxImageBytes
async function previewImage(file: File, relativePath: string, originalRelativePath: string): Promise<FolderAssetCandidate> {
  const { mediaType, width, height } = await validateArtwork(file)
  return { relativePath, originalRelativePath, file, byteLength: file.size, mediaType, width, height }
}

export async function previewModFolder(files: readonly FolderFile[]): Promise<FolderImportPreview> {
  if (files.length > MAX_FILES) throw new Error('Too many files selected')
  const paths = new Map<string, string>()
  // Reject the complete ambiguous selection before reading any file body
  const entries = files.map(entry => ({ ...entry, safePath: normalizeProjectPath(entry.relativePath) }))
  for (const entry of entries) {
    const key = entry.safePath.toLocaleLowerCase('en-US')
    if (paths.has(key)) throw new Error(`Duplicate or case-ambiguous path: ${entry.safePath}`)
    paths.set(key, entry.safePath)
  }
  const projects: FolderProjectCandidate[] = []
  const uploadCandidates: FolderAssetCandidate[] = []
  const excludedFiles: { relativePath: string; reason: string }[] = []
  let totalBytes = 0
  let previewBytes = 0
  for (const entry of entries) {
    const relativePath = entry.safePath
    totalBytes += entry.file.size
    if (/\.json$/i.test(relativePath)) {
      if (!entry.file.size || entry.file.size > MAX_MOD_SOURCE_BYTES) { excludedFiles.push({ relativePath, reason: 'JSON is empty or exceeds the source limit' }); continue }
      previewBytes += entry.file.size
      if (previewBytes > MAX_PREVIEW_BYTES) throw new Error('Selected mod sources and images exceed the 256 MiB preview limit')
      try {
        const importPreview = await previewCrystalEdit(new Uint8Array(await entry.file.arrayBuffer()), entry.relativePath)
        const source = await previewLibrarySource(importPreview)
        const catalog = importPreview.proposed.catalogs[0]!
        const legacy = jsonRecord(catalog.legacy) ? catalog.legacy : undefined
        projects.push({ projectId: String(catalog.id).slice('crystal-edit:'.length), sourceId: source.sourceArchiveId, relativePath, originalRelativePath: entry.relativePath, title: modCatalogTitle(catalog), ...(typeof legacy?.projectVersion === 'string' ? { declaredVersion: legacy.projectVersion } : {}), byteLength: entry.file.size, importPreview })
      } catch (error) { excludedFiles.push({ relativePath, reason: error instanceof Error ? error.message : 'Unsupported Crystal Edit JSON' }) }
    } else if (/\.(png|jpe?g|webp)$/i.test(relativePath)) {
      if (entry.file.size <= MAX_IMAGE_BYTES) previewBytes += entry.file.size
      if (previewBytes > MAX_PREVIEW_BYTES) throw new Error('Selected mod sources and images exceed the 256 MiB preview limit')
      try { uploadCandidates.push(await previewImage(entry.file, relativePath, entry.relativePath)) }
      catch (error) { excludedFiles.push({ relativePath, reason: error instanceof Error ? error.message : 'Image could not be decoded' }) }
    } else excludedFiles.push({ relativePath, reason: 'Not a supported Crystal Edit JSON or image' })
  }
  return { projects, uploadCandidates, selectedArtwork: [], excludedFiles, unresolvedAssociations: uploadCandidates.map(asset => asset.relativePath), totalBytes }
}

export async function confirmModFolder(repository: WorkspaceRepository, preview: FolderImportPreview, selection: FolderSelection): Promise<readonly LibraryImportReceipt[]> {
  // One selected source and its valid artwork are one prepared closure and one repository commit
  if (selection.projects.length !== 1) throw new Error('Select exactly one project revision for each import')
  const chosen = selection.projects[0]!
  const candidate = preview.projects.find(project => project.projectId === chosen.projectId && project.sourceId === chosen.sourceId && project.relativePath === chosen.relativePath)
  if (!candidate) throw new Error('The selected project revision is not in this preview')
  const selected = selection.assets.map(asset => {
    if (asset.projectId !== chosen.projectId || asset.sourceId !== chosen.sourceId || asset.projectRelativePath !== chosen.relativePath) throw new Error('Artwork must be associated with the selected exact revision')
    const file = preview.uploadCandidates.find(value => value.relativePath === asset.relativePath)
    if (!file) throw new Error('Selected artwork is not in this preview')
    return file
  })
  if (new Set(selected.map(asset => asset.relativePath)).size !== selected.length) throw new Error('Artwork was selected more than once')
  const before = await repository.readWorkspace()
  const prepared = await prepareLibrarySourceImport(before, candidate.importPreview, chosen.choices)
  let next = prepared.state
  const excludedArtwork: { relativePath: string; reason: string }[] = []
  let savedArtworkCount = 0
  const savedBindings = new Set<string>()
  for (const asset of selected) {
    try {
      const preparedArtwork = await prepareArtworkFile(next, { catalogId: prepared.receipt.catalogId, catalogRevisionId: prepared.receipt.catalogRevisionId }, asset.relativePath, asset.file, chosen.relativePath, asset.originalRelativePath)
      if (savedBindings.has(preparedArtwork.asset.sourceKey)) throw new Error('Another selected image already supplies this exact texture')
      next = preparedArtwork.state
      savedBindings.add(preparedArtwork.asset.sourceKey)
      savedArtworkCount++
    } catch (error) { excludedArtwork.push({ relativePath: asset.relativePath, reason: error instanceof Error ? error.message : 'Artwork could not be prepared' }) }
  }
  if (excludedArtwork.length) throw new Error(`Selected artwork could not be saved: ${excludedArtwork.map(value => `${value.relativePath} (${value.reason})`).join('; ')}. Deselect it and save the JSON source, or choose matching artwork.`)
  // No source or asset becomes usable unless the complete selected state activates
  await repository.commitWorkspace(next, before.planner.localData.revision)
  return [{ ...prepared.receipt, savedArtworkCount, excludedArtwork }]
}

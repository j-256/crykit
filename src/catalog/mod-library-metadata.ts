import sources from './bundled-mod-sources.json' with { type: 'json' }
import defaults from './mod-defaults.json' with { type: 'json' }
import type { BundledLibraryMod } from '../domain/mod-library'
import type { CatalogId } from '../domain/types'
import { SOURCE_REVISION_RECEIPTS } from './source-revisions'
import { parseCatalogSourceId, parseSourceRevision } from '../domain/source-identity'

export interface BundledModSource {
  readonly key: string
  readonly revisionId: string
  readonly projectId: string
  readonly title: string
  readonly version?: string
  readonly editorVersion: number
  readonly sha256: string
  readonly sourceBytes: number
  readonly timestamp?: string
  readonly steamWorkshopFileId?: string
  readonly models: Readonly<Record<string, readonly number[]>>
}
export const BUNDLED_MOD_SOURCES = sources.mods as readonly BundledModSource[]
const PROJECTS = new Map(defaults.projects.map(project => [project.projectId, project]))
const starterProjects = new Set(defaults.projects.filter(project => project.starter).map(project => project.projectId))
export const STARTER_MOD_PROJECT_IDS = [...new Set(BUNDLED_MOD_SOURCES.filter(source => starterProjects.has(source.projectId)).map(source => `crystal-project/mod/${source.key}` as CatalogId))]

export const BUNDLED_MOD_LIBRARY: readonly BundledLibraryMod[] = BUNDLED_MOD_SOURCES.map(source => {
  const id = `crystal-project/mod/${source.key}` as CatalogId
  const receipt = SOURCE_REVISION_RECEIPTS.find(receipt => receipt.id === id && receipt.revisionId === source.revisionId)
  if (parseCatalogSourceId(id)?.origin !== 'mod' || !parseSourceRevision('mod', source.revisionId) || !receipt?.payloadSource) throw new Error('Bundled mods require an immutable source receipt')
  return {
    id, projectId: source.projectId, revisionId: source.revisionId as BundledLibraryMod['revisionId'], payloadSource: receipt.payloadSource as BundledLibraryMod['payloadSource'], payloadChecksum: receipt.checksum, key: source.key, title: source.title, declaredVersion: source.version, editorVersion: source.editorVersion, sourceDigest: `sha256:${source.sha256}`, steamWorkshopFileId: source.steamWorkshopFileId, models: source.models, catalogNames: [...PROJECTS.get(source.projectId)?.names ?? [], source.title],
    ...(PROJECTS.get(source.projectId)?.sourceRecordField ? { sourceRecordField: PROJECTS.get(source.projectId)!.sourceRecordField } : {}),
    ...(PROJECTS.get(source.projectId)?.nativeBaseReplacements ? { nativeBaseReplacements: true } : {}),
  }
})

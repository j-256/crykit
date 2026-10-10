import sources from './bundled-mod-sources.json' with { type: 'json' }
import defaults from './mod-defaults.json' with { type: 'json' }
import type { BundledLibraryMod } from '../domain/mod-library'
import type { CatalogId } from '../domain/types'

export interface BundledModSource {
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
export const STARTER_MOD_PROJECT_IDS = [...new Set(BUNDLED_MOD_SOURCES.filter(source => starterProjects.has(source.projectId)).map(source => `crystal-edit:${source.projectId}` as CatalogId))]

export const BUNDLED_MOD_LIBRARY: readonly BundledLibraryMod[] = BUNDLED_MOD_SOURCES.map(source => ({
  id: `crystal-edit:${source.projectId}` as CatalogId, key: PROJECTS.get(source.projectId)?.key ?? source.projectId, title: source.title, declaredVersion: source.version, editorVersion: source.editorVersion, sourceDigest: `sha256:${source.sha256}`, steamWorkshopFileId: source.steamWorkshopFileId, models: source.models, catalogNames: [...PROJECTS.get(source.projectId)?.names ?? [], source.title],
  ...(PROJECTS.get(source.projectId)?.sourceRecordField ? { sourceRecordField: PROJECTS.get(source.projectId)!.sourceRecordField } : {}),
  ...(PROJECTS.get(source.projectId)?.nativeBaseReplacements ? { nativeBaseReplacements: true } : {}),
}))

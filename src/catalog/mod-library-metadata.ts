import sources from './bundled-mod-sources.json' with { type: 'json' }
import defaults from './mod-defaults.json' with { type: 'json' }
import type { BundledLibraryMod } from '../domain/mod-library'
import type { CatalogId } from '../domain/types'

const PROJECTS = new Map(defaults.projects.map(project => [project.projectId, project]))
export const STARTER_MOD_PROJECT_IDS = defaults.projects.filter(project => project.starter).map(project => `crystal-edit:${project.projectId}` as CatalogId)

export const BUNDLED_MOD_LIBRARY: readonly BundledLibraryMod[] = sources.mods.map(source => ({
  id: `crystal-edit:${source.projectId}` as CatalogId, key: PROJECTS.get(source.projectId)?.key ?? source.projectId, title: source.title, declaredVersion: source.version, editorVersion: source.editorVersion, sourceDigest: `sha256:${source.sha256}`, steamWorkshopFileId: source.steamWorkshopFileId, models: source.models, catalogNames: [...PROJECTS.get(source.projectId)?.names ?? [], source.title],
  ...(PROJECTS.get(source.projectId)?.sourceRecordField ? { sourceRecordField: PROJECTS.get(source.projectId)!.sourceRecordField } : {}),
  ...(PROJECTS.get(source.projectId)?.nativeBaseReplacements ? { nativeBaseReplacements: true } : {}),
}))

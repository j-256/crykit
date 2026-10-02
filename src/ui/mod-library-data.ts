import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library'
import { SWITCH_MOD_PACKS } from '../catalog/mods'
import { completeModLibrary, modLibraryCards, MOD_PROJECT_FIELD, type ModCatalogEntry } from '../domain/mod-library'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import { recordedModNames } from '../domain/mods'
import { definitionLineageRootRef } from '../domain/definitions'
import type { CatalogId, CatalogSnapshot, LocalData } from '../domain/types'
import type { DefinitionOption } from './definitions'

export function modCatalogEntry(option: DefinitionOption, catalogs: readonly CatalogSnapshot[], data: LocalData): ModCatalogEntry {
  const name = option.record.fields['Source mod']
  const project = option.record.fields[MOD_PROJECT_FIELD]
  const ref = option.ref
  const rootRef = definitionLineageRootRef(data, ref)
  const sourceProject = rootRef.kind === 'catalog' && catalogs.some(catalog => catalog.id === rootRef.catalogId && catalog.revisionId === rootRef.catalogRevisionId && catalog.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA) ? rootRef.catalogId : undefined
  const explicitProject = project?.state === 'known' && typeof project.value === 'string' ? project.value as CatalogId : undefined
  return { key: option.key, name: option.modAvailability?.requiredMod ?? (name?.state === 'known' && typeof name.value === 'string' ? name.value : undefined), projectId: ref.kind === 'catalog' ? sourceProject ?? explicitProject : explicitProject ?? sourceProject, projectRevisionId: sourceProject && ref.kind === 'catalog' ? ref.catalogRevisionId : undefined, sourceIds: option.record.sources.map(source => source.sourceId) }
}

export function buildModLibraryCards(catalogs: readonly CatalogSnapshot[], options: readonly DefinitionOption[], data: LocalData) {
  const names = [...SWITCH_MOD_PACKS.flatMap(pack => pack.mods), ...Object.values(data.gameSetups).flatMap(recordedModNames)]
  return modLibraryCards(completeModLibrary(catalogs, BUNDLED_MOD_LIBRARY), names, options.filter(option => option.preferred).map(option => modCatalogEntry(option, catalogs, data)))
}

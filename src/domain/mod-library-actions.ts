import { referenceLibraryWithMod } from './reference-library'
import type { CatalogId, CatalogSnapshot, LocalData, ModLayer } from './types'
import type { LibraryDefaults } from '../workspace/file-types'
import { buildBehavior, saveBuildBehavior, type BuildBehavior } from './build-behavior'
import { selectBuildModRevision } from './build-mods'
import { saveBuildRevision } from './builds'
import { CRYSTAL_EDIT_CATALOG_SCHEMA, modCatalogTitle } from './mod-layers'
import { jsonRecord } from './crystal-edit'

export interface LibraryImportChoices {
  readonly inReference: boolean
  readonly futureDefault: boolean
  readonly enableTarget?: { readonly kind: 'build' | 'team'; readonly id: string; readonly expectedRevision: number }
}

export function chooseLibraryVisibility(data: LocalData, catalog: CatalogSnapshot, included: boolean): LocalData {
  const referenceLibrary = referenceLibraryWithMod(data.referenceLibrary, catalog.id, included)
  return { ...data, referenceLibrary }
}

export function chooseLibraryDefault(defaults: LibraryDefaults, catalog: CatalogSnapshot, enabled: boolean): LibraryDefaults {
  if (!enabled) return defaults
  const layer: ModLayer = { catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: true }
  const layers = defaults.layers.some(value => value.catalogId === catalog.id)
    ? defaults.layers.map(value => value.catalogId === catalog.id ? layer : value)
    : [...defaults.layers, layer]
  return { version: 1, layers }
}

export function assertLibraryProject(catalogId: CatalogId, expected?: CatalogId): void {
  if (expected && catalogId !== expected) throw new Error('The mod source belongs to a different project ID')
}

function libraryReceipt(catalog: CatalogSnapshot) {
  const legacy = jsonRecord(catalog.legacy) ? catalog.legacy : undefined
  return { catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, title: modCatalogTitle(catalog), ...(typeof legacy?.contentFingerprint === 'string' ? { contentFingerprint: legacy.contentFingerprint } : {}) }
}

export function applyLibraryDefaultsToNewSetup(behavior: BuildBehavior, defaults: LibraryDefaults, catalogs: readonly CatalogSnapshot[]): BuildBehavior {
  let selected = behavior
  for (const layer of defaults.layers.filter(value => value.enabled)) {
    const catalog = catalogs.find(value => value.id === layer.catalogId && value.revisionId === layer.catalogRevisionId && value.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA)
    if (!catalog) throw new Error('A default mod source is unavailable. Reopen the mod library before creating this Game Setup')
    selected = selectBuildModRevision(selected, catalog, catalogs)
    selected = { ...selected, modSourceReceipts: [...selected.modSourceReceipts?.filter(value => value.catalogId !== catalog.id) ?? [], libraryReceipt(catalog)] }
  }
  return selected
}

export function enableLibrarySourceForBuild(data: LocalData, catalog: CatalogSnapshot, catalogs: readonly CatalogSnapshot[], buildId: string, expectedRevision: number): LocalData {
  if (catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA || !catalogs.some(value => value.id === catalog.id && value.revisionId === catalog.revisionId && value.checksum === catalog.checksum)) throw new Error('The exact mod source is not in this library')
  const build = data.builds[buildId]
  if (!build || build.revision !== expectedRevision) throw new Error('The Build changed. Reopen it before saving this mod choice')
  const checkpoint = build.latestRevisionId && data.buildRevisions[build.latestRevisionId]
  const setup = checkpoint && data.gameSetups[checkpoint.gameSetupRevisionId]
  if (!checkpoint || !setup || checkpoint.buildId !== build.id) throw new Error('A saved Build checkpoint and Game Setup are required')
  const behavior = selectBuildModRevision(buildBehavior(setup), catalog, catalogs)
  const receipts = [...behavior.modSourceReceipts?.filter(value => value.catalogId !== catalog.id) ?? [], libraryReceipt(catalog)]
  const selected = saveBuildBehavior(data, { ...behavior, modSourceReceipts: receipts })
  return saveBuildRevision(selected.localData, { buildId: build.id, parentRevisionId: checkpoint.id, gameSetupRevisionId: selected.setup.id, content: checkpoint.content, note: checkpoint.note, expectedRevision: selected.localData.revision })
}

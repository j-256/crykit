import { CURRENT_CATALOG } from '../catalog/bundled'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import { buildBehavior, saveBuildBehavior } from './build-behavior'
import { selectBuildModRevision } from './build-mods'
import { updateLocalData, assertExpectedRevision, DomainError, nowTimestamp } from './core'
import { setPlaythroughGameSetup } from './local-data'
import { isModSearchPreview } from './mod-search'
import { modModelRecords } from './mod-layers'
import { updateModSelections } from './mods'
import type { CatalogSnapshot, LocalData } from './types'

export function configureModSetup(data: LocalData, selected: readonly CatalogSnapshot[], catalogs: readonly CatalogSnapshot[], expectedRevision: number, skip = false): LocalData {
  assertExpectedRevision(data, expectedRevision)
  if (skip) return updateLocalData(data, { modSetup: { version: 1, state: 'skipped' } }, 'mods.setup-skip', ['modSetup'], nowTimestamp())
  const current = data.planningGameSetupRevisionId && data.gameSetups[data.planningGameSetupRevisionId]
  if (!current) throw new DomainError('MISSING_GAME_SETUP', 'Choose a starting Game Setup before selecting mods')
  if (new Set(selected.map(catalog => catalog.id)).size !== selected.length || selected.some(isModSearchPreview)) throw new DomainError('INVALID_INPUT', 'Choose one fully loaded source revision per mod')
  const reset = updateModSelections(current, BUNDLED_MOD_LIBRARY.flatMap(mod => (mod.catalogNames ?? [mod.title]).map(name => ({ name, state: 'unknown' as const }))))
  const retainedLayers = current.modComposition?.layers.filter(layer => !BUNDLED_MOD_LIBRARY.some(mod => mod.id === layer.catalogId)) ?? []
  const retainedKeys = new Set(retainedLayers.flatMap(layer => {
    const catalog = catalogs.find(candidate => candidate.id === layer.catalogId && candidate.revisionId === layer.catalogRevisionId)
    if (!catalog) throw new DomainError('INVALID_INPUT', 'Load the existing imported mod revision before changing bundled choices')
    return [...modModelRecords(catalog).keys()]
  }))
  const links = current.modComposition?.links.filter(link => retainedKeys.has(link.modelKey) && (link.targetEntityId === null || CURRENT_CATALOG.entities[link.targetEntityId])) ?? []
  let behavior = { ...buildBehavior(current), ...reset, label: 'Selected mods', catalogLock: { ...current.catalogLock, [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, modComposition: { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: retainedLayers, links } } as ReturnType<typeof buildBehavior>
  if (!retainedLayers.length && !selected.length) behavior = { ...behavior, modComposition: undefined }
  for (const catalog of selected) behavior = selectBuildModRevision(behavior, catalog, catalogs)
  const configured = saveBuildBehavior(data, behavior)
  let next = updateLocalData(configured.localData, { planningGameSetupRevisionId: configured.setup.id, modSetup: { version: 1, state: 'completed' }, referenceLibrary: { version: 1, excludedMods: [...new Set([...(data.referenceLibrary?.excludedMods ?? []).filter(id => !BUNDLED_MOD_LIBRARY.some(mod => mod.id === id)), ...BUNDLED_MOD_LIBRARY.filter(mod => !selected.some(catalog => catalog.id === mod.id)).map(mod => mod.id)])] } }, 'mods.setup-configure', ['planningGameSetupRevisionId', 'modSetup', 'referenceLibrary'], nowTimestamp())
  if (next.selectedPlaythroughId) next = setPlaythroughGameSetup(next, { playthroughId: next.selectedPlaythroughId, gameSetupRevisionId: configured.setup.id, expectedRevision: next.revision })
  return next
}

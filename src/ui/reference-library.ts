import { modCardIncludesEntry, modLibrary } from '../domain/mod-library'
import { CRYSTAL_EDIT_CATALOG_SCHEMA, MOD_CATALOG_SCHEMA } from '../domain/mod-layers'
import type { CatalogSnapshot, LocalData } from '../domain/types'
import { definitionOptionsForRevisions, type DefinitionOption } from './definitions'
import { isModSearchPreview } from '../domain/mod-search'
import { buildModLibraryCards, modCatalogEntry } from './mod-library-data'

export function standingReferenceOptions(options: readonly DefinitionOption[], catalogs: readonly CatalogSnapshot[], data: LocalData): readonly DefinitionOption[] {
  const setup = data.planningGameSetupRevisionId ? data.gameSetups[data.planningGameSetupRevisionId] : undefined
  const baseline = setup?.modComposition?.baseline
  const pins = { ...setup?.catalogLock, ...(baseline ? { [baseline.catalogId]: baseline.catalogRevisionId } : {}) }
  const originalPins = Object.fromEntries(catalogs.filter(catalog => catalog.schemaVersion !== MOD_CATALOG_SCHEMA && catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA && pins[catalog.id]).map(catalog => [catalog.id, pins[catalog.id]!]))
  const schemas = new Map(catalogs.map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog.schemaVersion]))
  const previews = new Set(catalogs.filter(isModSearchPreview).map(catalog => JSON.stringify([catalog.id, catalog.revisionId])))
  const latestMods = new Map(modLibrary(catalogs).map(mod => [mod.id, mod.revisions[0]!.catalogRevisionId]))
  const excludedIds = new Set(data.referenceLibrary?.excludedMods ?? [])
  const excludedCards = excludedIds.size ? buildModLibraryCards(catalogs, options, data).filter(card => excludedIds.has(card.id)) : []
  return definitionOptionsForRevisions(options, originalPins).filter(option => {
    if (excludedCards.length) {
      const entry = modCatalogEntry(option, catalogs, data)
      if (excludedCards.some(card => modCardIncludesEntry(card, entry))) return false
    }
    if (option.ref.kind !== 'catalog') return true
    const key = JSON.stringify([option.ref.catalogId, option.ref.catalogRevisionId])
    if (!schemas.has(key) || previews.has(key)) return false
    if (schemas.get(key) === MOD_CATALOG_SCHEMA) return false
    return schemas.get(key) !== CRYSTAL_EDIT_CATALOG_SCHEMA || latestMods.get(option.ref.catalogId) === option.ref.catalogRevisionId
  })
}

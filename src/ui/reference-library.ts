import { modCardIncludesEntry, modLibrary } from '../domain/mod-library'
import { CRYSTAL_EDIT_CATALOG_SCHEMA, MOD_CATALOG_SCHEMA } from '../domain/mod-layers'
import type { CatalogSnapshot, LocalData } from '../domain/types'
import type { DefinitionOption } from './definitions'
import { buildModLibraryCards, modCatalogEntry } from './mod-library-data'

export function standingReferenceOptions(options: readonly DefinitionOption[], catalogs: readonly CatalogSnapshot[], data: LocalData): readonly DefinitionOption[] {
  const schemas = new Map(catalogs.map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog.schemaVersion]))
  const latestMods = new Map(modLibrary(catalogs).map(mod => [mod.id, mod.revisions[0]!.catalogRevisionId]))
  const excludedIds = new Set(data.referenceLibrary?.excludedMods ?? [])
  const excludedCards = excludedIds.size ? buildModLibraryCards(catalogs, options, data).filter(card => excludedIds.has(card.id)) : []
  return options.filter(option => {
    if (excludedCards.length) {
      const entry = modCatalogEntry(option, catalogs, data)
      if (excludedCards.some(card => modCardIncludesEntry(card, entry))) return false
    }
    if (option.ref.kind !== 'catalog') return true
    const key = JSON.stringify([option.ref.catalogId, option.ref.catalogRevisionId])
    if (schemas.get(key) === MOD_CATALOG_SCHEMA) return false
    return schemas.get(key) !== CRYSTAL_EDIT_CATALOG_SCHEMA || latestMods.get(option.ref.catalogId) === option.ref.catalogRevisionId
  })
}

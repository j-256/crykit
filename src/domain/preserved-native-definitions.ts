import receipts from '../catalog/preserved-native-definitions.json' with { type: 'json' }
import { catalogEntity } from './entity-identities'
import { modCatalogRevision, modCatalogForPin, modModelEntity, nativeModModelKey } from './mod-layers'
import { withdrawnCatalog } from './withdrawn-catalogs'
import type { CatalogEntity, CatalogRef, CatalogSnapshot, LocalData } from './types'

const preservedIds = new Set(receipts.entityIds)

export function preservedNativeDefinition(localData: LocalData, catalogs: readonly CatalogSnapshot[], ref: CatalogRef): CatalogEntity | undefined {
  const origin = Object.values(localData.gameSetups).find(setup => setup.modComposition?.baseline.catalogId === ref.catalogId && modCatalogRevision(setup.id) === ref.catalogRevisionId && setup.catalogLock[ref.catalogId] === ref.catalogRevisionId)
  const baseline = origin?.modComposition?.baseline ?? ref
  if (baseline.catalogId !== receipts.source.id || baseline.catalogRevisionId !== receipts.source.revisionId || !preservedIds.has(ref.entityId)) return undefined
  if (withdrawnCatalog(baseline)?.checksum !== receipts.source.checksum) return undefined
  const available = catalogs.find(catalog => catalog.id === receipts.equivalent.id && catalog.revisionId === receipts.equivalent.revisionId && catalog.checksum === receipts.equivalent.checksum)
  const entity = available && catalogEntity(available, ref.entityId)
  if (!entity) return undefined

  // These complete native records were compared before withdrawal, including their provenance
  // The receipt binds both revisions; equal names or IDs in another snapshot are insufficient
  const composition = origin?.modComposition
  const modelKey = nativeModModelKey(entity)
  if (composition?.links.some(link => {
    if (link.targetEntityId === null || link.targetEntityId !== entity.id && link.modelKey !== modelKey) return false
    // A replacement can target another reference alias of this native model
    // Missing enabled sources cannot prove a saved replacement is inactive
    return composition.layers.some(layer => {
      if (!layer.enabled || link.projectId && link.projectId !== layer.catalogId) return false
      const source = modCatalogForPin(catalogs, layer)
      return !source || Boolean(modModelEntity(source, link.modelKey))
    })
  })) return undefined
  return entity
}

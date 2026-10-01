import type { CatalogSnapshot } from '../domain/types'
import { addCrystalEditFacts } from './crystal-edit'
import { addEquipmentExpansionFacts } from './equipment-expansion'
import { addLearnableInnateFacts } from './learnable-innates'
import { addModdingGuideFacts } from './modding-guide'
import { addTravelUnlockDefinitions } from './travel-unlocks'

export function assembleBundledCatalog(base: CatalogSnapshot): CatalogSnapshot {
  return addTravelUnlockDefinitions(addLearnableInnateFacts(addEquipmentExpansionFacts(addModdingGuideFacts(addCrystalEditFacts(base)))))
}

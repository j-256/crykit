import { createReferenceSupplementCatalog } from './starter'
import { addCrystalEditFacts } from './crystal-edit'
import { addModdingGuideFacts } from './modding-guide'
import { addTravelUnlockDefinitions } from './travel-unlocks'
import { BUNDLED_MOD_LIBRARY } from './mod-library-metadata'
import type { CatalogSnapshot } from '../domain/types'

const SOURCE_MOD_NAMES = new Set(BUNDLED_MOD_LIBRARY.flatMap(mod => mod.catalogNames ?? [mod.title]).map(name => name.trim().toLowerCase()))
const SOURCE_MOD_SCOPES = new Set(BUNDLED_MOD_LIBRARY.map(mod => mod.key))

export function referenceSupplements(): CatalogSnapshot {
  const authored = addTravelUnlockDefinitions(addModdingGuideFacts(addCrystalEditFacts(createReferenceSupplementCatalog())))
  // Source-backed mods belong to their exact library revisions, not the base catalog's supplemental facts
  const entities = Object.fromEntries(Object.entries(authored.entities).filter(([id, entity]) => {
    const mod = entity.fields['Source mod']
    const [scope, project] = id.split(':')
    return !(scope === 'mod' && project && SOURCE_MOD_SCOPES.has(project)) && !(mod?.state === 'known' && typeof mod.value === 'string' && SOURCE_MOD_NAMES.has(mod.value.trim().toLowerCase()))
  }))
  return { ...authored, entities, claims: authored.claims.filter(claim => entities[claim.entityId]) }
}

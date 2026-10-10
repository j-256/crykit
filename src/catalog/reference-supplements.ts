import { createReferenceSupplementCatalog } from './starter'
import { addCrystalEditFacts } from './crystal-edit'
import { addModdingGuideFacts } from './modding-guide'
import { addTravelUnlockDefinitions } from './travel-unlocks'
import defaults from './mod-defaults.json' with { type: 'json' }
import type { CatalogSnapshot } from '../domain/types'

const SOURCE_MOD_NAMES = new Set([...defaults.projects.flatMap(project => project.names), 'Tempest', 'Forcemage', 'Barbarian', 'Doge Shield'].map(name => name.trim().toLowerCase()))
const SOURCE_MOD_SCOPES = new Set([...defaults.projects.map(project => project.key), 'tempest', 'forcemage', 'barbarian', 'doge-shield'])

export function referenceSupplements(): CatalogSnapshot {
  const authored = addTravelUnlockDefinitions(addModdingGuideFacts(addCrystalEditFacts(createReferenceSupplementCatalog())))
  // Keep the base snapshot independent of which exact source versions the library provides
  // Source-backed mods belong to their exact library revisions, not the base catalog's supplemental facts
  const entities = Object.fromEntries(Object.entries(authored.entities).filter(([id, entity]) => {
    const mod = entity.fields['Source mod']
    const [scope, project] = id.split(':')
    return !(scope === 'mod' && project && SOURCE_MOD_SCOPES.has(project)) && !(mod?.state === 'known' && typeof mod.value === 'string' && SOURCE_MOD_NAMES.has(mod.value.trim().toLowerCase()))
  }))
  return { ...authored, entities, claims: authored.claims.filter(claim => entities[claim.entityId]) }
}

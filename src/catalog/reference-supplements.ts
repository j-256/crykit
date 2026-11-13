import { createReferenceSupplementCatalog } from './starter'
import { addCrystalEditFacts } from './crystal-edit'
import { addModdingGuideFacts } from './modding-guide'
import { addTravelUnlockDefinitions } from './travel-unlocks'
import type { CatalogEntity, CatalogSnapshot } from '../domain/types'

export type AuthoredSourceClass = 'vanilla' | 'guide' | 'excluded-mod' | 'excluded-coverage'

export function authoredReferenceSources(): CatalogSnapshot {
  return addTravelUnlockDefinitions(addModdingGuideFacts(addCrystalEditFacts(createReferenceSupplementCatalog())))
}

export function classifyAuthoredSource(entity: CatalogEntity): AuthoredSourceClass {
  // Authored namespaces carry source ownership; display names cannot decide provenance
  if (entity.id.startsWith('mod:')) return 'excluded-mod'
  if (entity.id === 'base:other:catalog-coverage-gaps') return 'excluded-coverage'
  if (entity.id.startsWith('base:mechanic:')) return 'guide'
  if (entity.id.startsWith('base:')) {
    const mod = entity.fields['Source mod']
    if (mod?.state === 'known' && mod.value !== 'Base Game') throw new Error(`Unclassified mod ownership in vanilla namespace: ${entity.id}`)
    return 'vanilla'
  }
  throw new Error(`Unclassified authored source: ${entity.id}`)
}

export function referenceSupplements(classification: 'vanilla' | 'guide' = 'vanilla'): CatalogSnapshot {
  const authored = authoredReferenceSources()
  const entities = Object.fromEntries(Object.entries(authored.entities).filter(([, entity]) => classifyAuthoredSource(entity) === classification))
  return { ...authored, entities, claims: authored.claims.filter(claim => entities[claim.entityId]) }
}

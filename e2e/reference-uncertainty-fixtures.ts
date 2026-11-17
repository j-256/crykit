import { checkpointContentDigest } from '../src/domain/checkpoint-identity'
import type { CatalogEntity, CatalogSnapshot, EntityId, SourceRef } from '../src/domain/types'
import { syntheticCatalog } from '../src/workspace/test-helpers'

export const RETAINED_STUDY_SOURCES: readonly SourceRef[] = Array.from({ length: 8 }, (_, index) => ({
  sourceId: `https://study-${index + 1}.example.test/retained-observation`,
  snapshot: `synthetic revision ${index + 1}`,
  locator: `Synthetic observation ${index + 1}: the source discusses missing HP without establishing a native formula. This independently authored note retains its own uncertainty and attribution.`,
}))
export const RETAINED_DESCRIPTION = 'Synthetic independently attributed description for wrapping and source inspection. This text does not establish native game mechanics.'
const entity = (id: string, name: string, kind: CatalogEntity['kind'], fields: CatalogEntity['fields'], rawDescription?: string): CatalogEntity => ({ id: id as EntityId, name, kind, fields, rawDescription, aliases: [], sources: RETAINED_STUDY_SOURCES })
export const REFERENCE_UNCERTAINTY_ENTITIES = {
  study: entity('synthetic:retained-study', 'Synthetic retained study', 'item', { Duration: { state: 'unknown', reason: 'The synthetic source did not record a duration', sources: [RETAINED_STUDY_SOURCES[0]!] } }),
  description: entity('synthetic:wrapping-description', 'Synthetic wrapping description', 'item', { Description: { state: 'known', value: RETAINED_DESCRIPTION, sources: [RETAINED_STUDY_SOURCES[0]!] } }, RETAINED_DESCRIPTION),
  unknownSkill: entity('synthetic:unknown-weapon-skill', 'Synthetic undocumented weapon skill', 'ability', { Type: { state: 'unknown', reason: 'The synthetic source omitted weapon requirements', sources: [RETAINED_STUDY_SOURCES[0]!] } }),
  conflictingSkill: entity('synthetic:conflicting-weapon-skill', 'Synthetic disputed weapon skill', 'ability', { Type: { state: 'conflicting', claims: [
    { value: 'Single Target Dagger Skill', sources: [RETAINED_STUDY_SOURCES[0]!] },
    { value: 'Single Target Bow Skill', sources: [RETAINED_STUDY_SOURCES[1]!] },
  ] } }),
} as const

// Complete independent source bodies preserve uncertainty without borrowing a packaged catalog's identity
const original = syntheticCatalog('browser-source-uncertainty', undefined, Object.fromEntries(Object.values(REFERENCE_UNCERTAINTY_ENTITIES).map(record => [record.id, record])))
const { checksum: ignoredChecksum, ...base } = original
void ignoredChecksum
const content = { ...base, claims: Object.values(REFERENCE_UNCERTAINTY_ENTITIES).flatMap(record => Object.entries(record.fields).flatMap(([field, value]) => value.state === 'conflicting' ? value.claims.map(claim => ({ entityId: record.id, field, value: { state: 'known' as const, value: claim.value, sources: claim.sources }, sources: claim.sources })) : [])) }
export const REFERENCE_UNCERTAINTY_CATALOG: CatalogSnapshot = { ...content, checksum: `payload:sha256:${checkpointContentDigest(content)}` }

import { expect, type Page } from '@playwright/test'
import { CURRENT_CATALOG } from '../src/catalog/bundled'
import { CLASS_FIELDS } from '../src/domain/crystal-edit'
import { checkpointContentDigest } from '../src/domain/checkpoint-identity'
import { sourcePayloadValid } from '../src/domain/source-fulfillment'
import type { CatalogEntity, CatalogSnapshot, EntityId, SourceRef } from '../src/domain/types'
import { syntheticCatalog } from '../src/workspace/test-helpers'
import { readLocalData, replacePlannerFixture, waitForPlannerReady } from './local-data-helpers'
import { referencePath } from './reference-helpers'

export const REFERENCE_EVIDENCE_SOURCES: readonly SourceRef[] = [
  { sourceId: 'https://source-a.example.test/synthetic-table', locator: 'Synthetic original table', snapshot: 'revision 12' },
  { sourceId: 'https://source-b.example.test/synthetic-item', locator: 'Synthetic original item', snapshot: 'revision 24' },
]
export const CONFLICTING_LOCATIONS = ['Reward: synthetic master in the northern village', 'The synthetic master is found in the southern city'] as const
export const ORIGINAL_EFFECTS = ['Synthetic single target: recover missing HP.', 'Synthetic single target: recover maximum HP.'] as const
export const IMPORTED_DESCRIPTION = 'Synthetic strategy notes from an independently imported source. These do not establish native mechanics.'
const entity = (id: string, name: string, fields: CatalogEntity['fields'], kind: CatalogEntity['kind'] = 'item', rawDescription?: string): CatalogEntity => ({ id: id as EntityId, name, kind, aliases: [], fields, rawDescription, sources: REFERENCE_EVIDENCE_SOURCES })
const claims = (values: readonly string[]) => ({ state: 'conflicting' as const, claims: values.map((value, index) => ({ value, sources: [REFERENCE_EVIDENCE_SOURCES[index]!] })) })
export const REFERENCE_EVIDENCE_ENTITIES = {
  recipe: entity('synthetic:recipe', 'Fursuit', { Recipe: { state: 'known', value: 'Synthetic recipe from an independent source', sources: [REFERENCE_EVIDENCE_SOURCES[0]!] } }, 'recipe'),
  conflicting: entity('synthetic:conflicting-item', 'Synthetic disputed seal', { Location: claims(CONFLICTING_LOCATIONS) }),
  equivalent: entity('synthetic:equivalent-item', 'Synthetic agreed blade', { Location: { state: 'known', value: 'Drop: synthetic guardian in the northern ruins', sources: REFERENCE_EVIDENCE_SOURCES } }),
  effects: entity('synthetic:effect-item', 'Synthetic original effects', { Effect: claims(ORIGINAL_EFFECTS) }),
  description: entity('synthetic:description-item', 'Synthetic attributed item', { Description: { state: 'known', value: IMPORTED_DESCRIPTION, sources: [REFERENCE_EVIDENCE_SOURCES[0]!] } }, 'item', IMPORTED_DESCRIPTION),
  wide: entity('synthetic:wide-class', 'Synthetic table class', {
    'Table: Battle Skill': { state: 'known', value: [{ Ability: 'Synthetic strike', Cost: '4 AP', Effect: 'Synthetic observed effect' }], sources: [{ ...REFERENCE_EVIDENCE_SOURCES[0]!, locator: 'Synthetic class > Battle Skill' }] },
    'Table: Passives 2': { state: 'known', value: [{ Passive: 'Synthetic guard', PP: 2, Effect: 'Synthetic passive effect' }], sources: [{ ...REFERENCE_EVIDENCE_SOURCES[1]!, locator: 'Synthetic class > Passives' }] },
    [CLASS_FIELDS.ratings]: { state: 'known', value: { HP: 80, MP: 20, STR: 80, VIT: 80, DEX: 30, AGI: 50, MND: 10, SPI: 30, SPD: 50, LUK: 50 }, sources: [REFERENCE_EVIDENCE_SOURCES[0]!] },
  }, 'class'),
} as const
const initial = syntheticCatalog('browser-reference-evidence', undefined, Object.fromEntries(Object.values(REFERENCE_EVIDENCE_ENTITIES).map(record => [record.id, record])))
const { checksum: ignoredChecksum, ...base } = initial
void ignoredChecksum
const content = { ...base, claims: Object.values(REFERENCE_EVIDENCE_ENTITIES).flatMap(record => Object.entries(record.fields).flatMap(([field, value]) => value.state === 'conflicting' ? value.claims.map(claim => ({ entityId: record.id, field, value: { state: 'known' as const, value: claim.value, sources: claim.sources }, sources: claim.sources })) : [])) }
export const REFERENCE_EVIDENCE_CATALOG: CatalogSnapshot = { ...content, checksum: `payload:sha256:${checkpointContentDigest(content)}` }
export function evidenceReferencePath(record: CatalogEntity): string {
  return referencePath(record.id, REFERENCE_EVIDENCE_CATALOG.id, REFERENCE_EVIDENCE_CATALOG.revisionId)
}

export async function installReferenceEvidence(page: Page) {
  // Independent complete bodies exercise imported evidence; they never borrow packaged native identity or trust
  expect(REFERENCE_EVIDENCE_CATALOG.id).not.toBe(CURRENT_CATALOG.id)
  expect(sourcePayloadValid(REFERENCE_EVIDENCE_CATALOG)).toBe(true)
  expect(REFERENCE_EVIDENCE_ENTITIES.conflicting.fields.Location).toMatchObject({ state: 'conflicting', claims: [{ value: CONFLICTING_LOCATIONS[0] }, { value: CONFLICTING_LOCATIONS[1] }] })
  expect(CONFLICTING_LOCATIONS[0]).not.toBe(CONFLICTING_LOCATIONS[1])
  expect(new Set(REFERENCE_EVIDENCE_SOURCES.map(source => source.sourceId)).size).toBe(2)
  expect(REFERENCE_EVIDENCE_ENTITIES.wide.fields['Table: Battle Skill']).toMatchObject({ state: 'known', value: [{ Ability: 'Synthetic strike' }] })
  expect(REFERENCE_EVIDENCE_ENTITIES.wide.fields[CLASS_FIELDS.ratings]).toMatchObject({ state: 'known', value: { HP: 80, LUK: 50 } })
  await page.goto('/#/reference')
  await waitForPlannerReady(page)
  await replacePlannerFixture(page, await readLocalData(page), [REFERENCE_EVIDENCE_CATALOG])
}

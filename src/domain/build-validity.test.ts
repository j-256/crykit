import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { validateBuildContent } from './build-validity'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import type { BuildRevisionContent, CatalogEntity, CatalogRef, EntityId, EntityRef, JsonValue, RulesetRevision } from './types'

const known = <Value extends JsonValue>(value: Value) => ({ state: 'known' as const, value })
const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const passive = (id: string, cost?: number): CatalogEntity => ({
  id: id as EntityId,
  kind: 'passive',
  name: id,
  aliases: [],
  fields: { Description: known('Synthetic passive effect') },
  slotKinds: known(SUGGESTED_BUILD_SLOTS.filter(slot => slot.kind === 'passive').map(slot => slot.id as string)),
  occupiesSlots: known(1),
  ...(cost === undefined ? { ppCost: { state: 'unknown' as const } } : { ppCost: known(cost) }),
  requirements: known([]),
  grants: known([]),
  sources: [],
})
const definitions = [passive('four', 4), passive('six', 6), passive('seven', 7), passive('unknown')]
const resolve = (reference: EntityRef) => reference.kind === 'catalog' ? definitions.find(definition => definition.id === reference.entityId) : undefined
const ruleset: Pick<RulesetRevision, 'catalogLock' | 'ppCostsNonNegative' | 'ppLimit'> = { catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId }, ppLimit: known(10), ppCostsNonNegative: known(true) }
const content = (...ids: string[]): BuildRevisionContent => ({ primaryClass: null, secondaryClass: null, selections: Object.fromEntries(ids.map((id, index) => [`plan-passive-${index + 1}`, { ref: ref(id) }])), contextAssumptions: [] })

describe('character-independent build validity', () => {
  it('accepts a known PP total at the ruleset limit without character state', () => {
    const report = validateBuildContent(content('four', 'six'), ruleset, SUGGESTED_BUILD_SLOTS, resolve)
    expect(report.pp).toMatchObject({ knownSubtotal: 10, unresolvedCosts: 0, status: 'valid' })
    expect(report.status).toBe('valid')
  })

  it('rejects a known PP total above the ruleset limit', () => {
    const report = validateBuildContent(content('four', 'seven'), ruleset, SUGGESTED_BUILD_SLOTS, resolve)
    expect(report.status).toBe('invalid')
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'PP_LIMIT_EXCEEDED', status: 'invalid' }))
  })

  it('keeps unresolved costs and limits explicit', () => {
    const unknownCost = validateBuildContent(content('four', 'unknown'), ruleset, SUGGESTED_BUILD_SLOTS, resolve)
    expect(unknownCost.status).toBe('undetermined')
    expect(unknownCost.issues).toContainEqual(expect.objectContaining({ code: 'PP_COST_UNKNOWN' }))
    const unknownLimit = validateBuildContent(content('four'), { ...ruleset, ppLimit: { state: 'unknown' } }, SUGGESTED_BUILD_SLOTS, resolve)
    expect(unknownLimit.status).toBe('undetermined')
    expect(unknownLimit.issues).toContainEqual(expect.objectContaining({ code: 'PP_LIMIT_UNKNOWN' }))
  })
})

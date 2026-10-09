import { describe, expect, it } from 'vitest'
import { TEST_CATALOG_ID, TEST_CATALOG_REVISION_ID, testCatalogRef as ref } from './catalog.test-helpers'
import { validateBuildContent } from './build-validity'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import type { BuildRevisionContent, CatalogEntity, EntityId, EntityRef, JsonValue, GameSetupRevision } from './types'

const known = <Value extends JsonValue>(value: Value) => ({ state: 'known' as const, value })
const passive = (id: string, cost?: number): CatalogEntity => ({
  id: id as EntityId,
  kind: 'passive',
  name: id,
  aliases: [],
  fields: { Description: known('Synthetic passive effect') },
  ...(cost === undefined ? { ppCost: { state: 'unknown' as const } } : { ppCost: known(cost) }),
  requirements: known([]),
  grants: known([]),
  sources: [],
})
const unavailable = { ...passive('unavailable'), kind: 'innate' as const, ppCost: { state: 'notApplicable' as const, reason: 'Not made learnable by this Game Setup' } }
const definitions = [passive('four', 4), passive('six', 6), passive('seven', 7), passive('unknown'), unavailable]
const resolve = (reference: EntityRef) => reference.kind === 'catalog' ? definitions.find(definition => definition.id === reference.entityId) : undefined
const gameSetup: Pick<GameSetupRevision, 'catalogLock' | 'ppCostsNonNegative' | 'ppLimit'> = { catalogLock: { [TEST_CATALOG_ID]: TEST_CATALOG_REVISION_ID }, ppLimit: known(10), ppCostsNonNegative: known(true) }
const content = (...ids: string[]): BuildRevisionContent => ({ primaryClass: null, secondaryClass: null, equipment: {}, passives: ids.map(id => ({ ref: ref(id) })), contextAssumptions: [] })

describe('character-independent build validity', () => {
  it('accepts a known PP total at the gameSetup limit without character state', () => {
    const report = validateBuildContent(content('four', 'six'), gameSetup, SUGGESTED_BUILD_SLOTS, resolve)
    expect(report.pp).toMatchObject({ knownSubtotal: 10, unresolvedCosts: 0, status: 'valid' })
    expect(report.status).toBe('valid')
  })

  it('rejects a known PP total above the gameSetup limit', () => {
    const report = validateBuildContent(content('four', 'seven'), gameSetup, SUGGESTED_BUILD_SLOTS, resolve)
    expect(report.status).toBe('invalid')
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'PP_LIMIT_EXCEEDED', status: 'invalid' }))
  })

  it('keeps unresolved costs and limits explicit', () => {
    const unknownCost = validateBuildContent(content('four', 'unknown'), gameSetup, SUGGESTED_BUILD_SLOTS, resolve)
    expect(unknownCost.status).toBe('undetermined')
    expect(unknownCost.issues).toContainEqual(expect.objectContaining({ code: 'PP_COST_UNKNOWN' }))
    const unknownLimit = validateBuildContent(content('four'), { ...gameSetup, ppLimit: { state: 'unknown' } }, SUGGESTED_BUILD_SLOTS, resolve)
    expect(unknownLimit.status).toBe('undetermined')
    expect(unknownLimit.issues).toContainEqual(expect.objectContaining({ code: 'PP_LIMIT_UNKNOWN' }))
  })

  it('reports unavailable selections once per position while preserving PP uncertainty', () => {
    const selected = { ...content('missing-one', 'missing-two', 'missing-three'), equipment: { 'plan-main-hand': { ref: ref('missing-weapon') } } }
    const report = validateBuildContent(selected, gameSetup, SUGGESTED_BUILD_SLOTS, resolve)
    expect(report.status).toBe('undetermined')
    expect(report.pp).toMatchObject({ knownSubtotal: 0, unresolvedCosts: 3, status: 'undetermined' })
    for (const slotId of ['equipped-passive-1', 'equipped-passive-2', 'equipped-passive-3', 'plan-main-hand']) {
      const findings = report.issues.filter(issue => issue.slotId === slotId)
      expect(findings).toHaveLength(1)
      expect(findings[0]).toMatchObject({ status: 'undetermined', message: expect.stringContaining('definition is unavailable') })
    }
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'PP_COST_UNKNOWN' }))
  })

  it('retains distinct catalog and duplicate-selection failures for unavailable passives', () => {
    const report = validateBuildContent(content('missing', 'missing'), { ...gameSetup, catalogLock: {} }, SUGGESTED_BUILD_SLOTS, resolve)
    expect(report.status).toBe('invalid')
    expect(report.issues.filter(issue => issue.slotId === 'equipped-passive-2').map(issue => issue.code)).toEqual(['CATALOG_REFERENCE_MISMATCH', 'DUPLICATE_PASSIVE', 'PASSIVE_DEFINITION'])
    expect(report.pp).toMatchObject({ unresolvedCosts: 2, status: 'undetermined' })
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'PP_COST_UNKNOWN' }))
  })

  it('identifies an unavailable saved mod class without substituting a base-game namesake', () => {
    const selected = ref('missing-class')
    const revision = { ...content(), secondaryClass: selected, referenceNames: [{ ref: selected, name: 'Rogue', projectId: TEST_CATALOG_ID, modelKey: 'crystal-edit:Jobs:2' }] }
    const setup = { ...gameSetup, modSourceReceipts: [{ catalogId: TEST_CATALOG_ID, catalogRevisionId: TEST_CATALOG_REVISION_ID, checksum: 'synthetic', title: 'Synthetic Innates Mod' }] }
    const baseClass = { ...passive('base-rogue'), kind: 'class' as const, name: 'Rogue' }
    const report = validateBuildContent(revision, setup, SUGGESTED_BUILD_SLOTS, reference => reference.kind === 'catalog' && reference.entityId === baseClass.id ? baseClass : resolve(reference))
    expect(report.status).toBe('undetermined')
    expect(report.issues).toEqual([{ code: 'CLASS_DEFINITION_UNAVAILABLE', status: 'undetermined', message: "Sub-command: Rogue's saved Synthetic Innates Mod definition is unavailable" }])
  })

  it('rejects an innate that is explicitly unavailable as an equippable passive', () => {
    const report = validateBuildContent(content('unavailable'), gameSetup, SUGGESTED_BUILD_SLOTS, resolve)
    expect(report.status).toBe('invalid')
    expect(report.pp).toMatchObject({ knownSubtotal: 0, unresolvedCosts: 0 })
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'PASSIVE_NOT_EQUIPPABLE', status: 'invalid' }))
  })
})

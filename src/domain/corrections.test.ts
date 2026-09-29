import { describe, expect, it } from 'vitest'
import { activeCorrections, correctedEntity, correctionExportClosure, correctionStatus, hiddenCorrectionKeys, mergeCorrections, projectCorrectedCatalogs } from './corrections'
import { CORRECTION_TEST_CATALOG as catalog, CORRECTION_TEST_ENTITY as entity, testCorrection } from './corrections.test-helpers'
import { equipmentFacts } from './mechanics-facts'

describe('correction registry', () => {
  it('preserves original source claims and applies compatible refinements without implying platform certainty', () => {
    const original = structuredClone(catalog)
    const correction = testCorrection()
    const projected = projectCorrectedCatalogs([catalog], [correction])[0]!
    expect(projected.entities[entity.id]?.fields.Location).toMatchObject({ state: 'known', value: 'Synthetic weapon shop, test city', sources: [{ sourceId: 'correction:synthetic-decision-1', applicability: expect.stringContaining('platform unknown') }] })
    expect(catalog).toEqual(original)
    expect(projected.applicability).toEqual({ state: 'unknown' })
    expect(correction.changes[0]).toHaveProperty('before.claims.1.sources.0.snapshot', 'revision 2')
  })
  it('holds changed source values, checksums and source revisions for review', () => {
    const correction = testCorrection()
    expect(correctionStatus(correction, [{ ...catalog, checksum: 'new-checksum' }])).toBe('review')
    for (const revised of [
      { ...entity, fields: { ...entity.fields, Location: { state: 'unknown' as const } } },
      { ...entity, sources: [{ ...entity.sources[0]!, snapshot: 'revision 3' }] },
      { ...entity, fields: { ...entity.fields, Location: { state: 'conflicting' as const, claims: [{ value: 'Synthetic shops', sources: [{ sourceId: 'https://example.com/item?oldid=3' }] }, { value: 'Synthetic weapon shop', sources: [] }] } } },
    ]) {
      const next = { ...catalog, entities: { [entity.id]: revised } }
      expect(correctionStatus(correction, [next])).toBe('review')
      expect(projectCorrectedCatalogs([next], [correction])).toEqual([next])
    }
    expect(correctionStatus(correction, [])).toBe('unavailable')
  })
  it('retains auxiliary source claims in the delta and refuses changed evidence', () => {
    const claim = { entityId: entity.id, field: 'Location', value: { state: 'known' as const, value: 'Synthetic auxiliary location' }, sources: entity.sources }
    const withClaims = { ...catalog, claims: [claim] }
    const correction = testCorrection({ baselineClaims: [claim] })
    expect(correctionStatus(correction, [withClaims])).toBe('applied')
    expect(projectCorrectedCatalogs([withClaims], [correction])[0]?.claims).toEqual([])
    expect(correction.baselineClaims).toEqual(withClaims.claims)
    expect(correctionStatus(correction, [{ ...withClaims, claims: [{ ...claim, sources: [{ ...entity.sources[0]!, snapshot: 'revision 4' }] }] }])).toBe('review')
  })
  it('never selects an array-order winner between competing decisions', () => {
    const first = testCorrection()
    const second = testCorrection({ id: 'synthetic-decision-2', decision: 'contradiction', changes: [{ path: 'name', before: entity.name, after: 'Alternative' }] })
    for (const entries of [[first, second], [second, first]]) {
      expect(correctionStatus(first, [catalog], entries)).toBe('competing')
      expect(correctionStatus(second, [catalog], entries)).toBe('competing')
      expect(projectCorrectedCatalogs([catalog], entries)).toEqual([catalog])
    }
    const chosen = { ...first, id: 'synthetic-decision-3', supersedes: [first.id, second.id] }
    const entries = [second, chosen, first]
    expect(activeCorrections(entries)).toEqual([chosen])
    expect(correctionStatus(chosen, [catalog], entries)).toBe('applied')
    expect(correctionStatus(first, [catalog], entries)).toBe('superseded')
    expect(correctionExportClosure(entries, new Set([chosen.id]))).toHaveLength(3)
  })
  it('synchronizes numeric planning facts and removes stale known values when facts become unknown', () => {
    const corrected = correctedEntity(entity, testCorrection({ changes: [
      { path: 'field', field: 'Attack', before: entity.fields.Attack!, after: { state: 'known', value: 140 } },
      { path: 'field', field: 'Hands', before: entity.fields.Hands!, after: { state: 'known', value: 2 } },
      { path: 'field', field: 'PP cost', before: entity.fields['PP cost']!, after: { state: 'known', value: 0 } },
    ] }))
    expect(corrected.listedContributions?.Attack).toMatchObject({ state: 'known', value: { value: 140, unit: 'listed flat value' } })
    expect(corrected.fields.Hands).toMatchObject({ state: 'known', value: 2 })
    expect(equipmentFacts(corrected).twoHanded).toBe(true)
    expect(corrected.ppCost).toMatchObject({ state: 'known', value: 0 })
    const uncertain = correctedEntity(entity, testCorrection({ changes: [
      { path: 'field', field: 'Attack', before: entity.fields.Attack!, after: { state: 'unknown' } },
      { path: 'field', field: 'PP cost', before: entity.fields['PP cost']!, after: null },
    ] }))
    expect(uncertain.ppCost?.state).toBe('unknown')
    expect(uncertain.listedContributions?.Attack?.state).toBe('unknown')
  })
  it('hides without deleting identities and restores through an explicit new decision', () => {
    const hidden = testCorrection({ changes: [{ path: 'visibility', before: false, after: true }] })
    expect(hiddenCorrectionKeys([catalog], [hidden]).size).toBe(1)
    expect(projectCorrectedCatalogs([catalog], [hidden])[0]?.entities[entity.id]).toBeDefined()
    const restored = { ...hidden, id: 'restore', supersedes: [hidden.id], changes: [] }
    expect(hiddenCorrectionKeys([catalog], [hidden, restored]).size).toBe(0)
    expect(correctionStatus(restored, [catalog], [hidden, restored])).toBe('restored')
  })
  it('deduplicates identical imports but refuses to replace a stable decision ID', () => {
    const correction = testCorrection()
    expect(mergeCorrections([correction], [correction])).toEqual([correction])
    expect(() => mergeCorrections([correction], [{ ...correction, reason: 'tampered' }])).toThrow('ID has different content')
  })
})

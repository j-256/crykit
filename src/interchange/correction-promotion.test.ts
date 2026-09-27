import { describe, expect, it } from 'vitest'
import { CORRECTION_TEST_CATALOG as catalog, CORRECTION_TEST_ENTITY as entity, CORRECTION_TEST_REF as ref, CORRECTION_TEST_TIME, testCorrection } from '../domain/corrections.test-helpers'
import { correctionKey, hiddenCorrectionKeys, historicalCatalogKeys, MAX_CORRECTIONS } from '../domain/corrections'
import { createBlankProfile } from '../domain/profile'
import type { JsonValue } from '../domain/types'
import { resolveDefinition } from '../domain/definitions'
import { buildDefinitionOptions, definitionOptionsForRevisions } from '../ui/definitions'
import { projectReferenceEntity } from '../ui/search'
import { promoteCorrections, reviewedCatalogDecisions, validateReviewedCatalogBundle, verifyReviewedCatalogChecksums } from './correction-promotion'

function reviewedCorrection() {
  return testCorrection({ confidence: 'confirmed', reason: 'Synthetic observation refines the source', evidence: 'Synthetic source with reproducible steps', context: { platform: 'Synthetic platform', gameVersion: '1.2', mods: 'None' }, changes: [
    ...testCorrection().changes,
    { path: 'field', field: 'Attack', before: entity.fields.Attack!, after: { state: 'known', value: 140 } },
    { path: 'field', field: 'PP cost', before: entity.fields['PP cost']!, after: { state: 'known', value: 2 } },
  ] })
}

describe('reviewed baseline promotion', () => {
  it('creates a new checksummed revision with consistent planning fields and preserved historical references', async () => {
    const original = structuredClone(catalog)
    const correction = reviewedCorrection()
    const promoted = await promoteCorrections(catalog, [correction], 'v2', CORRECTION_TEST_TIME)
    expect(catalog).toEqual(original)
    expect(promoted.revisionId).toBe('v2')
    expect(promoted.checksum).toMatch(/^reviewed:sha256:[a-f0-9]{64}$/)
    expect(promoted.checksum).not.toBe(catalog.checksum)
    expect(promoted.applicability).toEqual(catalog.applicability)
    expect(promoted.entities[entity.id]?.listedContributions?.Attack).toMatchObject({ state: 'known', value: { value: 140 } })
    expect(promoted.entities[entity.id]?.ppCost).toMatchObject({ state: 'known', value: 2 })
    const profile = createBlankProfile()
    expect(resolveDefinition(profile, [catalog, promoted], ref)).toEqual(entity)
    const options = buildDefinitionOptions(profile, [catalog, promoted])
    expect(options.find(option => option.ref.kind === 'catalog' && option.ref.catalogRevisionId === 'v2')?.ppCost).toMatchObject({ value: 2 })
    expect(options.find(option => option.ref.kind === 'catalog' && option.ref.catalogRevisionId === 'v1')?.preferred).toBe(false)
    expect(definitionOptionsForRevisions(options, [catalog, promoted]).map(option => option.ref)).toEqual([{ ...ref, catalogRevisionId: promoted.revisionId }])
    const pinnedOptions = definitionOptionsForRevisions(options, [catalog, promoted], { [catalog.id]: catalog.revisionId })
    expect(pinnedOptions.map(option => option.ref)).toEqual([ref])
    expect(pinnedOptions[0]?.ppCost).toMatchObject({ state: 'known', value: 3 })
    expect(historicalCatalogKeys([catalog, promoted]).has(JSON.stringify([catalog.id, catalog.revisionId]))).toBe(true)
    expect(projectReferenceEntity(promoted, promoted.entities[entity.id]!).ppCost).toMatchObject({ value: 2 })
    const bundle = validateReviewedCatalogBundle({ format: 'crystal-companion-reviewed-catalogs', version: 1, current: { catalogId: catalog.id, revisionId: 'v2' }, catalogs: [catalog, promoted] })
    await expect(verifyReviewedCatalogChecksums(bundle)).resolves.toBeUndefined()
    const corrupt = { ...promoted, entities: { [entity.id]: { ...promoted.entities[entity.id]!, name: 'Tampered' } } }
    await expect(verifyReviewedCatalogChecksums({ ...bundle, catalogs: [catalog, corrupt] })).rejects.toThrow('checksum mismatch')
    expect((promoted.legacy as Record<string, unknown>).reviewedCorrections).toEqual([correction])
    expect(reviewedCatalogDecisions(promoted)).toEqual([correction])
    expect(reviewedCatalogDecisions(catalog)).toEqual([])
  })
  it('preserves hidden entries through later releases and permits a reviewed visibility reversal', async () => {
    const hidden = { ...reviewedCorrection(), changes: [{ path: 'visibility' as const, before: false, after: true }] }
    const v2 = await promoteCorrections(catalog, [hidden], 'v2', CORRECTION_TEST_TIME)
    const v2Ref = { ...ref, catalogRevisionId: v2.revisionId }
    const correction = { ...reviewedCorrection(), id: 'synthetic-release-3', target: v2Ref, baselineChecksum: v2.checksum, changes: [{ path: 'name' as const, before: entity.name, after: 'Synthetic revised name' }] }
    const v3 = await promoteCorrections(v2, [correction], 'v3', CORRECTION_TEST_TIME)
    expect(hiddenCorrectionKeys([v3], []).has(correctionKey({ target: { ...ref, catalogRevisionId: v3.revisionId } }))).toBe(true)
    expect(reviewedCatalogDecisions(v3)).toEqual(expect.arrayContaining([hidden, correction]))
    const visible = { ...reviewedCorrection(), id: 'synthetic-visible-3', target: v2Ref, baselineChecksum: v2.checksum, changes: [{ path: 'visibility' as const, before: true, after: false }] }
    expect(hiddenCorrectionKeys([v2], [visible]).size).toBe(0)
    const unhidden = await promoteCorrections(v2, [visible], 'visible-v3', CORRECTION_TEST_TIME)
    expect(hiddenCorrectionKeys([unhidden], []).size).toBe(0)
    expect(hiddenCorrectionKeys([v2], []).size).toBe(1)
  })
  it('requires review, fresh sources, explicit supersession and a new revision', async () => {
    await expect(promoteCorrections(catalog, [testCorrection()], 'v2', CORRECTION_TEST_TIME)).rejects.toThrow('Still tentative')
    await expect(promoteCorrections(catalog, [reviewedCorrection()], 'v1', CORRECTION_TEST_TIME)).rejects.toThrow('new catalog revision')
    await expect(promoteCorrections({ ...catalog, checksum: 'changed' }, [reviewedCorrection()], 'v2', CORRECTION_TEST_TIME)).rejects.toThrow('Needs review')
    const first = reviewedCorrection()
    await expect(promoteCorrections(catalog, [first, { ...first, id: 'second' }], 'v2', CORRECTION_TEST_TIME)).rejects.toThrow('Choose a correction')
  })
  it('refuses unreadable or oversized combined history instead of losing earlier decisions', async () => {
    const correction = reviewedCorrection()
    const malformed = { ...catalog, legacy: { reviewedCorrections: 'invalid history' } }
    await expect(promoteCorrections(malformed, [correction], 'v2', CORRECTION_TEST_TIME)).rejects.toThrow('format or values are invalid')
    expect(() => validateReviewedCatalogBundle({ format: 'crystal-companion-reviewed-catalogs', version: 1, current: { catalogId: catalog.id, revisionId: catalog.revisionId }, catalogs: [malformed] })).toThrow('format or values are invalid')
    const history = Array.from({ length: MAX_CORRECTIONS }, (_, index) => ({ ...testCorrection(), id: `previous-${index}`, changes: [{ path: 'name', before: entity.name, after: `Synthetic name ${index}` }] }))
    const full = { ...catalog, legacy: { reviewedCorrections: JSON.parse(JSON.stringify(history)) as JsonValue } }
    expect(reviewedCatalogDecisions(full)).toHaveLength(MAX_CORRECTIONS)
    await expect(promoteCorrections(full, [correction], 'v2', CORRECTION_TEST_TIME)).rejects.toThrow('format or values are invalid')
    expect(reviewedCatalogDecisions(full)).toHaveLength(MAX_CORRECTIONS)
  })
})

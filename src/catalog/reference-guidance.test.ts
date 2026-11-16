import { afterEach, describe, expect, it, vi } from 'vitest'
import * as descriptions from './native-description'
import guidance from './reference-guidance.json' with { type: 'json' }
import { CURRENT_CATALOG } from './bundled'
import { referenceGuidance } from './reference-guidance'
import { nativeDescription, referenceDescription } from './native-description'
import { nativeIdentity, NATIVE_RECORD_FIELD } from '../domain/native-game'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogEntity, PersonalDefinition } from '../domain/types'

const shard = CURRENT_CATALOG.entities['base:item:22']!

afterEach(() => vi.restoreAllMocks())

describe('supplemental reference guidance', () => {
  it('supplies missing explanations without changing native output or source snapshots', () => {
    const before = JSON.stringify(CURRENT_CATALOG)
    expect(nativeDescription(shard)?.complete).toBe(false)
    const explanation = referenceGuidance(CURRENT_CATALOG, shard, 'description')
    expect(explanation).toMatchObject([{ entityId: shard.id, text: expect.stringContaining('teleports the party to the roof of the Gaea Shrine'), sources: [{ sourceId: 'https://crystal-project.fandom.com/wiki/Gaea_Shard?oldid=7599' }] }])
    expect(referenceDescription(shard)).not.toContain('teleports the party')
    expect(referenceGuidance(CURRENT_CATALOG, CURRENT_CATALOG.entities['base:equipment:134']!, 'description')).toEqual([])
    expect(JSON.stringify(CURRENT_CATALOG)).toBe(before)
  })

  it('gives complete native descriptions precedence and does not repeat native-rendered text', () => {
    const text = referenceGuidance(CURRENT_CATALOG, shard, 'description')[0]!.text
    const renderer = vi.spyOn(descriptions, 'nativeDescription')
    renderer.mockReturnValue({ complete: true, lines: ['Native effect'], unresolved: [] })
    expect(referenceGuidance(CURRENT_CATALOG, shard, 'description')).toEqual([])
    renderer.mockReturnValue({ complete: false, lines: [text], unresolved: ['Synthetic unsupported modifier'] })
    expect(referenceGuidance(CURRENT_CATALOG, shard, 'description')).toEqual([])
  })

  it('retains only individually attributed text bound to an exact native mode and identity', () => {
    expect(guidance.rights).toMatchObject({ attribution: 'Crystal Project Wiki contributors', license: 'CC-BY-SA', licenseUrl: 'https://www.fandom.com/licensing' })
    expect(guidance.records.filter(record => record.kind === 'description').length).toBeLessThanOrEqual(250)
    const keys = new Set<string>()
    for (const record of guidance.records) {
      const entity = CURRENT_CATALOG.entities[record.entityId]!
      expect(entity, record.entityId).toBeDefined()
      expect(nativeIdentity(entity)).toEqual(record.nativeIdentity)
      expect(record.text.trim()).toBe(record.text)
      expect(record.text.length).toBeGreaterThan(0)
      expect(record.sources.length).toBeGreaterThan(0)
      for (const source of record.sources) {
        expect(source.sourceId).toMatch(/^https:\/\/crystal-project\.fandom\.com\/wiki\/.+\?oldid=\d+$/)
        expect(source.locator.length).toBeGreaterThan(0)
      }
      const key = JSON.stringify([record.entityId, record.kind, record.text])
      expect(keys.has(key)).toBe(false)
      keys.add(key)
    }
  })

  it('admits exact clones while rejecting revised, imported, personal, or changed bodies and provenance', () => {
    const expected = referenceGuidance(CURRENT_CATALOG, shard)
    expect(expected.length).toBeGreaterThan(0)
    const clone = structuredClone(shard)
    expect(referenceGuidance(structuredClone(CURRENT_CATALOG), clone)).toEqual(expected)
    const frozen = immutableCatalogSnapshot(structuredClone(CURRENT_CATALOG))
    expect(referenceGuidance(frozen, frozen.entities[shard.id]!)).toEqual(expected)
    for (const catalog of [
      { ...CURRENT_CATALOG, id: 'synthetic:import' as typeof CURRENT_CATALOG.id },
      { ...CURRENT_CATALOG, revisionId: 'synthetic:revision' as typeof CURRENT_CATALOG.revisionId },
      { ...CURRENT_CATALOG, checksum: 'synthetic:checksum' },
      { ...CURRENT_CATALOG, legacy: { sourceContentDigest: 'synthetic:digest' } },
    ]) expect(referenceGuidance(catalog, shard)).toEqual([])
    for (const changes of [
      { name: 'Custom shard' }, { rawDescription: 'Custom explanation' }, { sources: [] },
      { fields: { ...clone.fields, [NATIVE_RECORD_FIELD]: { state: 'known' as const, value: {} } } },
      { legacy: { native: { ...nativeIdentity(shard)!, mode: 'Vanilla' } } },
    ]) expect(referenceGuidance(CURRENT_CATALOG, { ...clone, ...changes })).toEqual([])
    expect(referenceGuidance(CURRENT_CATALOG, { ...clone, revision: 1 } as unknown as PersonalDefinition)).toEqual([])
    const shell = Object.freeze(structuredClone(shard))
    expect(referenceGuidance(CURRENT_CATALOG, shell)).toEqual(expected)
    Object.assign(shell.fields, { 'Synthetic edit': { state: 'unknown' } })
    expect(referenceGuidance(CURRENT_CATALOG, shell)).toEqual([])
    const wrongMode: CatalogEntity = { ...clone, id: 'base:item:22:mode:Vanilla' as typeof clone.id }
    expect(referenceGuidance(CURRENT_CATALOG, wrongMode)).toEqual([])
  })
})

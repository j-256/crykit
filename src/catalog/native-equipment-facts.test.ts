import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { nativeEquipmentFacts } from './native-equipment-facts'
import { nativeDescription } from './native-description'
import { corroboratedFact } from './source-corroboration'
import { projectSourceSemantics } from './source-semantics'
import { nativeIdentity, nativeRecord, nativeSourceRecord, NATIVE_RECORD_FIELD, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import type { CatalogEntity, JsonValue } from '../domain/types'

const equipment = (id: number) => DEFAULT_CATALOG.entities[`base:equipment:${id}`]!

describe('native equipment presentation', () => {
  it('derives Dress MP directly from Flat_MP without needing a corresponding wiki field', () => {
    const dress = equipment(134)
    const before = JSON.stringify(dress)
    expect(dress.fields['Max mp']).toBeUndefined()
    expect(nativeSourceRecord(dress)?.StatMods).toContainEqual({ Tag: 1, Value1: 20, Value2: 0, Value3: 0 })
    const projection = nativeEquipmentFacts(DEFAULT_CATALOG, dress)!
    expect(projection.facts.map(fact => [fact.field, fact.value.state === 'known' ? fact.value.value : undefined])).toEqual([['Defense', 19], ['Resistance', 78], ['Max mp', 20]])
    const locator = dress.sources.find(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX))!.locator
    expect(projection.facts.find(fact => fact.field === 'Max mp')?.evidence).toBe(`${locator}; StatMods; Flat_MP`)
    expect(projection.facts.every(fact => fact.value.state === 'known' && fact.value.sources?.every(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX)))).toBe(true)
    expect(JSON.stringify(dress)).toBe(before)
  })

  it('produces the same native stat without a legacy Stat field or a legacy numeric value', () => {
    const sword = equipment(532)
    expect(sword.fields.Stat).toBeUndefined()
    expect(sword.fields['Max mp']).toBeUndefined()
    expect(nativeEquipmentFacts(DEFAULT_CATALOG, sword)?.facts.find(fact => fact.field === 'Max mp')).toMatchObject({ value: { state: 'known', value: 20 }, evidence: expect.stringContaining('StatMods; Flat_MP') })
    const shoes = equipment(320)
    expect(nativeEquipmentFacts(DEFAULT_CATALOG, shoes)?.facts.find(fact => fact.field === 'Dexterity')).toMatchObject({ value: { state: 'known', value: 14 } })
    expect(shoes.fields.Stat).toMatchObject({ value: 'Dexterity +6\nAgility +16' })
  })

  it('archives complete legacy stat and effect summaries without claiming their prose is equivalent', () => {
    for (const [id, field] of [[134, 'Stat'], [134, 'Effect'], [134, 'Other effects'], [274, 'Other effects'], [286, 'Stat'], [336, 'Effect']] as const) {
      const entity = equipment(id)
      const original = entity.fields[field]!
      expect(nativeDescription(entity)?.complete).toBe(true)
      expect(corroboratedFact({ catalog: DEFAULT_CATALOG, entity }, field, original)).toBe(false)
      const archived = nativeEquipmentFacts(DEFAULT_CATALOG, entity)?.archivedFields.find(([name]) => name === field)
      expect(archived?.[1]).toBe(original)
      expect(corroboratedFact({ catalog: DEFAULT_CATALOG, entity }, field, original)).toBe(false)
    }
  })

  it('archives only slash summaries whose component field names are supported stats', () => {
    const entity = Object.values(DEFAULT_CATALOG.entities).find(entity => nativeIdentity(entity)?.database === 'equipment' && entity.fields['Attack/Max. MP'] && nativeDescription(entity)?.complete)!
    expect(entity).toBeDefined()
    const archived = nativeEquipmentFacts(DEFAULT_CATALOG, entity)?.archivedFields
    expect(archived?.find(([field]) => field === 'Attack/Max. MP')?.[1]).toBe(entity.fields['Attack/Max. MP'])
    const sword = equipment(0)
    expect(sword.fields['Attack/Pierce/Hands']).toBeDefined()
    expect(nativeEquipmentFacts(DEFAULT_CATALOG, sword)?.archivedFields.some(([field]) => field === 'Attack/Pierce/Hands')).toBe(false)
    expect(archived?.some(([field]) => field === 'Description' || field === 'Location')).toBe(false)
  })

  it('keeps original summaries available when native rendering is incomplete', () => {
    const cutter = equipment(198)
    const before = JSON.stringify(cutter)
    expect(nativeDescription(cutter)).toMatchObject({ complete: false, unresolved: ['Stat modifier: ReplaceAttackWith'] })
    const projection = nativeEquipmentFacts(DEFAULT_CATALOG, cutter)!
    expect(projection.facts.find(fact => fact.field === 'Attack')).toMatchObject({ value: { state: 'known', value: 165 } })
    expect(projection.archivedFields).toEqual([])
    expect(cutter.fields['Other effects']).toMatchObject({ state: 'known', value: 'Replace basic attack with: Mug\nTargets are always left with at least 1 HP' })
    expect(JSON.stringify(cutter)).toBe(before)
  })

  it('does not turn percentage or per-turn modifiers into flat values or invent absent zero stats', () => {
    for (const id of [503, 336, 455]) {
      const projection = nativeEquipmentFacts(DEFAULT_CATALOG, equipment(id))!
      expect(projection).toBeDefined()
      expect(projection.facts.some(fact => fact.field === 'Max hp' || fact.field === 'Max mp')).toBe(false)
    }
    const sword = nativeEquipmentFacts(DEFAULT_CATALOG, equipment(0))!
    expect(sword.facts.map(fact => fact.field)).toEqual(['Attack'])
    expect(nativeEquipmentFacts(DEFAULT_CATALOG, equipment(303))?.facts.find(fact => fact.field === 'Max mp')).toMatchObject({ value: { state: 'known', value: -100 } })
  })

  it('accepts exact immutable copies and reviewed source-semantic projections only', () => {
    const dress = equipment(134)
    const expected = nativeEquipmentFacts(DEFAULT_CATALOG, dress)
    const clonedCatalog = { ...DEFAULT_CATALOG, legacy: structuredClone(DEFAULT_CATALOG.legacy) }
    const clone = structuredClone(dress)
    expect(nativeEquipmentFacts(clonedCatalog, clone)).toEqual(expected)
    expect(nativeEquipmentFacts(DEFAULT_CATALOG, projectSourceSemantics(dress))).toEqual(expected)
    const record = nativeSourceRecord(clone)!
    if (!Array.isArray(record.StatMods) || !nativeRecord(record.StatMods[0])) throw new Error('Dress must have a native modifier')
    const changed = { ...clone, fields: { ...clone.fields, [NATIVE_RECORD_FIELD]: { state: 'known' as const, value: { ...record, StatMods: [{ ...record.StatMods[0], Value1: 999 }, ...record.StatMods.slice(1)] } } } }
    expect(nativeEquipmentFacts(clonedCatalog, changed)).toBeUndefined()
  })

  it('retains claims on imported, revised, or modified records instead of using native projection', () => {
    const dress = equipment(134)
    for (const catalog of [
      { ...DEFAULT_CATALOG, id: 'imported:synthetic' as typeof DEFAULT_CATALOG.id },
      { ...DEFAULT_CATALOG, revisionId: 'changed' as typeof DEFAULT_CATALOG.revisionId },
      { ...DEFAULT_CATALOG, checksum: 'changed' },
      { ...DEFAULT_CATALOG, legacy: { ...(nativeRecord(DEFAULT_CATALOG.legacy) ? DEFAULT_CATALOG.legacy : {}), sourceContentDigest: 'changed' } },
    ]) expect(nativeEquipmentFacts(catalog, dress)).toBeUndefined()
    for (const entity of [
      { ...dress, name: 'Custom dress' },
      { ...dress, fields: { ...dress.fields, Stat: { state: 'known' as const, value: 'Custom explanation' } } },
      { ...dress, sources: [] },
      { ...dress, fields: { ...dress.fields, [NATIVE_RECORD_FIELD]: { state: 'known' as const, value: { ...nativeSourceRecord(dress), StatMods: null } } } },
    ]) expect(nativeEquipmentFacts(DEFAULT_CATALOG, entity)).toBeUndefined()
    expect(nativeEquipmentFacts(DEFAULT_CATALOG, DEFAULT_CATALOG.entities['mod:moonlight-project:ability:565']!)).toBeUndefined()
  })

  it('rejects changed hidden, unknown, duplicated, or malformed native modifiers', () => {
    const dress = equipment(134)
    const record = nativeSourceRecord(dress)!
    if (!Array.isArray(record.StatMods)) throw new Error('Dress must have native modifiers')
    const changes: readonly Readonly<Record<string, JsonValue>>[] = [
      { HideStatModsFromDescription: true },
      { StatMods: [{ Tag: 999_999, Value1: 20, Value2: 0, Value3: 0 }] },
      { StatMods: [...record.StatMods, record.StatMods[0]!] },
      { StatMods: [{ Tag: 1, Value1: 20, Value2: 0 }] },
      { StatMods: [{ Tag: 1, Value1: '20', Value2: 0, Value3: 0 }] },
    ]
    for (const change of changes) {
      const changed: CatalogEntity = { ...dress, fields: { ...dress.fields, [NATIVE_RECORD_FIELD]: { state: 'known', value: { ...record, ...change } } } }
      expect(nativeEquipmentFacts(DEFAULT_CATALOG, changed)).toBeUndefined()
      expect(changed.fields.Stat).toBe(dress.fields.Stat)
    }
  })
})

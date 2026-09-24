import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { previewImport } from './import'

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

describe('import format detection', () => {
  it('rejects ambiguous research ZIP payloads', async () => {
    const payload = encode({ schema_version: '1.1.0' })
    const archive = zipSync({ 'first.json': payload, 'second.json': payload })
    await expect(previewImport(archive, 'ambiguous.zip')).rejects.toMatchObject({
      code: 'schema-mismatch',
    })
  })

  it('preserves unknown research fields while keeping formula text non-authoritative', async () => {
    const preview = await previewImport(encode({
      schema_version: '1.1.0',
      classes: [{ id: 'fixture:class', name: 'Fixture', formula_text: '1 + 1', future_field: { value: 2 } }],
    }), 'research.json')
    const catalog = preview.proposed.catalogs[0]
    const entity = catalog?.entities['fixture:class']
    expect(entity?.fields.formula_text).toMatchObject({ state: 'unknown' })
    expect(entity?.fields.future_field).toMatchObject({ state: 'known', value: { value: 2 } })
    expect(catalog?.legacy).toMatchObject({ schema_version: '1.1.0' })
  })

  it('does not infer positive progress from negated labels or ambiguous names', async () => {
    const preview = await previewImport(encode({
      schema_version: '1.1.0',
      classes: [
        { id: 'fixture:first', name: 'Duplicate' },
        { id: 'fixture:second', name: 'Duplicate' },
      ],
      progress: [
        { class: 'Duplicate', mastery: 'not mastered', seal: 'not collected' },
        { class_id: 'fixture:first', class: 'Duplicate', mastery: 'not mastered', seal: 'not collected' },
      ],
    }), 'research.json')
    expect(Object.values(preview.proposed.profile.progress)).toHaveLength(1)
    const record = Object.values(preview.proposed.profile.progress)[0]
    expect(record?.subject).toMatchObject({ entityId: 'fixture:first' })
    expect(record?.stage).toMatchObject({ state: 'unknown' })
    expect(record?.partyMastery).toMatchObject({ state: 'unknown' })
    expect(record?.collection).toMatchObject({ state: 'unknown' })
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unresolved-progress-class', locator: '/progress/0' }),
    ]))
  })

  it('uses a source namespace and exposes supplemental rows as entities and claims', async () => {
    const preview = await previewImport(encode({
      schema_version: '1.1.0',
      catalog_id: 'fixture:catalog',
      expansion_items: [{ item_id: 'fixture:item', name: 'Fixture item' }],
      expansion_locations: [{ item_id: 'fixture:item', location: 'Fixture cave' }],
      planner_rules: [{ rule_id: 'fixture:rule', rule: 'Fixture rule', scope: 'unknown' }],
    }), 'research.json')
    const catalog = preview.proposed.catalogs[0]
    expect(catalog?.id).toBe('fixture:catalog')
    expect(Object.values(catalog?.entities ?? {}).some((entity) => entity.kind === 'location')).toBe(true)
    expect(catalog?.entities['fixture:rule']?.kind).toBe('other')
    expect(catalog?.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: 'fixture:item', field: 'expansion_locations.location' }),
    ]))
  })

  it('projects explicit descriptions, aliases, and numeric PP with source provenance', async () => {
    const preview = await previewImport(encode({
      schema_version: '1.1.0',
      passives: [{
        passive_id: 'fixture:passive',
        name: 'Fixture Ward',
        aliases: ['Ward alias'],
        description: 'Weatherproof field note',
        pp_cost: 4,
      }],
    }), 'research.json')
    const catalog = preview.proposed.catalogs[0]
    const passive = catalog?.entities['fixture:passive']
    expect(passive).toMatchObject({
      rawDescription: 'Weatherproof field note',
      aliases: ['Ward alias'],
      ppCost: { state: 'known', value: 4 },
    })
    expect(passive?.ppCost?.state === 'known' ? passive.ppCost.sources?.[0]?.locator : undefined).toBe('/passives/0')
  })

  it('preserves every duplicate source identity with collision-safe source-scoped IDs', async () => {
    const preview = await previewImport(encode({
      schema_version: '1.1.0',
      classes: [
        { id: 'fixture:duplicate', name: 'First' },
        { id: 'fixture:duplicate', name: 'Second' },
      ],
      passives: [{ id: 'fixture:duplicate', name: 'Third' }],
      coverage: [{ class_id: 'fixture:duplicate', class: 'First', completion: 100 }],
      progress: [{ class_id: 'fixture:duplicate', class: 'First', mastery: 'mastered' }],
    }), 'research.json')
    const entities = Object.values(preview.proposed.catalogs[0]?.entities ?? {})
    expect(entities.map((entity) => entity.name).sort()).toEqual(['First', 'Second', 'Third'])
    expect(new Set(entities.map((entity) => entity.id)).size).toBe(3)
    expect(preview.warnings.filter((warning) => warning.code === 'duplicate-entity-id')).toHaveLength(2)
    expect(preview.proposed.profile.progress).toEqual({})
    expect(preview.proposed.catalogs[0]?.claims.some((claim) => claim.field === 'coverage.completion')).toBe(false)
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ambiguous-entity-id', locator: '/coverage/0' }),
      expect.objectContaining({ code: 'unresolved-progress-class', locator: '/progress/0' }),
    ]))
  })

  it('does not attach an earlier supplemental claim when a later entity duplicates its source ID', async () => {
    const preview = await previewImport(encode({
      schema_version: '1.1.0',
      classes: [{ id: 'fixture:late-duplicate', name: 'Fixture Class' }],
      coverage: [{ class_id: 'fixture:late-duplicate', class: 'Fixture Class', completion: 100 }],
      conflicts: [{ id: 'fixture:late-duplicate', topic: 'Conflicting source identity' }],
    }), 'late-duplicate.json')

    expect(preview.proposed.catalogs[0]?.claims).not.toContainEqual(expect.objectContaining({ field: 'coverage.completion' }))
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: 'ambiguous-entity-id',
      locator: '/coverage/0',
    }))
  })

  it('rejects control characters in external catalog and entity identities', async () => {
    await expect(previewImport(encode({ schema_version: '1.1.0', catalog_id: 'bad\u0000catalog' }), 'research.json')).rejects.toMatchObject({ code: 'schema-mismatch' })
    await expect(previewImport(encode({ schema_version: '1.1.0', classes: [{ id: 'bad\u0000class', name: 'Bad' }] }), 'research.json')).rejects.toMatchObject({ code: 'schema-mismatch' })
  })
})

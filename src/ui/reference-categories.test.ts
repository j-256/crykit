import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { EQUIPMENT_TYPES } from '../domain/crystal-edit'
import { nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import { bundledModRecord } from '../domain/bundled-mods'
import type { CatalogEntity, EntityId, JsonValue, Knowledge } from '../domain/types'
import { EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_KEY, equipmentCategory, referenceCategoryKey, referenceCategoryKeys, referenceCategoryLabel, referenceCategorySearchText } from './reference-categories'
import { referenceCategoryKnowledge } from './reference-facets'
import { buildFacetOptions, buildReferenceSearchItems, partitionPersonalDefinitionOptions, partitionReferenceItems, personalDefinitionCategoryValues } from './search'

describe('reference category identities', () => {
  it.each(EQUIPMENT_TYPES.map((type, code) => ({ type, code })))('projects $type through the same numeric identity for native, mod, and personal records', ({ type, code }) => {
    const category = EQUIPMENT_CATEGORIES[type as keyof typeof EQUIPMENT_CATEGORIES]
    const fields = { 'Equipment type': { state: 'known', value: 'Unrelated supplemental classification' } as Knowledge<JsonValue> }
    const native = { kind: 'item' as const, fields: { ...fields, 'Native source record': { state: 'known', value: { EquipmentType: code } } as Knowledge<JsonValue> } }
    const mod = { kind: 'item' as const, fields: { ...fields, 'Crystal Edit source record': { state: 'known', value: { EquipmentType: code } } as Knowledge<JsonValue> } }
    const expected = [{ state: 'known', value: [EQUIPMENT_CATEGORY_KEY, category.key] }]
    expect(referenceCategoryKnowledge(native)).toEqual(expected)
    expect(referenceCategoryKnowledge(mod)).toEqual(expected)
    expect(personalDefinitionCategoryValues({ name: 'Personal equipment', aliases: [], sourceLabel: 'Personal definitions', kind: 'item', record: mod })).toEqual([EQUIPMENT_CATEGORY_KEY, category.key])
    expect(equipmentCategory(code)?.key).toBe(category.key)
    expect(referenceCategoryKey(type)).toBe(category.key)
    for (const sourceLabel of category.sourceLabels) expect(referenceCategoryKey(sourceLabel)).toBe(category.key)
  })

  it('keeps filter keys distinct from rendered labels and combines actual base and expansion axes', () => {
    const items = buildReferenceSearchItems([DEFAULT_CATALOG])
    const filters = { query: '', kinds: ['item' as const], categories: [EQUIPMENT_CATEGORIES.Axe.key], sources: [] }
    const { confirmed } = partitionReferenceItems(items, filters)
    expect(confirmed.some(item => item.entity.name === 'Hand Axe' && nativeIdentity(item.entity)?.mode === 'base')).toBe(true)
    expect(confirmed.some(item => item.entity.name === 'Backbreaker' && bundledModRecord(item.entity)?.EquipmentType === 1)).toBe(true)
    const sourceRecord = (entity: CatalogEntity) => nativeSourceRecord(entity) ?? bundledModRecord(entity)
    expect(confirmed.filter(item => sourceRecord(item.entity)).map(item => item.key)).toEqual(items.filter(item => item.entity.kind === 'item' && sourceRecord(item.entity)?.EquipmentType === 1).map(item => item.key))
    expect(confirmed.filter(item => !sourceRecord(item.entity)).map(item => item.entity.name)).toEqual(['Axes'])
    expect(buildFacetOptions(items.filter(item => item.entity.kind === 'item'), 'category').filter(option => referenceCategoryLabel(option.value) === 'Axes')).toEqual([{ value: 'equipment:axe', count: confirmed.length }])
    expect(partitionReferenceItems(items, { ...filters, categories: ['Axes'] }).confirmed).toEqual([])
    expect(referenceCategoryLabel('equipment:axe')).toBe('Axes')
  })

  it('uses source equipment evidence when a supplemental classification disagrees', () => {
    const source = { state: 'known' as const, value: { EquipmentType: 1 } }
    const record = { kind: 'item' as const, fields: { 'Crystal Edit source record': source, Category: { state: 'conflicting' as const, claims: [{ value: 'Sword', sources: [{ sourceId: 'table' }] }, { value: 'Dagger', sources: [{ sourceId: 'page' }] }] } } }
    expect(referenceCategoryKnowledge(record)).toEqual([{ state: 'known', value: [EQUIPMENT_CATEGORY_KEY, EQUIPMENT_CATEGORIES.Axe.key] }])
    expect(record.fields.Category.state).toBe('conflicting')
  })

  it('preserves arbitrary source tags, unknowns, and conflicts without folding distinct identities', () => {
    const value = { state: 'known' as const, value: ['Custom / group: 100%', 'Custom / group: 100％'], sources: [{ sourceId: 'synthetic' }] }
    const projected = referenceCategoryKeys(value)
    expect(projected).toEqual({ ...value, value: value.value.map(referenceCategoryKey) })
    expect(referenceCategoryKey(value.value[0]!)).not.toBe(referenceCategoryKey(value.value[1]!))
    expect(referenceCategoryLabel(referenceCategoryKey(value.value[0]!))).toBe(value.value[0])
    const unknown = { state: 'unknown' as const, reason: 'Absent in source' }
    expect(referenceCategoryKeys(unknown)).toBe(unknown)
    const conflicting = { state: 'conflicting' as const, claims: [{ value: 'Axe', sources: [{ sourceId: 'a' }] }, { value: 'Sword', sources: [{ sourceId: 'b' }] }] }
    expect(referenceCategoryKeys(conflicting)).toEqual({ ...conflicting, claims: conflicting.claims.map(claim => ({ ...claim, value: [referenceCategoryKey(claim.value)] })) })
    expect(equipmentCategory(999)).toBeUndefined()
    expect(referenceCategoryLabel('category:%invalid')).toBe('category:%invalid')
  })

  it('filters saved personal source labels using equipment keys without modifying the records', () => {
    const record: CatalogEntity = { id: 'synthetic:personal-axe' as EntityId, kind: 'item', name: 'Personal axe', aliases: [], sources: [], fields: { 'Equipment type': { state: 'known', value: 'Axe' } } }
    const personal = [{ kind: 'item' as const, name: record.name, aliases: [], sourceLabel: 'Personal definitions', record }]
    expect(partitionPersonalDefinitionOptions(personal, { query: '', kinds: [], categories: [EQUIPMENT_CATEGORIES.Axe.key], sources: [] }).confirmed).toEqual(personal)
    expect(record.fields['Equipment type']).toEqual({ state: 'known', value: 'Axe' })
  })

  it('retains an explicit personal category alongside source equipment identity', () => {
    const category = { state: 'known' as const, value: 'Synthetic weapons' }
    const record = { kind: 'item' as const, fields: { Category: category, 'Native source record': { state: 'known' as const, value: { EquipmentType: 0 } } } }
    const option = { name: 'Personal sword', aliases: [], sourceLabel: 'Personal definitions', kind: 'item' as const, record, category }
    expect(personalDefinitionCategoryValues(option)).toEqual([EQUIPMENT_CATEGORY_KEY, referenceCategoryKey('Synthetic weapons'), EQUIPMENT_CATEGORIES.Sword.key])
    expect(partitionPersonalDefinitionOptions([option], { query: '', kinds: [], categories: [referenceCategoryKey('Synthetic weapons')], sources: [] }).confirmed).toEqual([option])
    expect(referenceCategorySearchText(EQUIPMENT_CATEGORIES.Staff.key)).toContain('Staff')
    expect(referenceCategoryLabel(EQUIPMENT_CATEGORIES.Staff.key)).toBe('Staves')
  })
})

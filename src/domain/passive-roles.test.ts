import { describe, expect, it } from 'vitest'
import { bundledModEntityId } from './bundled-mods'
import { analyzeBuildEquipment, innateEffects } from './build-mechanics'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { PC_RULES } from './calculation-rules'
import { collectEffectiveModifiers } from './effective-modifiers'
import { passiveRoles } from './passive-roles'
import { CRYSTAL_EDIT_FIELDS } from './crystal-edit'
import type { BuildRevisionContent, CatalogEntity, CatalogId, CatalogRef, CatalogRevisionId, EntityId, EntityRef, JsonValue } from './types'

const known = (value: JsonValue) => ({ state: 'known' as const, value })
const key = 'synthetic-passive-roles'
const classId = bundledModEntityId(key, 'Jobs', 40)
const passiveId = bundledModEntityId(key, 'Passives', 41)
const ref = (entityId: EntityId): CatalogRef => ({ kind: 'catalog', catalogId: 'crystal-edit:synthetic-passive-roles' as CatalogId, catalogRevisionId: 'synthetic-source-revision' as CatalogRevisionId, entityId })
const tag = (name: string, value: number) => ({ Tag: Number(Object.entries(PC_RULES.statMods).find(([, entry]) => entry.name === name)![0]), Value1: value, Value2: 0, Value3: 0 })
const passiveRecord = { ID: 41, Name: 'A renamed ordinary passive', IsInnate: true, IsLearnable: true, PP: 1, StatMods: [tag('Flat_MPCosts', -2), tag('MaxDamageGiven', 50), tag('ImmuneToStatusCategory', 1)] }
const passive: CatalogEntity = { id: passiveId, kind: 'innate', name: passiveRecord.Name, aliases: [], sources: [], fields: { 'Crystal Edit source record': known(passiveRecord) } }
const job: CatalogEntity = { id: classId, kind: 'class', name: 'Unrelated project title', aliases: [], sources: [], legacy: { bundledMod: { key, family: 'Jobs', modelId: 40, version: '1', requiredMod: 'Unrelated project title' }, passiveEntityIds: { 41: passiveId } }, fields: { 'Crystal Edit source record': known({ ID: 40, Name: 'Unrelated project title', PassiveIDs: [41], StatMods: [] }), [CRYSTAL_EDIT_FIELDS.passives]: known([41]) } }
const resolve = (value: EntityRef) => value.kind === 'catalog' ? [job, passive].find(definition => definition.id === value.entityId) : undefined
const build = (passives: BuildRevisionContent['passives']): BuildRevisionContent => ({ primaryClass: ref(classId), secondaryClass: null, equipment: {}, passives, contextAssumptions: [] })

describe('source-driven passive roles', () => {
  it('sameSourceCanBeAutomaticAndLearnable', () => {
    expect(passiveRoles(passive)).toEqual({ automatic: 'true', learnable: 'true' })
    expect(passiveRoles({ ...passive, name: 'Completely different display name' })).toEqual(passiveRoles(passive))
    expect(passiveRoles({ ...passive, fields: {} })).toEqual({ automatic: 'unknown', learnable: 'unknown' })
    expect(passiveRoles({ ...passive, fields: { ...passive.fields, 'Native source record': known({ IsInnate: false, IsLearnable: false }) } })).toEqual({ automatic: 'true', learnable: 'true' })
  })

  it('automaticDoesNotOccupyEquippedDuplicateSet', () => {
    expect(innateEffects(build([]), resolve).map(effect => effect.definition.id)).toEqual([passiveId])
    const once = analyzeBuildEquipment(build([{ ref: ref(passiveId) }]), SUGGESTED_BUILD_SLOTS, resolve)
    expect(once.some(issue => issue.code === 'DUPLICATE_PASSIVE')).toBe(false)
    const twice = analyzeBuildEquipment(build([{ ref: ref(passiveId) }, { ref: ref(passiveId) }]), SUGGESTED_BUILD_SLOTS, resolve)
    expect(twice.some(issue => issue.code === 'DUPLICATE_PASSIVE')).toBe(true)
  })

  it('stacks ordinary automatic and equipped records using native operations', () => {
    const result = collectEffectiveModifiers(build([{ ref: ref(passiveId) }]), SUGGESTED_BUILD_SLOTS, resolve)
    expect(result.records.filter(record => record.ref?.kind === 'catalog' && record.ref.entityId === passiveId)).toHaveLength(2)
    expect(result.stats.MPCostsFlat).toBe(-4)
    expect(result.stats.MaxDamageGiven).toBe(50)
    expect(result.statusImmunityCategories).toEqual([1, 1])
  })
})

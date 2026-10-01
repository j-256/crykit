import { catalogEntity } from '../domain/entity-identities'
import { describe, expect, it } from 'vitest'
import { statContributions } from '../domain/build-stats'
import { CLASS_FIELDS, exportedTree } from '../domain/crystal-edit'
import { DEFAULT_CATALOG } from './bundled'
import { EQUIPMENT_EXPANSION_ENTITY_IDS, EQUIPMENT_EXPANSION_EQUIPMENT_IDS } from './equipment-expansion'
import { LEARNABLE_INNATES_SOURCE } from './learnable-innates'
import { SWITCH_PASSIVE_PP_SOURCE } from './switch'

describe('bundled mod definition evidence', () => {
  it('replaces the name-only equipment set with exact versioned definitions and supporting records', () => {
    expect(EQUIPMENT_EXPANSION_EQUIPMENT_IDS).toHaveLength(229)
    expect(EQUIPMENT_EXPANSION_ENTITY_IDS).toHaveLength(396)
    for (const id of EQUIPMENT_EXPANSION_ENTITY_IDS) expect(catalogEntity(DEFAULT_CATALOG, id), id).toBeDefined()
    const heavyEdge = catalogEntity(DEFAULT_CATALOG, 'mod:equipment-expansion:item:heavy-edge')!
    expect(heavyEdge.fields['Equipment type']).toMatchObject({ state: 'known', value: 'Sword' })
    expect(heavyEdge.fields['Stat modifiers']).toMatchObject({ state: 'known', value: expect.arrayContaining([expect.objectContaining({ Name: 'Flat_PAtk', Tag: 40, Value1: 45 })]) })
    expect(heavyEdge.listedContributions?.Attack).toMatchObject({ state: 'known', value: { value: 45, unit: 'listed flat value' } })
    expect(statContributions(heavyEdge).contributions).toContainEqual(expect.objectContaining({ stat: 'ATK', kind: 'flat', value: 45 }))
    expect(heavyEdge.sources.some(source => source.snapshot?.includes('Version 1.3'))).toBe(true)
    expect(catalogEntity(DEFAULT_CATALOG, 'mod:equipment-expansion:item:tarot-accessories')).toBeUndefined()
    expect(catalogEntity(DEFAULT_CATALOG, 'mod:equipment-expansion:item:0-fool')).toBeDefined()
    expect(catalogEntity(DEFAULT_CATALOG, 'mod:equipment-expansion:ability:reckless-charge')).toBeDefined()
  })

  it('keeps dated innate unlock evidence separate while retaining newer Switch PP authority', () => {
    const fighter = DEFAULT_CATALOG.entities['base:warrior:innate:fighter']!
    expect(fighter.ppCost).toMatchObject({ state: 'known', value: 4 })
    expect(fighter.ppCost?.state === 'known' && fighter.ppCost.sources?.map(source => source.sourceId)).toEqual(expect.arrayContaining([SWITCH_PASSIVE_PP_SOURCE.sourceId, LEARNABLE_INNATES_SOURCE.sourceId]))
    expect(fighter.fields['Learnable Innate Skill v1.0 JP cost']).toMatchObject({ state: 'known', value: 500 })
    expect(fighter.fields['Learnable Innate Skill v1.0 JP cost']?.state === 'known' && fighter.fields['Learnable Innate Skill v1.0 JP cost'].sources?.[0]?.applicability).toContain('may predate')
    const shapeshift = DEFAULT_CATALOG.entities['base:mimic:innate:shapeshift']!
    expect(shapeshift.ppCost).toMatchObject({ state: 'known', value: 10 })
    expect(shapeshift.ppCost?.state === 'known' && shapeshift.ppCost.sources?.[0]?.sourceId).toBe(LEARNABLE_INNATES_SOURCE.sourceId)
    expect(shapeshift.fields['Crystal Edit source record']).toBeUndefined()
    expect(shapeshift.fields['Learnable Innate Skill v1.0 source record']).toMatchObject({ state: 'known', value: expect.objectContaining({ IsInnate: true, IsLearnable: true, JP: 500, PP: 10 }) })
  })

  it('adds dated placements without replacing the current class tree', () => {
    const samurai = DEFAULT_CATALOG.entities['base:class:samurai']!
    expect(samurai.fields['Learnable Innate Skill v1.0 placements']).toMatchObject({ state: 'known', value: [expect.objectContaining({ innate: 'Endless Fury' }), expect.objectContaining({ innate: 'Two-Handed' })] })
    expect(exportedTree(samurai)).not.toHaveLength(0)
    expect(samurai.fields[CLASS_FIELDS.tree]?.state).toBe('known')
  })
})

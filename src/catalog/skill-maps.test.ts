import { describe, expect, it } from 'vitest'
import { asId } from '../domain/core'
import { createCharacter } from '../domain/characters'
import { createBlankProfile, createDefinitionOverride, createPersonalDefinition } from '../domain/profile'
import { resolveDefinition } from '../domain/definitions'
import { importSkillTrees } from '../domain/skill-trees'
import { createTestProfile, known, TEST_RULESET_REVISION_ID } from '../domain/test-helpers'
import type { CharacterId, SkillSquare } from '../domain/types'
import { CONFIRMED_SKILL_MAPS, CONFIRMED_SKILL_MAP_SETS, skillMapSetForRuleset, suggestSkillTreeMap, SWITCH_MOD_PACKS_MAP_SET } from './skill-maps'
import { STARTER_CATALOG } from './starter'

const catalogs = [STARTER_CATALOG]
const warrior = CONFIRMED_SKILL_MAPS[0]
const squares: readonly SkillSquare[] = warrior.mappings.map(mapping => ({ row: mapping.row, column: mapping.column, state: 'unknown' }))

describe('confirmed class square maps', () => {
  it('resolves the checked Warrior order with exact ability, innate, and passive identities', () => {
    const profile = createBlankProfile()
    const suggestion = suggestSkillTreeMap(profile, catalogs, warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET)
    expect(suggestion.mappings.map(mapping => resolveDefinition(profile, catalogs, mapping.ref)?.name)).toEqual([
      'Taunt', 'Fighter', 'Defender', 'Berserker', 'Equip Sword', 'Equip Axe', 'Power Break', 'Armor Break', 'Bruiser Crush', 'Paragon Crush', 'Blitz Crush', 'Battle Crush', 'Grudge', 'Adrenaline',
    ])
    expect(suggestion.mappings[1].kind).toBe('innate')
    expect(suggestion.mappings.at(-1)?.kind).toBe('passive')
    expect(suggestion.mappings.every(mapping => resolveDefinition(profile, catalogs, mapping.ref)?.kind === mapping.kind)).toBe(true)
  })

  it('requires the selected map set, exact catalog identity, full shape, and available definitions', () => {
    const profile = createBlankProfile()
    expect(suggestSkillTreeMap(profile, catalogs, warrior.classRef, squares, '').mappings).toEqual([])
    expect(suggestSkillTreeMap(profile, catalogs, warrior.classRef, squares.slice(1), SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    expect(suggestSkillTreeMap(profile, [], warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    const anotherRevision = { ...warrior.classRef, catalogRevisionId: STARTER_CATALOG.revisionId + '-other' as typeof STARTER_CATALOG.revisionId }
    expect(suggestSkillTreeMap(profile, catalogs, anotherRevision, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    const personal = createPersonalDefinition(profile, { kind: 'class', name: 'Warrior' })
    const ref = { kind: 'personal' as const, definitionId: Object.values(personal.personalDefinitions)[0].id }
    expect(suggestSkillTreeMap(personal, catalogs, ref, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    const missingAbility = { ...STARTER_CATALOG, entities: Object.fromEntries(Object.entries(STARTER_CATALOG.entities).filter(([id]) => id !== 'base:warrior:ability:taunt')) }
    expect(suggestSkillTreeMap(profile, [missingAbility], warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
  })

  it('preserves exact saved assignments, extends compatible partial maps, and honors personal overrides', () => {
    const profile = createBlankProfile()
    const partial = [warrior.mappings[0]]
    const extended = suggestSkillTreeMap(profile, catalogs, warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET, undefined, partial)
    expect(extended.mappings).toHaveLength(warrior.mappings.length)
    expect(extended.mappings[0]).toBe(partial[0])
    const conflicting = [{ ...warrior.mappings[0], ref: warrior.mappings[2].ref }]
    expect(suggestSkillTreeMap(profile, catalogs, warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET, undefined, conflicting)).toEqual({ mappings: conflicting })
    const override = createDefinitionOverride(profile, catalogs, { sourceRef: warrior.mappings[0].ref, name: 'Personal Taunt label' })
    expect(suggestSkillTreeMap(override.profile, catalogs, warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings[0].ref).toEqual(override.ref)
  })

  it('suggests a map set only from explicit matching platform and explicit enabled and disabled mods', () => {
    const ruleset = createTestProfile().rulesets[TEST_RULESET_REVISION_ID]
    expect(skillMapSetForRuleset()).toBe('')
    expect(skillMapSetForRuleset(ruleset)).toBe('')
    const enabled = CONFIRMED_SKILL_MAP_SETS[0].enabledMods
    const compatible = { ...ruleset, platform: known('Nintendo Switch'), mods: known([...enabled].reverse().map(mod => mod.toLowerCase())), disabledMods: known(CONFIRMED_SKILL_MAP_SETS[0].disabledMods) }
    expect(skillMapSetForRuleset(compatible)).toBe(SWITCH_MOD_PACKS_MAP_SET)
    expect(skillMapSetForRuleset({ ...compatible, disabledMods: undefined })).toBe('')
    expect(skillMapSetForRuleset({ ...compatible, disabledMods: known([]) })).toBe('')
    expect(skillMapSetForRuleset({ ...compatible, platform: { state: 'unknown' } })).toBe('')
    expect(skillMapSetForRuleset({ ...compatible, platform: known('PC') })).toBe('')
    expect(skillMapSetForRuleset({ ...compatible, mods: known(['Mod Pack 1', 'Mod Pack 2']) })).toBe('')
    expect(skillMapSetForRuleset({ ...compatible, mods: known(enabled.filter(mod => mod !== 'Learnable Innate Skill')) })).toBe('')
    expect(skillMapSetForRuleset({ ...compatible, mods: known([...enabled, '1 PP Passives']) })).toBe('')
  })

  it('compiles synthetic square states into named character learning and reuses the saved map', () => {
    const characterId = asId<CharacterId>('synthetic-map-rowan')
    const profile = createCharacter(createBlankProfile(), { id: characterId, name: 'Rowan' })
    const observed = squares.map((square, index) => ({ ...square, state: index === 1 ? 'learned' as const : 'locked' as const }))
    const suggestion = suggestSkillTreeMap(profile, catalogs, warrior.classRef, observed, SWITCH_MOD_PACKS_MAP_SET)
    const imported = importSkillTrees(profile, catalogs, [{ characterId, classRef: warrior.classRef, sourceDigest: 'c'.repeat(64), filename: 'synthetic-warrior.png', squares: observed, mappings: suggestion.mappings, reviewed: true }], profile.revision)
    const learned = Object.values(imported.characters[characterId].learnedNodes).filter(node => node.learned.state === 'known' && node.learned.value)
    expect(learned.map(node => [resolveDefinition(imported, catalogs, node.ref)?.name, node.kind])).toEqual([['Fighter', 'innate']])
    expect(imported.characters[characterId].classProgress).toEqual({})
    expect(suggestSkillTreeMap(imported, catalogs, warrior.classRef, observed, '').mappings).toEqual(suggestion.mappings)
  })
})

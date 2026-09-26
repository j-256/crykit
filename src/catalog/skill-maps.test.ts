import { ADDITIONAL_CLASS_MAP_FIXTURES } from './skill-maps.test-helpers'
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

  it('maps Monk positions with Aversive and Brawler as learnable innates', () => {
    const profile = createBlankProfile()
    const monk = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === 'base:class:monk')!
    const observed: readonly SkillSquare[] = [[0, 1], [0, 2], [0, 3], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [4, 0], [5, 1], [5, 2]].map(([row, column]) => ({ row, column, state: 'unknown' }))
    const suggestion = suggestSkillTreeMap(profile, catalogs, monk.classRef, observed, SWITCH_MOD_PACKS_MAP_SET)
    expect(suggestion.mappings.map(mapping => [mapping.row, mapping.column, resolveDefinition(profile, catalogs, mapping.ref)?.name, mapping.kind])).toEqual([
      [0, 1, 'Meditate', 'ability'],
      [0, 2, 'Beat Down', 'ability'],
      [0, 3, 'Aversive', 'innate'],
      [1, 1, 'First-Aid', 'ability'],
      [1, 2, 'Earth Split', 'ability'],
      [2, 0, 'Brawler', 'innate'],
      [2, 1, 'Chakra', 'ability'],
      [2, 2, 'Thunder Chop', 'ability'],
      [2, 3, 'Counter', 'passive'],
      [3, 1, 'Focus Energy', 'ability'],
      [3, 2, 'Wind Punch', 'ability'],
      [4, 0, 'HP Boost', 'passive'],
      [5, 1, 'Revive', 'ability'],
      [5, 2, 'Chi Burst', 'ability'],
    ])
    expect(suggestion.mappings.every(mapping => resolveDefinition(profile, catalogs, mapping.ref)?.kind === mapping.kind)).toBe(true)
    expect(suggestSkillTreeMap(profile, catalogs, warrior.classRef, observed, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    expect(suggestSkillTreeMap(profile, catalogs, monk.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
  })

  for (const fixture of ADDITIONAL_CLASS_MAP_FIXTURES) {
    it(`maps confirmed ${fixture.className} names and imports only their observed learning`, () => {
      const characterId = asId<CharacterId>('synthetic-mapped-character')
      const profile = createCharacter(createBlankProfile(), { id: characterId, name: 'Rowan' })
      const map = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === `base:class:${fixture.className.toLowerCase()}`)!
      const observed: readonly SkillSquare[] = fixture.squares.map(([row, column], index) => ({ row, column, state: index % 3 === 0 ? 'learned' : 'locked' }))
      const suggestion = suggestSkillTreeMap(profile, catalogs, map.classRef, observed, SWITCH_MOD_PACKS_MAP_SET)
      expect(suggestion.confirmedMap).toBe(map)
      expect(suggestion.mappings.map(mapping => [mapping.row, mapping.column, resolveDefinition(profile, catalogs, mapping.ref)?.name, mapping.kind])).toEqual(fixture.squares.filter(square => square[2] !== null))
      expect(suggestSkillTreeMap(profile, catalogs, map.classRef, observed.slice(1), SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
      const imported = importSkillTrees(profile, catalogs, [{ characterId, classRef: map.classRef, sourceDigest: 'e'.repeat(64), filename: 'synthetic-class.png', squares: observed, mappings: suggestion.mappings, reviewed: true }], profile.revision)
      const learned = Object.values(imported.characters[characterId].learnedNodes).filter(node => node.learned.state === 'known' && node.learned.value)
      expect(learned.map(node => [resolveDefinition(imported, catalogs, node.ref)?.name, node.kind])).toEqual(fixture.squares.filter((square, index) => square[2] !== null && index % 3 === 0).map(square => [square[2], square[3]]))
      expect(imported.characters[characterId].classProgress).toEqual({})
    })
  }

  it('keeps unconfirmed Scholar positions unresolved while preserving a later reviewed assignment', () => {
    const profile = createBlankProfile()
    const map = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === 'base:class:scholar')!
    const observed: readonly SkillSquare[] = map.squares.map(square => ({ ...square, state: 'learned' }))
    const suggestion = suggestSkillTreeMap(profile, catalogs, map.classRef, observed, SWITCH_MOD_PACKS_MAP_SET)
    expect(suggestion.mappings.some(mapping => mapping.row === 3 && mapping.column === 0)).toBe(false)
    const reviewed = { row: 3, column: 0, kind: 'monsterMagic' as const, ref: { ...map.classRef, entityId: asId<typeof map.classRef.entityId>('base:scholar:monster-magic:reflection') } }
    const extended = suggestSkillTreeMap(profile, catalogs, map.classRef, observed, SWITCH_MOD_PACKS_MAP_SET, undefined, [reviewed])
    expect(extended.confirmedMap).toBe(map)
    expect(extended.mappings).toContain(reviewed)
    expect(extended.mappings).toHaveLength(suggestion.mappings.length + 1)
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

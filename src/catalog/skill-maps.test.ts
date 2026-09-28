import { CLASS_MAP_FIXTURES } from './skill-maps.test-helpers'
import { describe, expect, it } from 'vitest'
import { asId } from '../domain/core'
import { createCharacter } from '../domain/characters'
import { createBlankProfile, createDefinitionOverride, createPersonalDefinition } from '../domain/profile'
import { resolveDefinition } from '../domain/definitions'
import { importSkillTrees, SKILL_SQUARE_STATES } from '../domain/skill-trees'
import { createTestProfile, known, TEST_NOW, TEST_RULESET_REVISION_ID } from '../domain/test-helpers'
import type { CharacterId, SkillSquare } from '../domain/types'
import { detectSkillGrid } from '../interchange/skill-grid'
import { SKILL_BORDER_COLORS, skillGridFixture } from '../interchange/skill-grid.test-helpers'
import { CONFIRMED_SWITCH_MOD_SETUP } from './mods'
import { CONFIRMED_SKILL_MAPS, CONFIRMED_SKILL_MAP_SETS, skillMapSetForRuleset, suggestSkillTreeMap, SWITCH_MOD_PACKS_MAP_SET } from './skill-maps'
import { STARTER_CATALOG } from './starter'

const catalogs = [STARTER_CATALOG]
const warrior = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === 'base:class:warrior')!
const squares: readonly SkillSquare[] = warrior.mappings.map(mapping => ({ row: mapping.row, column: mapping.column, state: 'unknown' }))

describe('confirmed class square maps', () => {
  it('has an independent fixture for every confirmed class identity', () => {
    const fixtureClasses = CLASS_MAP_FIXTURES.map(fixture => fixture.classId ?? `base:class:${fixture.className.toLowerCase()}`)
    expect(fixtureClasses.sort()).toEqual(CONFIRMED_SKILL_MAPS.map(map => map.classRef.entityId).sort())
  })

  for (const fixture of CLASS_MAP_FIXTURES) {
    it.each(SKILL_SQUARE_STATES)(`detects ${fixture.className} pixels and imports observed learning with a %s first square`, firstState => {
      const characterId = asId<CharacterId>('synthetic-mapped-character')
      const original = createCharacter(createTestProfile(), { id: characterId, name: 'Rowan', now: TEST_NOW })
      const ruleset = {
        ...original.rulesets[TEST_RULESET_REVISION_ID],
        platform: known(CONFIRMED_SWITCH_MOD_SETUP.platform),
        mods: known(CONFIRMED_SWITCH_MOD_SETUP.enabledMods),
        disabledMods: known(CONFIRMED_SWITCH_MOD_SETUP.disabledMods),
      }
      const profile = { ...original, rulesets: { ...original.rulesets, [ruleset.id]: ruleset } }
      const map = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === (fixture.classId ?? `base:class:${fixture.className.toLowerCase()}`))!
      expect(resolveDefinition(profile, catalogs, map.classRef)).toMatchObject({ kind: 'class', name: fixture.className })
      const offset = SKILL_SQUARE_STATES.indexOf(firstState)
      const expectedSquares: readonly SkillSquare[] = fixture.squares.map(([row, column], index) => ({ row, column, state: SKILL_SQUARE_STATES[(index + offset) % SKILL_SQUARE_STATES.length] }))
      const { image, square, highlight } = skillGridFixture()
      for (const { row, column, state } of expectedSquares) {
        if (state === 'unknown') square(row, column, SKILL_BORDER_COLORS.learned, SKILL_BORDER_COLORS.available)
        else square(row, column, SKILL_BORDER_COLORS[state])
      }
      highlight(0)
      const detected = detectSkillGrid(image)
      expect(detected).toEqual({ selectedRow: 0, squares: expectedSquares })
      const mapSet = skillMapSetForRuleset(profile.rulesets[ruleset.id])
      expect(mapSet).toBe(SWITCH_MOD_PACKS_MAP_SET)
      const suggestion = suggestSkillTreeMap(profile, catalogs, map.classRef, detected.squares, mapSet, ruleset.id)
      expect(suggestion.confirmedMap).toBe(map)
      expect(suggestion.mappings.map(mapping => [mapping.row, mapping.column, resolveDefinition(profile, catalogs, mapping.ref)?.name, mapping.kind])).toEqual(fixture.squares.filter(square => square[2] !== null))
      expect(suggestSkillTreeMap(profile, catalogs, map.classRef, detected.squares.slice(1), mapSet, ruleset.id).mappings).toEqual([])
      const imported = importSkillTrees(profile, catalogs, [{ characterId, classRef: map.classRef, rulesetRevisionId: ruleset.id, sourceDigest: 'e'.repeat(64), filename: 'synthetic-class.png', squares: detected.squares, mappings: suggestion.mappings, reviewed: true }], profile.revision, TEST_NOW)
      const nodes = Object.values(imported.characters[characterId].learnedNodes)
      expect(nodes.map(node => [resolveDefinition(imported, catalogs, node.ref)?.name, node.kind, node.learned.state === 'known' ? node.learned.value : null])).toEqual(
        fixture.squares.flatMap(([, , name, kind], index) => name !== null && expectedSquares[index].state !== 'unknown' ? [[name, kind, expectedSquares[index].state === 'learned']] : []),
      )
      expect(nodes.every(node => node.actualPaidLp.state === 'unknown')).toBe(true)
      expect(Object.values(imported.skillTreeCaptures!)).toEqual([expect.objectContaining({ classRef: map.classRef, rulesetRevisionId: ruleset.id, squares: expectedSquares, mappings: suggestion.mappings })])
      expect(Object.values(imported.skillTreeLayouts!)).toEqual([expect.objectContaining({ classRef: map.classRef, rulesetRevisionId: ruleset.id, mappings: suggestion.mappings })])
      expect(suggestSkillTreeMap(imported, catalogs, map.classRef, detected.squares, '', ruleset.id).mappings).toEqual(suggestion.mappings)
      expect(imported.characters[characterId].classProgress).toEqual({})
      expect(imported.characters[characterId].snapshots).toBe(profile.characters[characterId].snapshots)
      expect(imported.inventory).toBe(profile.inventory)
      expect(imported.progress).toBe(profile.progress)
      expect(imported.rulesets).toBe(profile.rulesets)
    })
  }

  it('rejects Warrior and Monk maps when the observed shape belongs to the other class', () => {
    const profile = createBlankProfile()
    const monk = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === 'base:class:monk')!
    const monkFixture = CLASS_MAP_FIXTURES.find(fixture => fixture.className === 'Monk')!
    const observed: readonly SkillSquare[] = monkFixture.squares.map(([row, column]) => ({ row, column, state: 'unknown' }))
    expect(suggestSkillTreeMap(profile, catalogs, warrior.classRef, observed, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    expect(suggestSkillTreeMap(profile, catalogs, monk.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
  })

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

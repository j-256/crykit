import { savedCatalogVersion } from '../domain/legacy-definition.test-helpers'
import { CLASS_MAP_FIXTURES, observedSkillMapCatalogFixture } from './skill-maps.test-helpers'
import { describe, expect, it } from 'vitest'
import { asId, requirePlaythrough } from '../domain/core'
import { createCharacter } from '../domain/characters'
import { createBlankLocalData, createPersonalDefinition } from '../domain/local-data'
import { resolveDefinition } from '../domain/definitions'
import { importSkillTrees, SKILL_SQUARE_STATES } from '../domain/skill-trees'
import { createTestLocalData, known, TEST_NOW, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import type { CharacterId, SkillSquare } from '../domain/types'
import { detectSkillGrid } from '../interchange/skill-grid'
import { SKILL_BORDER_COLORS, skillGridFixture } from '../interchange/skill-grid.test-helpers'
import { CONFIRMED_SWITCH_MOD_SETUP } from './mods'
import { CONFIRMED_SKILL_MAPS, CONFIRMED_SKILL_MAP_SETS, skillMapSetForGameSetup, suggestSkillTreeMap, SWITCH_MOD_PACKS_MAP_SET } from './skill-maps'
import { CURRENT_CATALOG } from './bundled'

const STARTER_CATALOG = observedSkillMapCatalogFixture(CURRENT_CATALOG)
const catalogs = [STARTER_CATALOG]
const warrior = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === 'base:job:0')!
const squares: readonly SkillSquare[] = warrior.mappings.map(mapping => ({ row: mapping.row, column: mapping.column, state: 'unknown' }))

describe('confirmed class square maps', () => {
  it('has an independent fixture for every confirmed class identity', () => {
    const fixtureClasses = CLASS_MAP_FIXTURES.map(fixture => fixture.classId!)
    expect(fixtureClasses.sort()).toEqual(CONFIRMED_SKILL_MAPS.map(map => map.classRef.entityId).sort())
  })

  for (const fixture of CLASS_MAP_FIXTURES) {
    it.each(SKILL_SQUARE_STATES)(`detects ${fixture.className} pixels and imports observed learning with a %s first square`, firstState => {
      const characterId = asId<CharacterId>('synthetic-mapped-character')
      const original = createCharacter(createTestLocalData(), { id: characterId, name: 'Rowan', now: TEST_NOW })
      const gameSetup = {
        ...original.gameSetups[TEST_GAME_SETUP_REVISION_ID],
        platform: known(CONFIRMED_SWITCH_MOD_SETUP.platform),
        mods: known(CONFIRMED_SWITCH_MOD_SETUP.enabledMods),
        disabledMods: known(CONFIRMED_SWITCH_MOD_SETUP.disabledMods),
      }
      const localData = { ...original, gameSetups: { ...original.gameSetups, [gameSetup.id]: gameSetup } }
      const map = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === (fixture.classId!))!
      expect(resolveDefinition(localData, catalogs, map.classRef)).toMatchObject({ kind: 'class', name: fixture.className })
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
      const mapSet = skillMapSetForGameSetup(localData.gameSetups[gameSetup.id])
      expect(mapSet).toBe(SWITCH_MOD_PACKS_MAP_SET)
      const suggestion = suggestSkillTreeMap(localData, catalogs, map.classRef, detected.squares, mapSet, gameSetup.id)
      expect(suggestion.confirmedMap).toBe(map)
      expect(suggestion.mappings.map(mapping => [mapping.row, mapping.column, resolveDefinition(localData, catalogs, mapping.ref)?.name, mapping.kind])).toEqual(fixture.squares.filter(square => square[2] !== null))
      expect(suggestSkillTreeMap(localData, catalogs, map.classRef, detected.squares.slice(1), mapSet, gameSetup.id).mappings).toEqual([])
      const imported = importSkillTrees(localData, catalogs, [{ characterId, classRef: map.classRef, gameSetupRevisionId: gameSetup.id, sourceDigest: 'e'.repeat(64), filename: 'synthetic-class.png', squares: detected.squares, mappings: suggestion.mappings, reviewed: true }], localData.revision, TEST_NOW)
      const importedPlaythrough = requirePlaythrough(imported)
      const localPlaythrough = requirePlaythrough(localData)
      const nodes = Object.values(importedPlaythrough.characters[characterId].learnedNodes)
      expect(nodes.map(node => [resolveDefinition(imported, catalogs, node.ref)?.name, node.kind, node.learned.state === 'known' ? node.learned.value : null])).toEqual(
        fixture.squares.flatMap(([, , name, kind], index) => name !== null && expectedSquares[index].state !== 'unknown' ? [[name, kind, expectedSquares[index].state === 'learned']] : []),
      )
      expect(nodes.every(node => node.actualPaidLp.state === 'unknown')).toBe(true)
      expect(Object.values(importedPlaythrough.skillTreeCaptures!)).toEqual([expect.objectContaining({ classRef: map.classRef, gameSetupRevisionId: gameSetup.id, squares: expectedSquares, mappings: suggestion.mappings })])
      expect(Object.values(imported.skillTreeLayouts!)).toEqual([expect.objectContaining({ classRef: map.classRef, gameSetupRevisionId: gameSetup.id, mappings: suggestion.mappings })])
      expect(suggestSkillTreeMap(imported, catalogs, map.classRef, detected.squares, '', gameSetup.id).mappings).toEqual(suggestion.mappings)
      expect(importedPlaythrough.characters[characterId].classProgress).toEqual({})
      expect(importedPlaythrough.characters[characterId].snapshots).toBe(localPlaythrough.characters[characterId].snapshots)
      expect(importedPlaythrough.inventory).toBe(localPlaythrough.inventory)
      expect(importedPlaythrough.progress).toBe(localPlaythrough.progress)
      expect(imported.gameSetups).toBe(localData.gameSetups)
    })
  }

  it('rejects Warrior and Monk maps when the observed shape belongs to the other class', () => {
    const localData = createBlankLocalData()
    const monk = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === 'base:job:5')!
    const monkFixture = CLASS_MAP_FIXTURES.find(fixture => fixture.className === 'Monk')!
    const observed: readonly SkillSquare[] = monkFixture.squares.map(([row, column]) => ({ row, column, state: 'unknown' }))
    expect(suggestSkillTreeMap(localData, catalogs, warrior.classRef, observed, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    expect(suggestSkillTreeMap(localData, catalogs, monk.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
  })

  it('keeps unconfirmed Scholar positions unresolved while preserving a later reviewed assignment', () => {
    const localData = createBlankLocalData()
    const map = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === 'base:job:13')!
    const observed: readonly SkillSquare[] = map.squares.map(square => ({ ...square, state: 'learned' }))
    const suggestion = suggestSkillTreeMap(localData, catalogs, map.classRef, observed, SWITCH_MOD_PACKS_MAP_SET)
    expect(suggestion.mappings.some(mapping => mapping.row === 3 && mapping.column === 0)).toBe(false)
    const reviewed = { row: 3, column: 0, kind: 'monsterMagic' as const, ref: { ...map.classRef, entityId: asId<typeof map.classRef.entityId>('base:ability:366') } }
    const extended = suggestSkillTreeMap(localData, catalogs, map.classRef, observed, SWITCH_MOD_PACKS_MAP_SET, undefined, [reviewed])
    expect(extended.confirmedMap).toBe(map)
    expect(extended.mappings).toContain(reviewed)
    expect(extended.mappings).toHaveLength(suggestion.mappings.length + 1)
  })

  it('requires the selected map set, exact catalog identity, full shape, and available definitions', () => {
    const localData = createBlankLocalData()
    expect(suggestSkillTreeMap(localData, catalogs, warrior.classRef, squares, '').mappings).toEqual([])
    expect(suggestSkillTreeMap(localData, catalogs, warrior.classRef, squares.slice(1), SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    expect(suggestSkillTreeMap(localData, [], warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    const anotherRevision = { ...warrior.classRef, catalogRevisionId: STARTER_CATALOG.revisionId + '-other' as typeof STARTER_CATALOG.revisionId }
    expect(suggestSkillTreeMap(localData, catalogs, anotherRevision, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    const personal = createPersonalDefinition(localData, { kind: 'class', name: 'Warrior' })
    const ref = { kind: 'personal' as const, definitionId: Object.values(personal.personalDefinitions)[0].id }
    expect(suggestSkillTreeMap(personal, catalogs, ref, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
    const missingAbility = { ...STARTER_CATALOG, entities: Object.fromEntries(Object.entries(STARTER_CATALOG.entities).filter(([id]) => id !== 'base:ability:28')) }
    expect(suggestSkillTreeMap(localData, [missingAbility], warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings).toEqual([])
  })

  it('preserves exact saved assignments, extends compatible partial maps, and honors personal overrides', () => {
    const localData = createBlankLocalData()
    const partial = [warrior.mappings[0]]
    const extended = suggestSkillTreeMap(localData, catalogs, warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET, undefined, partial)
    expect(extended.mappings).toHaveLength(warrior.mappings.length)
    expect(extended.mappings[0]).toBe(partial[0])
    const conflicting = [{ ...warrior.mappings[0], ref: warrior.mappings[2].ref }]
    expect(suggestSkillTreeMap(localData, catalogs, warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET, undefined, conflicting)).toEqual({ mappings: conflicting })
    const override = savedCatalogVersion(localData, catalogs, { sourceRef: warrior.mappings[0].ref, name: 'Personal Taunt label' })
    expect(suggestSkillTreeMap(override.localData, catalogs, warrior.classRef, squares, SWITCH_MOD_PACKS_MAP_SET).mappings[0].ref).toEqual(override.ref)
  })

  it('suggests a map set only from explicit matching platform and explicit enabled and disabled mods', () => {
    const gameSetup = createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]
    expect(skillMapSetForGameSetup()).toBe('')
    expect(skillMapSetForGameSetup(gameSetup)).toBe('')
    const enabled = CONFIRMED_SKILL_MAP_SETS[0].enabledMods
    const compatible = { ...gameSetup, platform: known('Nintendo Switch'), mods: known([...enabled].reverse().map(mod => mod.toLowerCase())), disabledMods: known(CONFIRMED_SKILL_MAP_SETS[0].disabledMods) }
    expect(skillMapSetForGameSetup(compatible)).toBe(SWITCH_MOD_PACKS_MAP_SET)
    expect(skillMapSetForGameSetup({ ...compatible, disabledMods: undefined })).toBe('')
    expect(skillMapSetForGameSetup({ ...compatible, disabledMods: known([]) })).toBe('')
    expect(skillMapSetForGameSetup({ ...compatible, platform: { state: 'unknown' } })).toBe('')
    expect(skillMapSetForGameSetup({ ...compatible, platform: known('PC') })).toBe('')
    expect(skillMapSetForGameSetup({ ...compatible, mods: known(['Mod Pack 1', 'Mod Pack 2']) })).toBe('')
    expect(skillMapSetForGameSetup({ ...compatible, mods: known(enabled.filter(mod => mod !== 'Learnable Innate Skill')) })).toBe('')
    expect(skillMapSetForGameSetup({ ...compatible, mods: known([...enabled, '1 PP Passives']) })).toBe('')
  })

  it('compiles synthetic square states into named character learning and reuses the saved map', () => {
    const characterId = asId<CharacterId>('synthetic-map-rowan')
    const localData = createCharacter(createTestLocalData(), { id: characterId, name: 'Rowan' })
    const observed = squares.map((square, index) => ({ ...square, state: index === 1 ? 'learned' as const : 'locked' as const }))
    const suggestion = suggestSkillTreeMap(localData, catalogs, warrior.classRef, observed, SWITCH_MOD_PACKS_MAP_SET)
    const imported = importSkillTrees(localData, catalogs, [{ characterId, classRef: warrior.classRef, sourceDigest: 'c'.repeat(64), filename: 'synthetic-warrior.png', squares: observed, mappings: suggestion.mappings, reviewed: true }], localData.revision)
    const learned = Object.values(requirePlaythrough(imported).characters[characterId].learnedNodes).filter(node => node.learned.state === 'known' && node.learned.value)
    expect(learned.map(node => [resolveDefinition(imported, catalogs, node.ref)?.name, node.kind])).toEqual([['Fighter', 'innate']])
    expect(requirePlaythrough(imported).characters[characterId].classProgress).toEqual({})
    expect(suggestSkillTreeMap(imported, catalogs, warrior.classRef, observed, '').mappings).toEqual(suggestion.mappings)
  })
})

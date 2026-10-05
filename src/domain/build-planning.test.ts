import { describe, expect, it } from 'vitest'
import { STARTER_CATALOG } from '../catalog'
import { createBuildPlan, ensureBuildPlanningGameSetup, SUGGESTED_BUILD_SLOTS } from './build-planning'
import { createBlankLocalData, updateGameSetupRevision } from './local-data'
import { createTestLocalData } from './test-helpers'
import { difficultyHitChance, resolveGameRules } from './game-rules'
import type { BuildRevisionContent, CatalogRef } from './types'

const catalogLock = { [STARTER_CATALOG.id]: STARTER_CATALOG.revisionId }
const item = Object.values(STARTER_CATALOG.entities).find((entity) => entity.name === 'Muramasa')!
const ref: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: item.id }
const content: BuildRevisionContent = { primaryClass: null, secondaryClass: null, equipment: { [SUGGESTED_BUILD_SLOTS[0]!.id]: { ref } }, passives: [], contextAssumptions: [] }

describe('build planning without observations', () => {
  it('creates a complete saved plan without inventory, characters, or verified rules', () => {
    const before = createBlankLocalData()
    const localData = createBuildPlan(before, { title: 'Synthetic plan', content, catalogLock })
    const build = Object.values(localData.builds)[0]!
    expect(localData.buildRevisions[build.latestRevisionId!]!.content).toEqual(content)
    const gameSetup = localData.gameSetups[localData.planningGameSetupRevisionId!]!
    expect(gameSetup.slots.every((slot) => slot.provenance === 'suggested')).toBe(true)
    expect(gameSetup.platform.state).toBe('unknown')
    expect(gameSetup.gameVersion).toEqual({ state: 'known', value: '1.6.6' })
    expect(gameSetup.difficulty).toEqual({ version: 1, selection: { state: 'known', value: 0 } })
    const rules = resolveGameRules(gameSetup, [])
    expect(rules.difficulty?.name).toBe('Normal')
    expect(difficultyHitChance(50, rules)).toBe(50)
    expect(gameSetup.mods.state).toBe('unknown')
    expect(gameSetup.ppLimit).toEqual({ state: 'known', value: 10 })
    expect(gameSetup.ppCostsNonNegative).toEqual({ state: 'known', value: true })
    expect(localData.playthroughs).toEqual({})
    expect(localData.personalDefinitions).toBe(before.personalDefinitions)
    expect(before.builds).toEqual({})
    expect(before.gameSetups).toEqual({})
  })

  it('preserves configured slots and gameSetup knowledge', () => {
    const localData = createTestLocalData()
    expect(ensureBuildPlanningGameSetup(localData, catalogLock)).toBe(localData)
  })

  it('adds a suggested layout to an empty gameSetup without changing its mod knowledge', () => {
    const original = createTestLocalData()
    const empty = updateGameSetupRevision(original, { sourceRevisionId: original.planningGameSetupRevisionId!, slots: [], difficulty: { version: 1, selection: { state: 'unknown', reason: 'Unrecorded difficulty' } }, mods: { state: 'known', value: ['Doge Shield'] }, activate: true })
    const localData = ensureBuildPlanningGameSetup(empty, catalogLock)
    const gameSetup = localData.gameSetups[localData.planningGameSetupRevisionId!]!
    expect(gameSetup.mods).toEqual({ state: 'known', value: ['Doge Shield'] })
    expect(gameSetup.difficulty).toEqual(empty.gameSetups[empty.planningGameSetupRevisionId!]!.difficulty)
    expect(gameSetup.platform).toEqual(original.gameSetups[original.planningGameSetupRevisionId!]!.platform)
    expect(localData.gameSetups[empty.planningGameSetupRevisionId!]!.slots).toEqual([])
    expect(gameSetup.slots.every((slot) => slot.provenance === 'suggested')).toBe(true)
  })

  it('leaves the original localData unchanged if the initial revision is invalid', () => {
    const localData = createBlankLocalData()
    const original = structuredClone(localData)
    expect(() => createBuildPlan(localData, { title: 'Synthetic plan', catalogLock, content: { ...content, equipment: { invalid: { ref } } } })).toThrow('unknown Game Setup slot')
    expect(localData).toEqual(original)
  })
})

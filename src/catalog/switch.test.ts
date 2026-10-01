import { describe, expect, it } from 'vitest'
import { asId, requirePlaythrough } from '../domain/core'
import { createCharacter } from '../domain/characters'
import { importSkillTrees } from '../domain/skill-trees'
import { skillAcceptsWeapon, skillWeaponRule } from '../domain/skill-weapons'
import { createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import type { CatalogRef, CharacterId, EntityId } from '../domain/types'
import { definitionModAvailability } from './mods'
import { starterEntitySourceLabel } from './provenance'
import { CONFIRMED_SKILL_MAPS } from './skill-maps'
import { STARTER_CATALOG } from './starter'
import {
  isPotentiallyLearnableInnate,
  LEARNABLE_INNATE_FIELD,
  SWITCH_CLASS_RECORDS,
  SWITCH_INNATE_PP_NOT_APPLICABLE,
  SWITCH_PASSIVE_PP_COSTS,
  SWITCH_PASSIVE_PP_SOURCE,
} from './switch'

function ref(id: string): CatalogRef {
  return { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: asId<EntityId>(id) }
}

describe('confirmed Switch skill identities', () => {
  it('preserves class-specific identities without borrowing mechanics from matching wiki names', () => {
    const meditate = STARTER_CATALOG.entities['mod:moonlight-project:brawler:ability:meditate']
    expect(meditate.name).toBe('Meditate')
    expect(meditate.fields.Class).toMatchObject({ state: 'known', value: 'Brawler' })
    expect(meditate.fields.Description.state).toBe('unknown')
    expect(meditate.fields['MP cost'].state).toBe('unknown')
    expect(meditate.id).not.toBe(STARTER_CATALOG.entities['base:monk:ability:meditate'].id)
    const swipes = Object.values(STARTER_CATALOG.entities).filter(entity => entity.kind === 'ability' && entity.name === 'Swipe')
    expect(swipes.map(entity => entity.id).sort()).toEqual(['mod:moonlight-project:ability:558', 'mod:tempest:ability:swipe'])
    for (const record of SWITCH_CLASS_RECORDS) {
      for (const [id, kind] of record.skills) {
        const entity = STARTER_CATALOG.entities[id]
        expect(entity.kind).toBe(kind)
        expect(starterEntitySourceLabel(entity)).toContain('Switch in-game confirmation')
        if (kind === 'ability') expect(skillAcceptsWeapon(skillWeaponRule(entity), 'Dagger', 'enabled').state).toBe('unknown')
      }
    }
  })

  it('applies versioned PP costs and preserves unavailable or unobserved innates', () => {
    for (const [id, cost] of SWITCH_PASSIVE_PP_COSTS) {
      const entity = STARTER_CATALOG.entities[id]
      expect(entity.ppCost).toMatchObject({ state: 'known', value: cost })
      if (entity.ppCost?.state === 'known') expect(entity.ppCost.sources).toContainEqual(expect.objectContaining({ sourceId: SWITCH_PASSIVE_PP_SOURCE.sourceId }))
      if (entity.kind === 'innate') {
        expect(entity.fields[LEARNABLE_INNATE_FIELD]).toMatchObject({ state: 'known', value: true })
        expect(isPotentiallyLearnableInnate(entity)).toBe(true)
      }
    }
    for (const [id, reason] of SWITCH_INNATE_PP_NOT_APPLICABLE) {
      const entity = STARTER_CATALOG.entities[id]
      expect(entity.ppCost).toEqual({ state: 'notApplicable', reason })
      expect(entity.fields[LEARNABLE_INNATE_FIELD]).toMatchObject({ state: 'known', value: false })
      expect(isPotentiallyLearnableInnate(entity)).toBe(false)
    }
    for (const id of ['base:weaver:innate:chrono-loop', 'base:mimic:innate:shapeshift']) {
      const entity = STARTER_CATALOG.entities[id]
      expect(entity.ppCost?.state).toBe('unknown')
      expect(entity.fields[LEARNABLE_INNATE_FIELD]).toBeUndefined()
      expect(isPotentiallyLearnableInnate(entity)).toBe(true)
    }
  })

  it('imports Preparation as a passive without marking Squall or Toughness learned', () => {
    const characterId = asId<CharacterId>('synthetic-switch-class-character')
    let localData = createCharacter(createTestLocalData(), { id: characterId, name: 'Rowan' })
    for (const className of ['barbarian', 'tempest']) {
      const map = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === `mod:${className}:class:${className}`)!
      localData = importSkillTrees(localData, [STARTER_CATALOG], [{ characterId, classRef: map.classRef, sourceDigest: className === 'barbarian' ? 'a'.repeat(64) : 'b'.repeat(64), filename: `synthetic-${className}.png`, squares: map.squares.map(square => ({ ...square, state: 'learned' })), mappings: map.mappings, reviewed: true }], localData.revision)
    }
    const learned = Object.values(requirePlaythrough(localData).characters[characterId].learnedNodes)
    expect(learned.some(node => node.kind === 'innate')).toBe(false)
    expect(learned.find(node => node.ref.kind === 'catalog' && node.ref.entityId === 'mod:tempest:passive:preparation')?.kind).toBe('passive')
    for (const id of ['mod:tempest:innate:squall', 'mod:barbarian:innate:toughness']) {
      expect(STARTER_CATALOG.entities[id].kind).toBe('innate')
      expect(STARTER_CATALOG.entities[id].fields['Learnable from this skill tree']).toMatchObject({ state: 'known', value: false })
      expect(learned.some(node => node.ref.kind === 'catalog' && node.ref.entityId === id)).toBe(false)
    }
    expect(STARTER_CATALOG.entities['mod:tempest:passive:preparation'].aliases).not.toContain('Squall')
  })

  it('follows confirmed class mods while keeping uncertain ownership visible', () => {
    const localData = createTestLocalData()
    const gameSetup = { ...localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], disabledMods: known(['Barbarian', 'Tempest', 'Moonlight Project']) }
    for (const record of SWITCH_CLASS_RECORDS) {
      for (const id of [record.id, ...record.skills.map(([id]) => id), ...(record.innate ? [record.innate.id] : [])]) {
        expect(definitionModAvailability(localData, ref(id), gameSetup)).toEqual(record.requiredMod ? { requiredMod: record.requiredMod, state: 'disabled' } : { requiredMod: 'Moonlight Project', state: 'disabled' })
      }
    }
    expect(STARTER_CATALOG.entities['mod:moonlight-project:class:25'].fields['Source mod'].state).toBe('unknown')
    expect(STARTER_CATALOG.entities['mod:moonlight-project:class:26'].fields['Source mod'].state).toBe('unknown')
    expect(Object.values(STARTER_CATALOG.entities).some(entity => entity.kind === 'class' && entity.name === 'Shapeshifter')).toBe(false)
  })
})

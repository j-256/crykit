import { describe, expect, it } from 'vitest'
import { asId } from '../domain/core'
import { createCharacter } from '../domain/characters'
import { createBlankProfile } from '../domain/profile'
import { importSkillTrees } from '../domain/skill-trees'
import { skillAcceptsWeapon, skillWeaponRule } from '../domain/skill-weapons'
import { createTestProfile, known, TEST_RULESET_REVISION_ID } from '../domain/test-helpers'
import type { CatalogRef, CharacterId, EntityId } from '../domain/types'
import { definitionModAvailability } from './mods'
import { starterEntitySourceLabel } from './provenance'
import { CONFIRMED_SKILL_MAPS } from './skill-maps'
import { STARTER_CATALOG } from './starter'
import { SWITCH_CLASS_RECORDS } from './switch'

function ref(id: string): CatalogRef {
  return { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: asId<EntityId>(id) }
}

describe('confirmed Switch skill identities', () => {
  it('preserves class-specific identities without borrowing mechanics from matching wiki names', () => {
    const meditate = STARTER_CATALOG.entities['switch:brawler:ability:meditate']
    expect(meditate.name).toBe('Meditate')
    expect(meditate.fields.Class).toMatchObject({ state: 'known', value: 'Brawler' })
    expect(meditate.fields.Description.state).toBe('unknown')
    expect(meditate.fields['MP cost'].state).toBe('unknown')
    expect(meditate.id).not.toBe(STARTER_CATALOG.entities['base:monk:ability:meditate'].id)
    const swipes = Object.values(STARTER_CATALOG.entities).filter(entity => entity.kind === 'ability' && entity.name === 'Swipe')
    expect(swipes.map(entity => entity.id).sort()).toEqual(['mod-pack-2:tempest:ability:swipe', 'switch:freelancer:ability:swipe'])
    for (const record of SWITCH_CLASS_RECORDS) {
      for (const [id, kind] of record.skills) {
        const entity = STARTER_CATALOG.entities[id]
        expect(entity.kind).toBe(kind)
        expect(starterEntitySourceLabel(entity)).toBe('Switch in-game confirmation')
        if (kind === 'passive') expect(entity.ppCost?.state).toBe('unknown')
        else expect(skillAcceptsWeapon(skillWeaponRule(entity), 'Dagger', 'enabled').state).toBe('unknown')
      }
    }
  })

  it('imports Preparation as a passive without marking Squall or Toughness learned', () => {
    const characterId = asId<CharacterId>('synthetic-switch-class-character')
    let profile = createCharacter(createBlankProfile(), { id: characterId, name: 'Rowan' })
    for (const className of ['barbarian', 'tempest']) {
      const map = CONFIRMED_SKILL_MAPS.find(map => map.classRef.entityId === `mod-pack-2:class:${className}`)!
      profile = importSkillTrees(profile, [STARTER_CATALOG], [{ characterId, classRef: map.classRef, sourceDigest: className === 'barbarian' ? 'a'.repeat(64) : 'b'.repeat(64), filename: `synthetic-${className}.png`, squares: map.squares.map(square => ({ ...square, state: 'learned' })), mappings: map.mappings, reviewed: true }], profile.revision)
    }
    const learned = Object.values(profile.characters[characterId].learnedNodes)
    expect(learned.some(node => node.kind === 'innate')).toBe(false)
    expect(learned.find(node => node.ref.kind === 'catalog' && node.ref.entityId === 'mod-pack-2:tempest:passive:preparation')?.kind).toBe('passive')
    for (const id of ['mod-pack-2:tempest:innate:squall', 'mod-pack-2:barbarian:innate:toughness']) {
      expect(STARTER_CATALOG.entities[id].kind).toBe('innate')
      expect(STARTER_CATALOG.entities[id].fields['Learnable from this skill tree']).toMatchObject({ state: 'known', value: false })
      expect(learned.some(node => node.ref.kind === 'catalog' && node.ref.entityId === id)).toBe(false)
    }
    expect(STARTER_CATALOG.entities['mod-pack-2:tempest:passive:preparation'].aliases).not.toContain('Squall')
  })

  it('follows confirmed class mods while keeping uncertain ownership visible', () => {
    const profile = createTestProfile()
    const ruleset = { ...profile.rulesets[TEST_RULESET_REVISION_ID], disabledMods: known(['Barbarian', 'Tempest', 'Moonlight Project Custom Bosses']) }
    for (const record of SWITCH_CLASS_RECORDS) {
      for (const id of [record.id, ...record.skills.map(([id]) => id), ...(record.innate ? [record.innate.id] : [])]) {
        expect(definitionModAvailability(profile, ref(id), ruleset)).toEqual(record.requiredMod ? { requiredMod: record.requiredMod, state: 'disabled' } : { state: 'unknown' })
      }
    }
    expect(STARTER_CATALOG.entities['switch:class:brawler'].fields['Source mod'].state).toBe('unknown')
    expect(STARTER_CATALOG.entities['switch:class:freelancer'].fields['Source mod'].state).toBe('unknown')
    expect(Object.values(STARTER_CATALOG.entities).some(entity => entity.kind === 'class' && entity.name === 'Shapeshifter')).toBe(false)
  })
})

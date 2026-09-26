import { describe, expect, it } from 'vitest'
import { asId } from '../domain/core'
import { createDefinitionOverride, createPersonalDefinition } from '../domain/profile'
import { createTestProfile, known, TEST_RULESET_REVISION_ID } from '../domain/test-helpers'
import type { CatalogRef, EntityId } from '../domain/types'
import { buildDefinitionOptions } from '../ui/definitions'
import { definitionModAvailability } from './mods'
import { STARTER_CATALOG, STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './starter'

function ref(entityId: string): CatalogRef {
  return { kind: 'catalog', catalogId: STARTER_CATALOG_ID, catalogRevisionId: STARTER_CATALOG_REVISION_ID, entityId: asId<EntityId>(entityId) }
}

describe('confirmed catalog mod associations', () => {
  it('uses exact source-backed identities for mod classes, items, and bosses', () => {
    const profile = createTestProfile()
    const cases = [
      ['mod-pack-2:class:bloodmage', 'Bloodmage'],
      ['mod-pack-2:class:tempest', 'Tempest'],
      ['mod-pack-2:class:forcemage', 'Forcemage'],
      ['mod-pack-2:class:barbarian', 'Barbarian'],
      ['mod-pack-2:item:doge-shield', 'Doge Shield'],
      ['equipment-expansion:item:heavy-edge', 'Equipment Expansion'],
      ['mod-pack-2:monster:yasha-tar', 'Additional Boss: Yasha Tar'],
      ['mod-pack-2:monster:pinga', 'Additional Boss: Pinga'],
      ['mod-pack-2:monster:quintar-husk', 'Additional Boss: Quintar Husk'],
      ['mod-pack-2:monster:elder-entities', 'Additional Boss: Elder Entities'],
    ] as const
    for (const [id, mod] of cases) {
      expect(STARTER_CATALOG.entities[id]).toBeDefined()
      expect(definitionModAvailability(profile, ref(id))).toEqual({ requiredMod: mod, state: 'unknown' })
      expect(definitionModAvailability(profile, ref(id), { ...profile.rulesets[TEST_RULESET_REVISION_ID], disabledMods: known([mod]) })).toEqual({ requiredMod: mod, state: 'disabled' })
      expect(definitionModAvailability(profile, ref(id), { ...profile.rulesets[TEST_RULESET_REVISION_ID], mods: known([mod]) })).toEqual({ requiredMod: mod, state: 'enabled' })
    }
    expect(definitionModAvailability(profile, ref('base:warrior:innate:fighter'))).toEqual({ state: 'unknown' })
  })

  it('inherits source associations through overrides without classifying unrelated same-name definitions', () => {
    const base = ref('mod-pack-2:item:doge-shield')
    const first = createDefinitionOverride(createTestProfile(), [STARTER_CATALOG], { sourceRef: base, name: 'Personal shield' })
    const second = createDefinitionOverride(first.profile, [STARTER_CATALOG], { sourceRef: first.ref, name: 'Revised shield' })
    const ruleset = { ...second.profile.rulesets[TEST_RULESET_REVISION_ID], disabledMods: known(['Doge Shield']) }
    expect(definitionModAvailability(second.profile, second.ref, ruleset).state).toBe('disabled')
    const personal = createPersonalDefinition(second.profile, { kind: 'item', name: 'Doge Shield' })
    const independent = Object.values(personal.personalDefinitions).find(definition => !definition.baseRef)!
    expect(definitionModAvailability(personal, { kind: 'personal', definitionId: independent.id }, ruleset)).toEqual({ state: 'unknown' })
    expect(definitionModAvailability(personal, { ...base, catalogRevisionId: asId('another-revision') }, ruleset)).toEqual({ state: 'unknown' })
    expect(definitionModAvailability(personal, { ...base, catalogId: asId('unrelated-catalog') }, ruleset)).toEqual({ state: 'unknown' })
  })

  it('retains all exact definitions while attaching the active ruleset availability to search choices', () => {
    const original = createTestProfile()
    const profile = { ...original, rulesets: { ...original.rulesets, [TEST_RULESET_REVISION_ID]: { ...original.rulesets[TEST_RULESET_REVISION_ID], mods: known(['Bloodmage']), disabledMods: known(['Doge Shield']) } } }
    const options = buildDefinitionOptions(profile, [STARTER_CATALOG])
    expect(options.find(option => option.name === 'Doge Shield')?.modAvailability?.state).toBe('disabled')
    expect(options.find(option => option.name === 'Bloodmage')?.modAvailability?.state).toBe('enabled')
    expect(options.find(option => option.name === 'Heavy Edge')?.modAvailability?.state).toBe('unknown')
    expect(options).toHaveLength(Object.keys(STARTER_CATALOG.entities).length)
  })
})

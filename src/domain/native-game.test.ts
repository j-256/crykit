import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { equipmentFacts, definitionPermissionEffects } from './mechanics-facts'
import { buildNativeCatalog, nativeEntityId, nativeIdentity, nativeRecord, nativeRelationships, nativeSourceRecord, validateNativeSnapshot } from './native-game'
import { skillWeaponRule } from './skill-weapons'
import { composeModCatalog, expandModCatalogs } from './mod-layers'
import { createTestLocalData } from './test-helpers'

describe('native gameplay definitions', () => {
  it('retains numeric identity links and enum labels in an effective mod catalog', () => {
    const setup = Object.values(createTestLocalData().gameSetups)[0]!
    const modComposition = { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [], links: [] }
    const effective = composeModCatalog({ ...setup, modComposition }, [DEFAULT_CATALOG])!
    const expanded = expandModCatalogs([DEFAULT_CATALOG, effective])[1]!
    const slime = expanded.entities[nativeEntityId('monster', 2)]!
    expect(nativeRelationships(expanded, slime)).toEqual(nativeRelationships(DEFAULT_CATALOG, slime))
    expect(nativeRecord(expanded.legacy) && expanded.legacy.nativeEnums).toEqual(nativeRecord(DEFAULT_CATALOG.legacy) && DEFAULT_CATALOG.legacy.nativeEnums)
  })
  it('preserves zero, false, null, loot probabilities, and detailed actions', () => {
    const slime = DEFAULT_CATALOG.entities[nativeEntityId('monster', 2)]!
    const record = nativeSourceRecord(slime)!
    expect(record).toMatchObject({ ID: 2, HP: 50, MP: 40, PAccRating: 0, IsBoss: false, ItemDrops: [{ ItemID: 18, LootChance: 50 }], ItemSteals: [{ ItemID: 18, LootChance: 75, StealChance: 60 }] })
    expect(slime.fields['Physical accuracy rating input']).toBeUndefined()
    expect(slime.fields['Raw combat inputs']).toMatchObject({ state: 'known', value: { 'Physical accuracy rating input': 0 } })
    expect(slime.fields['Ability costs']).toBeUndefined()
    expect(slime.fields['JP reward']).toMatchObject({ state: 'known', value: 8 })
    expect(nativeRelationships(DEFAULT_CATALOG, slime)).toEqual(expect.arrayContaining([expect.objectContaining({ label: '/ItemSteals/0/ItemID', name: 'Tonic' }), expect.objectContaining({ label: '/Actions/0/AbilityID', targetId: expect.any(String) })]))
    const boss = nativeSourceRecord(DEFAULT_CATALOG.entities[nativeEntityId('monster', 201)]!)!
    expect((boss.Actions as unknown[]).length).toBeGreaterThan(1)
  })

  it('keeps repeated names and mode overrides as separate ordinary identities', () => {
    const catalog = buildNativeCatalog(NATIVE_GAME_DATA)
    expect(catalog.entities[nativeEntityId('monster', 40)]!.name).toBe(catalog.entities[nativeEntityId('monster', 207)]!.name)
    const patched = Object.values(catalog.entities).find(entity => nativeIdentity(entity)?.mode === 'Chaos' && nativeIdentity(entity)?.database === 'monster')!
    expect(patched).toBeDefined()
    expect(nativeRelationships(catalog, patched).every(link => !link.targetId || catalog.entities[link.targetId])).toBe(true)
    expect(Object.values(catalog.entities).every(entity => !(nativeRecord(entity.legacy) && entity.legacy.referenceOnly === true))).toBe(true)
  })

  it('uses verified identities and native mechanical inputs as the default', () => {
    const sword = DEFAULT_CATALOG.entities['base:item:short-sword']!
    expect(nativeIdentity(sword)?.database).toBe('equipment')
    expect(sword.sources[0]!.sourceId).toBe('native-game:windows:1.6.9')
    const goldBow = DEFAULT_CATALOG.entities['base:item:gold-bow']!
    expect(goldBow.rawDescription).toContain('Silver Bow')
    expect(goldBow.legacy).toMatchObject({ nativeDescriptionSupplemental: true })
    expect(equipmentFacts(sword)).toMatchObject({ type: 'Sword', twoHanded: false })
    const equipSword = DEFAULT_CATALOG.entities[nativeEntityId('passive', 6)]!
    expect(definitionPermissionEffects(equipSword)).toEqual({ equipment: ['Sword'], dualWield: false, twoHanded: false, complete: true })
    expect(skillWeaponRule(Object.values(DEFAULT_CATALOG.entities).find(entity => entity.name === 'Cure' && nativeIdentity(entity)?.mode === 'base')!)).toMatchObject({ state: 'known', value: { kind: 'nonWeaponAction' } })
  })

  it('rejects inconsistent versions, missing databases, duplicate IDs, and unsafe objects', () => {
    const version = { ...NATIVE_GAME_DATA, source: { ...NATIVE_GAME_DATA.source, executable: { ...NATIVE_GAME_DATA.source.executable, productVersion: '1.6.6.0' } } }
    expect(() => validateNativeSnapshot(version)).toThrow(/version evidence/)
    const databases = { ...NATIVE_GAME_DATA.databases }
    delete databases.monster
    const missing = { ...NATIVE_GAME_DATA, databases }
    expect(() => validateNativeSnapshot(missing)).toThrow(/missing monster/)
    const duplicate = structuredClone(NATIVE_GAME_DATA)
    const monsters = duplicate.databases.monster as unknown[]
    monsters.push(monsters[2])
    expect(() => validateNativeSnapshot(duplicate)).toThrow(/duplicate native ID/)
    const unsafe = structuredClone(NATIVE_GAME_DATA)
    const system = unsafe.databases.system as Record<string, unknown>
    system.prototype = 'unsupported'
    expect(() => validateNativeSnapshot(unsafe)).toThrow(/unsupported object key/)
  })
})

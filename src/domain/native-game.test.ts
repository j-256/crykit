import { baseGameEntityId } from './entity-identities'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { equipmentFacts, definitionPermissionEffects } from './mechanics-facts'
import { buildNativeCatalog, nativeDefinitionLabel, nativeDisplayDescription, nativeEntityId, nativeGameplayScopeLabel, nativeIdentity, nativeRecord, nativeRelationships, nativeScopeUncertainty, nativeSourceRecord, validateNativeSnapshot } from './native-game'
import { skillWeaponRule } from './skill-weapons'
import { composeModCatalog, expandModCatalogs } from './mod-layers'
import { createTestLocalData } from './test-helpers'

describe('native gameplay definitions', () => {
  it('labels only the reviewed Windows/macOS version as the shared PC gameplay baseline', () => {
    for (const platform of ['Windows', 'macOS']) for (const version of ['1.6.9', '1.6.9.0']) expect(nativeGameplayScopeLabel(platform, version)).toBe('PC 1.6.9.0')
    for (const [platform, version, expected] of [
      ['Windows', '1.6.6', 'Windows 1.6.6'],
      ['Windows', '1.6.9.1', 'Windows 1.6.9.1'],
      ['macOS', '1.7.0', 'macOS 1.7.0'],
      ['Linux', '1.6.9', 'Linux 1.6.9'],
      ['Nintendo Switch', '1.6.9', 'Nintendo Switch 1.6.9'],
      [undefined, '1.6.9', 'Platform unresolved 1.6.9'],
      ['Windows', undefined, 'Windows (version unresolved)'],
    ]) expect(nativeGameplayScopeLabel(platform, version)).toBe(expected)
  })

  it('projects PC gameplay labels while retaining original source identity and generated text', () => {
    const catalog = buildNativeCatalog(NATIVE_GAME_DATA)
    const slime = catalog.entities[nativeEntityId('monster', 2)]!
    const patched = Object.values(catalog.entities).find(entity => nativeIdentity(entity)?.mode === 'Chaos' && nativeIdentity(entity)?.database === 'monster')!
    const before = JSON.stringify([slime, patched])
    expect(nativeDefinitionLabel(slime)).toBe('PC 1.6.9.0 · base database')
    expect(nativeDisplayDescription(slime)).toMatch(/^PC 1\.6\.9\.0 base database; level /)
    expect(nativeDefinitionLabel(patched)).toBe('PC 1.6.9.0 · Chaos mode')
    expect(nativeDisplayDescription(patched)).toMatch(/^PC 1\.6\.9\.0 Chaos mode; level /)
    expect(slime.rawDescription).toMatch(/^Windows 1\.6\.9 base database/)
    expect(slime.fields['Game platform']).toMatchObject({ state: 'known', value: 'Windows' })
    expect(slime.fields['Game version']).toMatchObject({ state: 'known', value: '1.6.9' })
    expect(slime.sources[0]).toMatchObject({ sourceId: 'native-game:windows:1.6.9', snapshot: expect.stringContaining('Windows 1.6.9') })
    expect(JSON.stringify([slime, patched])).toBe(before)
    expect(nativeDisplayDescription({ ...slime, rawDescription: 'Windows 1.6.9 custom imported claim' })).toBe('Windows 1.6.9 custom imported claim')
    expect(nativeDefinitionLabel({ ...slime, fields: { ...slime.fields, 'Game platform': { state: 'unknown' } } })).toBe('Platform unresolved 1.6.9 · base database')
  })

  it('keeps pinned applicability checks separate from verified gameplay equivalence', () => {
    const catalog = { legacy: { nativeSource: { platform: 'Windows', gameVersion: '1.6.9' } } }
    const setup = { platform: { state: 'known' as const, value: 'Windows' }, gameVersion: { state: 'known' as const, value: '1.6.9' } }
    expect(nativeScopeUncertainty(catalog, setup)).toBeUndefined()
    expect(nativeScopeUncertainty(catalog, { ...setup, platform: { state: 'unknown' } })).toBeUndefined()
    expect(nativeScopeUncertainty(catalog, { ...setup, platform: { state: 'known', value: 'macOS' } })).toBe('Game Setup applicability has not been recorded for macOS 1.6.9. Reference facts retain the pinned PC 1.6.9.0 source scope.')
    expect(nativeScopeUncertainty(catalog, { ...setup, gameVersion: { state: 'known', value: '1.6.6' } })).toContain('Windows 1.6.6')
    expect(nativeScopeUncertainty({ legacy: { nativeSource: { platform: 'Linux', gameVersion: '1.6.9' } } }, setup)).toContain('pinned Linux 1.6.9 source scope')
    expect(nativeScopeUncertainty({ legacy: { nativeSource: { platform: 'Windows' } } }, setup)).toBeUndefined()
  })

  it('retains numeric identity links and enum labels in an effective mod catalog', () => {
    const setup = Object.values(createTestLocalData().gameSetups)[0]!
    const modComposition = { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [], links: [] }
    const effective = composeModCatalog({ ...setup, modComposition }, [DEFAULT_CATALOG])!
    const expanded = expandModCatalogs([DEFAULT_CATALOG, effective])[1]!
    const slime = expanded.entities[baseGameEntityId('monster', 2)]!
    expect(nativeRelationships(expanded, slime)).toEqual(nativeRelationships(DEFAULT_CATALOG, slime))
    expect(nativeRecord(expanded.legacy) && expanded.legacy.nativeEnums).toEqual(nativeRecord(DEFAULT_CATALOG.legacy) && DEFAULT_CATALOG.legacy.nativeEnums)
  })
  it('preserves zero, false, null, loot probabilities, and detailed actions', () => {
    const slime = DEFAULT_CATALOG.entities[baseGameEntityId('monster', 2)]!
    const record = nativeSourceRecord(slime)!
    expect(record).toMatchObject({ ID: 2, HP: 50, MP: 40, PAccRating: 0, IsBoss: false, ItemDrops: [{ ItemID: 18, LootChance: 50 }], ItemSteals: [{ ItemID: 18, LootChance: 75, StealChance: 60 }] })
    expect(slime.fields['Physical accuracy rating input']).toBeUndefined()
    expect(slime.fields['Raw combat inputs']).toMatchObject({ state: 'known', value: { 'Physical accuracy rating input': 0 } })
    expect(slime.fields['Ability costs']).toBeUndefined()
    expect(slime.fields['JP reward']).toMatchObject({ state: 'known', value: 8 })
    expect(nativeRelationships(DEFAULT_CATALOG, slime)).toEqual(expect.arrayContaining([expect.objectContaining({ label: '/ItemSteals/0/ItemID', name: 'Tonic' }), expect.objectContaining({ label: '/Actions/0/AbilityID', targetId: expect.any(String) })]))
    const boss = nativeSourceRecord(DEFAULT_CATALOG.entities[baseGameEntityId('monster', 201)]!)!
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
    const sword = DEFAULT_CATALOG.entities['base:equipment:0']!
    expect(nativeIdentity(sword)?.database).toBe('equipment')
    expect(sword.sources[0]!.sourceId).toBe('native-game:windows:1.6.9')
    const goldBow = DEFAULT_CATALOG.entities['base:equipment:149']!
    expect(goldBow.rawDescription).toContain('Silver Bow')
    expect(goldBow.legacy).toMatchObject({ nativeDescriptionSupplemental: true })
    expect(equipmentFacts(sword)).toMatchObject({ type: 'Sword', twoHanded: false })
    const equipSword = DEFAULT_CATALOG.entities['base:passive:6']!
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

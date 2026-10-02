import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import rules from '../calculations/enemy-difficulty-v1.json' with { type: 'json' }
import { previewEnemyDifficulty, referenceEnemyDifficulties, referenceEnemyModes, resolveReferenceEnemyMode } from './enemy-difficulty'
import { nativeRelationships } from './native-game'
import type { CatalogEntity, EntityId, JsonValue, Knowledge } from './types'

const enemy = DEFAULT_CATALOG.entities['base:monster:316']!
const known = (value: JsonValue): Knowledge<JsonValue> => ({ state: 'known', value })
const withFields = (fields: CatalogEntity['fields']): CatalogEntity => ({ ...enemy, fields: { ...enemy.fields, ...fields } })
const difficulties = referenceEnemyDifficulties(enemy)
const normal = difficulties.find(entry => entry.isDefault)!
const easy = difficulties.find(entry => entry.name === 'Easy')!
const hard = difficulties.find(entry => entry.name === 'Hard')!

describe('source-backed enemy difficulty previews', () => {
  it('pins arithmetic evidence to the bundled executable and resolves the native order and default', () => {
    expect(rules.source.executableSha256).toBe(NATIVE_GAME_DATA.source.executable.sha256)
    expect(rules.source.gameVersion).toBe(NATIVE_GAME_DATA.source.gameVersion)
    expect(difficulties.map(entry => entry.name)).toEqual(['Easy', 'Normal', 'Hard'])
    expect(normal.name).toBe('Normal')
  })

  it('scales the desert quintar while preserving rewards, original records, and unrelated combat inputs', () => {
    const original = JSON.stringify(enemy)
    const preview = previewEnemyDifficulty(enemy, hard)
    expect(preview.hp).toEqual(known(6370))
    expect(preview.mp).toEqual(known(130))
    expect(preview.attributes).toEqual(known({ Str: 140, Vit: 210, Dex: 170, Agi: 170, Mnd: 216, Spi: 220, Spd: 300, Lck: 130 }))
    expect(preview.combatInputs).toEqual(known({ 'Physical attack input': 336, 'Physical penetration input': 0, 'Physical defense input': 407, 'Physical critical chance input': 0, 'Physical critical damage input': 0, 'Physical accuracy rating input': 0, 'Physical evasion rating input': 0, 'Magical penetration input': 0, 'Magical defense input': 253, 'Physical variance input': 0 }))
    expect(previewEnemyDifficulty(enemy, easy).hp).toEqual(known(3920))
    expect(JSON.stringify(enemy)).toBe(original)
    expect(enemy.fields['Money (copper)']).toMatchObject(known(10000))
  })

  it('uses boss and Chaos rates separately, including boss MP', () => {
    const boss = withFields({ Boss: known(true), HP: known(27000), MP: known(125) })
    expect(previewEnemyDifficulty(boss, hard).hp).toEqual(known(35100))
    const chaos: CatalogEntity = { ...boss, legacy: { native: { database: 'monster', databaseId: 316, mode: 'Chaos' } } }
    const chaosHard = referenceEnemyDifficulties(chaos).find(entry => entry.name === 'Hard')!
    expect(previewEnemyDifficulty(chaos, chaosHard).hp).toEqual(known(54000))
    expect(previewEnemyDifficulty(chaos, chaosHard).mp).toEqual(known(160))
    expect(previewEnemyDifficulty(enemy, chaosHard).hp).toEqual(known(7350))
    expect(previewEnemyDifficulty(enemy, chaosHard).mp).toEqual(known(130))
  })

  it('selects exact native mode records and their rates, rewards, and action data', () => {
    expect(referenceEnemyModes(DEFAULT_CATALOG, enemy).map(mode => [mode.name, mode.entityId])).toEqual([
      ['Standard', 'base:monster:316'], ['Vanilla', 'base:monster:316:mode:Vanilla'], ['Chaos', 'base:monster:316:mode:Chaos'],
    ])
    const selection = resolveReferenceEnemyMode(DEFAULT_CATALOG, enemy, 'chaos')!
    const chaos = DEFAULT_CATALOG.entities[selection.entityId!]!
    const difficulty = referenceEnemyDifficulties(chaos, selection.value).find(entry => entry.name === 'Hard')!
    expect(previewEnemyDifficulty(chaos, difficulty).hp).toEqual(known(8250))
    expect(chaos.fields.Experience).toMatchObject(known(1960))
    expect(chaos.fields['Money (copper)']).toMatchObject(known(15000))
    expect(resolveReferenceEnemyMode(DEFAULT_CATALOG, chaos)?.value).toBe('chaos')
    expect(resolveReferenceEnemyMode(DEFAULT_CATALOG, chaos, 'standard')?.entityId).toBe(enemy.id)
  })

  it('inherits a base record only when the selected game patch leaves that native ID unchanged', () => {
    const unchanged = DEFAULT_CATALOG.entities['base:monster:0']!
    expect(resolveReferenceEnemyMode(DEFAULT_CATALOG, unchanged, 'chaos')?.entityId).toBe(unchanged.id)
    expect(referenceEnemyDifficulties(unchanged, 'chaos').find(entry => entry.name === 'Hard')?.values.MonsterHPRate).toBe(150)
    const catalog = { ...DEFAULT_CATALOG, entities: Object.fromEntries(Object.entries(DEFAULT_CATALOG.entities).filter(([id]) => id !== 'base:monster:316:mode:Chaos')) }
    expect(resolveReferenceEnemyMode(catalog, enemy, 'chaos')?.entityId).toBeUndefined()
    expect(resolveReferenceEnemyMode(catalog, enemy, 'standard')?.entityId).toBe(enemy.id)
  })

  it('honors catalog identity bindings and rejects mismatched mode records and unknown selections', () => {
    const id = 'synthetic:chaos:316' as EntityId
    const chaos = { ...DEFAULT_CATALOG.entities['base:monster:316:mode:Chaos']!, id }
    const catalog = { ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [id]: chaos }, legacy: { nativeModeIdentityBindings: { 'Chaos:monster:316': id } } }
    expect(resolveReferenceEnemyMode(catalog, enemy, 'chaos')?.entityId).toBe(id)
    expect(resolveReferenceEnemyMode({ ...catalog, entities: { ...catalog.entities, [id]: { ...chaos, fields: { ...chaos.fields, 'Game platform': known('Switch') } } } }, enemy, 'chaos')?.entityId).toBeUndefined()
    for (const mode of ['Unknown', '__proto__', 'toString']) expect(resolveReferenceEnemyMode(DEFAULT_CATALOG, enemy, mode)).toBeUndefined()
    expect(referenceEnemyModes(DEFAULT_CATALOG, withFields({ 'Game version': known('9.9.9') }))).toEqual([])
  })

  it('resolves mode-specific action links for an inherited base record without changing its identity', () => {
    const source = withFields({ 'Native source record': known({ Actions: [{ AbilityID: 900 }] }) })
    const ability = { ...enemy, id: 'base:ability:900:mode:Chaos' as EntityId, name: 'Synthetic Chaos action', kind: 'ability' as const, legacy: { native: { database: 'ability', databaseId: 900, mode: 'Chaos' } } }
    const catalog = { ...DEFAULT_CATALOG, entities: { [source.id]: source, [ability.id]: ability } }
    expect(nativeRelationships(catalog, source, 'Chaos')[0]?.targetId).toBe(ability.id)
    expect(source.legacy).toBe(enemy.legacy)
    expect(nativeRelationships(catalog, source)[0]?.targetId).toBeUndefined()
  })

  it('truncates before rounding changed vitals and preserves unmodified Normal values and zero', () => {
    for (const [hp, expected] of [[16, 10], [99, 80], [101, 80], [124, 100], [126, 100], [0, 0]]) {
      const record = withFields({ HP: known(hp!) })
      expect(previewEnemyDifficulty(record, easy).hp).toEqual(known(expected!))
      expect(previewEnemyDifficulty(record, normal).hp).toEqual(known(hp!))
    }
    const fractionalProduct = withFields({ 'Raw attributes': known({ Str: 139 }) })
    expect(previewEnemyDifficulty(fractionalProduct, easy).attributes).toEqual(known({ Str: 125 }))
  })

  it('uses corrected inputs and preserves missing, conflicting, invalid, and overflowing values as unresolved', () => {
    expect(previewEnemyDifficulty(withFields({ HP: known(55) }), hard).hp).toEqual(known(70))
    for (const value of [{ state: 'unknown' } as const, { state: 'conflicting', claims: [{ value: 50, sources: [] }, { value: 100, sources: [] }] } as const, known(-1), known(1.5), known(2147483647)]) {
      expect(previewEnemyDifficulty(withFields({ HP: value }), hard).hp.state).toBe('unknown')
    }
    expect(previewEnemyDifficulty(withFields({ Boss: { state: 'unknown' } }), hard).hp.state).toBe('unknown')
    expect(previewEnemyDifficulty(enemy, { ...hard, values: {} }).combatInputs.state).toBe('unknown')
  })

  it('does not infer difficulty definitions for other versions, platforms, families, or unrecognized modes', () => {
    expect(referenceEnemyDifficulties(undefined)).toEqual([])
    expect(referenceEnemyDifficulties(withFields({ 'Game version': known('9.9.9') }))).toEqual([])
    expect(referenceEnemyDifficulties(withFields({ 'Game platform': known('Switch') }))).toEqual([])
    for (const mode of ['Unknown', '__proto__', 'toString']) expect(referenceEnemyDifficulties({ ...enemy, legacy: { native: { database: 'monster', databaseId: 316, mode } } })).toEqual([])
    expect(referenceEnemyDifficulties(DEFAULT_CATALOG.entities['base:item:ether'])).toEqual([])
  })
})

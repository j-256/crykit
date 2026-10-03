import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { projectWorldAcquisition } from './lib/world-acquisition.mjs'
import { validateAcquisitionSource } from './update-world-acquisition.mjs'
import { contentDigest } from './update-entity-reference.mjs'

const always = { ConditionType: 'Always', IsNegation: false, Data: null }
const action = (ActionType, Data) => ({ ActionType, Data })
const npc = pages => ({ ID: 4, EntityType: 'Npc', BiomeID: 2, Coord: { X: 0, Y: -1, Z: 3 }, NpcData: { Outfits: [{ Name: 'Synthetic trader', Condition: always }], Pages: pages } })
const page = (Actions, Condition = always) => ({ TriggerType: 'PlayerAction', Condition, Actions })

test('extracts gated shop stock and sequential trade inputs without dialogue or arbitrary item references', () => {
  const input = npc([page([
    action('Message', { Message: 'Private dialogue', ItemID: 999 }),
    action('Condition', { Condition: { ConditionType: 'CanUnderstandQuintar', IsNegation: false, Data: null }, ConditionActionsTrue: [action('Shop', { Stock: [{ LootType: 'Item', LootValue: 0, CostRate: 100, Condition: always }] }), action('RemoveInventory', { LootType: 'Equipment', LootValue: 7, Count: 2 }), action('AddInventory', { LootType: 'Item', LootValue: 8, Count: 1, Redirect: false })], ConditionActionsFalse: [action('AddInventory', { LootType: 'Item', LootValue: 9, Count: 1, Redirect: false })] }),
  ])])
  const before = JSON.stringify(input)
  const routes = projectWorldAcquisition([input], {})
  assert.equal(routes.length, 3)
  assert.equal(routes[0].targetID, 0)
  assert.ok(routes[0].conditions.some(condition => condition.type === 'CanUnderstandQuintar' && !condition.negated))
  assert.deepEqual(routes[1].costs, [{ family: 'equipment', id: 7, count: 2 }])
  assert.ok(routes[2].conditions.some(condition => condition.type === 'CanUnderstandQuintar' && condition.negated))
  assert.doesNotMatch(JSON.stringify(routes), /Private dialogue|999|Message/)
  assert.equal(JSON.stringify(input), before)
})

test('excludes disabled branches and pages overridden by a later unconditional page for the same trigger', () => {
  const stock = id => action('Shop', { Stock: [{ LootType: 'Equipment', LootValue: id, CostRate: 100, Condition: always }] })
  const routes = projectWorldAcquisition([npc([page([stock(1)]), page([stock(2)], { ConditionType: 'Never', IsNegation: false, Data: null }), page([stock(3)])])], {})
  assert.deepEqual(routes.map(route => route.targetID), [3])
})

test('a later trade payment does not retroactively change the inputs recorded for an earlier reward', () => {
  const [first, second] = projectWorldAcquisition([npc([page([
    action('RemoveInventory', { LootType: 'Item', LootValue: 7, Count: 2 }),
    action('AddInventory', { LootType: 'Item', LootValue: 8, Count: 1 }),
    action('RemoveInventory', { LootType: 'Equipment', LootValue: 9, Count: 3 }),
    action('AddInventory', { LootType: 'Item', LootValue: 10, Count: 1 }),
  ])])], {})
  assert.deepEqual(first.costs, [{ family: 'item', id: 7, count: 2 }])
  assert.deepEqual(second.costs, [{ family: 'item', id: 7, count: 2 }, { family: 'equipment', id: 9, count: 3 }])
})

test('keeps chest, crafting station, recovery and starting sources distinct', () => {
  const routes = projectWorldAcquisition([{ ID: 1, EntityType: 'Treasure', BiomeID: 0, Coord: { X: 0, Y: 0, Z: 0 }, TreasureData: { LootType: 'Item', LootValue: 1 } }, npc([page([action('ShopRecipe', { Stock: [{ LootType: 'Item', LootValue: 2, CostRate: 100, Condition: always }] }), action('AddToLostAndFound', { LootType: 'Item', LootValue: 3, Count: 1 })])])], { StartingLoot: [{ LootType: 1, LootID: 4, LootQuantity: 2 }] })
  assert.deepEqual(routes.map(route => [route.kind, route.family, route.targetID]), [['chest', 'item', 1], ['craft', 'recipe', 2], ['recovery', 'item', 3], ['start', 'item', 4]])
})

test('retains NPC appearance conditions including randomizer recovery instead of treating grants as unconditional', () => {
  const input = npc([page([action('AddInventory', { LootType: 'Item', LootValue: 8, Count: 1 })])])
  input.NpcData.Outfits[0].Condition = { ConditionType: 'Operation', IsNegation: false, Data: { LHS: { ConditionType: 'CheckFlag', IsNegation: true, Data: { Scope: 'Private', VariableKey: 'synthetic', Flag: true } }, Op: 'And', RHS: { ConditionType: 'Randomizer', IsNegation: false, Data: { InvalidItemID: 8, RandomItems: true } } } }
  const [route] = projectWorldAcquisition([input], {})
  assert.equal(route.conditions[0].data.RHS.type, 'Randomizer')
  assert.deepEqual(route.conditions[0].data.RHS.data, { InvalidItemID: 8, RandomItems: true })
})

test('source validation checks every pin and resolves targets and locations against the matching snapshot', () => {
  const hash = '1'.repeat(64)
  const source = { platform: 'Windows', gameVersion: 'synthetic', gameExecutableSha256: hash, editorExecutableSha256: hash, world: { path: 'Content/Worlds/field.dat', sha256: hash, size: 1 }, biomes: { path: 'Content/Database/biome.dat', sha256: hash, size: 1 }, scope: 'Item acquisition facts from field world and starting inventory', rights: 'synthetic', evidence: ['Synthetic.decoder'], nativeContentDigest: hash, systemSha256: hash }
  const native = { contentDigest: hash, source: { platform: 'Windows', gameVersion: 'synthetic', executable: { sha256: hash }, files: [{ path: 'Database/system.dat', sha256: hash }] }, databases: { item: [{ ID: 8 }], equipment: [], recipe: [], biome: [{ ID: 2 }] } }
  const reference = { source, records: [{ ID: 4, BiomeID: 2, Coord: { X: 0, Y: -1, Z: 3 } }] }
  const snapshot = { schemaVersion: 1, source, entries: projectWorldAcquisition([npc([page([action('AddInventory', { LootType: 'Item', LootValue: 8, Count: 1 })])])], {}) }
  const digest = value => ({ ...value, contentDigest: contentDigest(value) })
  assert.doesNotThrow(() => validateAcquisitionSource(digest(snapshot), native, reference))
  for (const field of ['systemSha256', 'editorExecutableSha256', 'nativeContentDigest', 'gameExecutableSha256', 'gameVersion', 'platform']) {
    const next = { ...snapshot, source: { ...source, [field]: field === 'gameVersion' ? 'different' : field === 'platform' ? 'Switch' : '2'.repeat(64) } }
    assert.throws(() => validateAcquisitionSource(digest(next), native, reference))
  }
  assert.throws(() => validateAcquisitionSource(digest({ ...snapshot, source: { ...source, biomes: { ...source.biomes, size: 2 } } }), native, reference), /biomes source differs/)
  assert.throws(() => validateAcquisitionSource(digest({ ...snapshot, entries: [{ ...snapshot.entries[0], targetID: 9 }] }), native, reference), /identity is unresolved/)
  assert.throws(() => validateAcquisitionSource(digest({ ...snapshot, entries: [{ ...snapshot.entries[0], coord: { X: 1, Y: -1, Z: 3 } }] }), native, reference), /location differs/)
})

test('updater CLI validates option forms and runs offline checks without the SDK', () => {
  const script = new URL('./update-world-acquisition.mjs', import.meta.url).pathname
  for (const flag of ['--help', '-h', '-hiunused']) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', script, flag], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
  for (const args of [[], ['--unknown'], ['--input'], ['--input='], ['-i', ''], ['--check', '-iunused'], ['--check', '--', 'unexpected']]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
  }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script, '--check'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Verified acquisition/)
})

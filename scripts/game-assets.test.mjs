import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { actorIconRegion, buildGameIdentityCrosswalk, classCompositeDimensions, databaseTextureReferences, gameIconRegion, hash, nativeArtworkIdentity, parseArchipelagoItems, parseGameDatabase, parsePythonStringAssignments, parseStarterRecords, parseTexturePack, reviewedNativeMappings, safeTextureRelativePath, stableSourceDigest, verifyReviewedNativeDatabase } from './game-assets.mjs'

function encodedDatabase(records, version = 10) {
  const json = Buffer.from(JSON.stringify(records))
  const bytes = Buffer.alloc(json.length + 2)
  bytes.writeUInt16LE(version)
  for (let index = 0; index < json.length; index += 1) bytes[index + 2] = 255 - json[index]
  return bytes
}

function texturePack(entries, version = 10) {
  const prefix = Buffer.alloc(6 + entries.length * 7)
  prefix.writeUInt16LE(version)
  prefix.writeUInt32LE(entries.length, 2)
  const bodies = entries.flatMap(({ name, bytes }) => {
    const nameBytes = Buffer.from(name)
    const nameLength = Buffer.alloc(4)
    nameLength.writeUInt32LE(nameBytes.length)
    const imageLength = Buffer.alloc(4)
    imageLength.writeUInt32LE(bytes.length)
    return [nameLength, nameBytes, imageLength, bytes]
  })
  return Buffer.concat([prefix, ...bodies])
}

test('native database decoding preserves its version and rejects malformed JSON', () => {
  const records = [{ ID: 7, Name: 'Synthetic Potion', TexturePath: 'Icon/Test', TextureIndex: 2 }]
  assert.deepEqual(parseGameDatabase(encodedDatabase(records)), { version: 10, records })
  assert.throws(() => parseGameDatabase(Buffer.from([10, 0, 0])), /valid inverted JSON/)
})

test('texture pack parsing validates framing, PNG bytes, names, and trailing data', async () => {
  const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#ffffffff' } }).png().toBuffer()
  const parsed = parseTexturePack(texturePack([{ name: 'Synthetic', bytes: png }]), 'Icon')
  assert.equal(parsed.version, 10)
  assert.equal(parsed.textures[0].path, 'Icon/Synthetic')
  assert.equal(parsed.textures[0].sha256, hash(png))
  assert.deepEqual([parsed.textures[0].width, parsed.textures[0].height], [4, 3])
  assert.throws(() => parseTexturePack(Buffer.concat([texturePack([{ name: 'Synthetic', bytes: png }]), Buffer.from([0])]), 'Icon'), /trailing bytes/)
  assert.throws(() => parseTexturePack(texturePack([{ name: 'Synthetic', bytes: Buffer.from('not a png') }]), 'Icon'), /supported PNG/)
  assert.throws(() => parseTexturePack(texturePack([{ name: 'Synthetic', bytes: png }, { name: 'Synthetic', bytes: png }]), 'Icon'), /duplicate/)
})

test('executable crop rules remain bounded and preserve paired class variants', () => {
  assert.deepEqual(gameIconRegion(8, { width: 240, height: 104 }), { x: 36, y: 36, width: 32, height: 32 })
  assert.deepEqual(actorIconRegion({ width: 75, height: 144 }), { x: 30, y: 7, width: 15, height: 15 })
  assert.deepEqual(classCompositeDimensions([{ width: 15, height: 15 }, { width: 15, height: 15 }]), { width: 32, height: 15, gap: 2 })
  assert.throws(() => gameIconRegion(70, { width: 64, height: 64 }), /outside/)
})

test('database texture inventory records exact references, indices, and unresolved paths', () => {
  const result = databaseTextureReferences('item', [{ ID: 4, Name: 'Synthetic', TexturePath: 'Icon/Test', TextureIndex: 3, Nested: { ActorTexturePathM: 'Actor/Missing' } }], new Set(['Icon/Test']))
  assert.deepEqual(result.references, [{ database: 'item', pointer: '/0/TexturePath', texturePath: 'Icon/Test', textureIndex: 3, record: { id: 4, name: 'Synthetic' } }])
  assert.deepEqual(result.unresolved, [{ database: 'item', pointer: '/0/Nested/ActorTexturePathM', value: 'Actor/Missing', record: { id: 4, name: 'Synthetic' } }])
})

test('Archipelago parsing creates only explicit source-backed native identity mappings', () => {
  const constantsSource = 'WARRIOR_JOB = "Job - Warrior"\nROOST = "Scholar - Roost"\n'
  const constants = parsePythonStringAssignments(constantsSource)
  const itemSource = `job_index_offset = 1
item_index_offset = 101
equipment_index_offset = 1001
scholar_index_offset = 100001
item_table = {
    WARRIOR_JOB: ItemData(JOB, 0 + job_index_offset, ItemClassification.progression),
    "Item - Potion": ItemData(ITEM, 0 + item_index_offset, ItemClassification.filler),
    "Equipment - Short Sword": ItemData(EQUIPMENT, 4 + equipment_index_offset, ItemClassification.useful),
    ROOST: ItemData(SCHOLAR_ABILITY, 25 + scholar_index_offset, ItemClassification.useful),
}
`
  const items = parseArchipelagoItems(itemSource, constants)
  const starterSource = `  ["base:class:warrior", "class", "Warrior", "apworld-classes"],
  ["base:item:potion", "item", "Potion", "apworld-items"],
  ["base:item:short-sword", "item", "Short Sword", "apworld-items"],
  ["base:monster-magic:roost", "monsterMagic", "Roost", "apworld-monster-magic"],
  ["base:ability:attack", "ability", "Attack", "wiki-warrior"],
`
  const records = parseStarterRecords(starterSource)
  const crosswalk = buildGameIdentityCrosswalk(records, items)
  assert.deepEqual(Object.keys(crosswalk.mappings), records.slice(0, 4).map(record => record.id))
  assert.deepEqual(crosswalk.mappings['base:item:short-sword'], {
    kind: 'item', name: 'Short Sword', sourceKey: 'apworld-items', upstreamName: 'Equipment - Short Sword', upstreamCategory: 'EQUIPMENT', upstreamCode: 1005, database: 'equipment', databaseId: 4, locator: 'worlds/crystal_project/items.py:8',
  })
  assert.match(crosswalk.unresolved[0].reason, /no reviewed native database crosswalk/)
})

test('reviewed travel identities reject a changed database or mismatched record', () => {
  const bytes = Buffer.from('synthetic item database')
  const mapping = reviewedNativeMappings({ schemaVersion: 1, database: 'item', databaseSha256: hash(bytes), records: [{ id: 'wiki:item:ibek-bell', kind: 'item', name: 'Ibek Bell', databaseId: 50 }] })['wiki:item:ibek-bell']
  assert.deepEqual(nativeArtworkIdentity(mapping), { sourceKey: 'reviewed-native-item', databaseSha256: hash(bytes), locator: 'Database/item.dat record 50' })
  assert.doesNotThrow(() => verifyReviewedNativeDatabase(mapping, bytes, { ID: 50, Name: 'Ibek Bell' }))
  assert.throws(() => verifyReviewedNativeDatabase(mapping, Buffer.from('changed'), { ID: 50, Name: 'Ibek Bell' }), /changed database bytes/)
  assert.throws(() => verifyReviewedNativeDatabase(mapping, bytes, { ID: 50, Name: 'Owl Drum' }), /does not match/)
  assert.throws(() => reviewedNativeMappings({ schemaVersion: 1, database: 'item', databaseSha256: hash(bytes), records: [{ id: 'wiki:item:ibek-bell', kind: 'item', name: 'Ibek Bell', databaseId: 50 }, { id: 'wiki:item:owl-drum', kind: 'item', name: 'Owl Drum', databaseId: 50 }] }), /duplicated/)
})

test('texture output paths and aggregate source digests are deterministic and traversal-safe', () => {
  assert.equal(safeTextureRelativePath('Icon', 'Nested/Test'), 'Icon/Nested/Test.png')
  for (const name of ['../escape', 'nested/../../escape', 'bad\\name']) assert.throws(() => safeTextureRelativePath('Icon', name), /safe relative path/)
  assert.equal(stableSourceDigest([['b', 'two'], ['a', 'one']]), stableSourceDigest([['a', 'one'], ['b', 'two']]))
})

test('native asset CLIs expose help on stdout and option errors on stderr', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url))
  for (const script of ['update-game-identities.mjs', 'update-game-assets.mjs']) {
    const help = spawnSync(process.execPath, [script, '--help'], { cwd: directory, encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /^Usage:/)
    assert.equal(help.stderr, '')
    const invalid = spawnSync(process.execPath, [script, '--not-an-option'], { cwd: directory, encoding: 'utf8' })
    assert.equal(invalid.status, 2)
    assert.equal(invalid.stdout, '')
    assert.match(invalid.stderr, /Unknown option/)
  }
})

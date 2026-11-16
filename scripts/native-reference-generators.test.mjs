import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const root = new URL('..', import.meta.url)

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-native-generators-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'scripts'), { recursive: true })
  await mkdir(join(directory, 'src/catalog'), { recursive: true })
  await mkdir(join(directory, 'src/calculations'), { recursive: true })
  for (const file of ['game-assets.mjs', 'update-game-identities.mjs', 'update-class-tree-identities.mjs', 'update-native-stats.mjs']) await cp(new URL(`scripts/${file}`, root), join(directory, 'scripts', file))
  await cp(new URL('src/catalog/native-game-data.json', root), join(directory, 'src/catalog/native-game-data.json'))
  await cp(new URL('src/calculations/character-rules-v1.json', root), join(directory, 'src/calculations/character-rules-v1.json'))
  return directory
}

function run(directory, script, args = []) {
  const result = spawnSync(process.execPath, [join(directory, 'scripts', script), ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('native identity projection regenerates offline without authoring catalogs or network sources', async t => {
  const directory = await fixture(t)
  run(directory, 'update-game-identities.mjs')
  run(directory, 'update-game-identities.mjs', ['--check'])
  const native = JSON.parse(await readFile(join(directory, 'src/catalog/native-game-data.json')))
  const result = JSON.parse(await readFile(join(directory, 'src/catalog/game-identities.json')))
  assert.equal(Object.keys(result.mappings).length, Object.keys(native.identityBindings).length)
  for (const [key, entityId] of Object.entries(native.identityBindings)) {
    const [database, id] = key.split(':')
    const mapping = result.mappings[entityId]
    assert.equal(mapping.database, database)
    assert.equal(mapping.databaseId, Number(id))
    assert.equal(mapping.name, native.databases[database].find(record => record?.ID === Number(id)).Name)
    assert.equal(mapping.databaseSha256, native.source.files.find(file => file.path === `Database/${database}.dat`).sha256)
    assert.equal(mapping.upstreamCode, undefined)
  }
})

test('class trees use native job coordinates, skill IDs, and exact learning costs', async t => {
  const directory = await fixture(t)
  run(directory, 'update-class-tree-identities.mjs')
  run(directory, 'update-class-tree-identities.mjs', ['--check'])
  const native = JSON.parse(await readFile(join(directory, 'src/catalog/native-game-data.json')))
  const result = JSON.parse(await readFile(join(directory, 'src/catalog/class-tree-identities.json')))
  for (const job of native.databases.job.filter(Boolean)) {
    const tree = result.classes[native.identityBindings[`job:${job.ID}`]]
    assert.equal(tree.nativeJobId, job.ID)
    assert.equal(tree.copiedJobId, undefined)
    for (const node of tree.nodes) {
      const cell = job.LearnTree[node.column][node.row]
      const family = cell.NodeType === 2 ? 'ability' : 'passive'
      const skill = native.databases[family].find(record => record?.ID === cell.DataID)
      assert.equal(node.entityId, native.identityBindings[`${family}:${skill.ID}`])
      assert.equal(node.jp, skill.JP)
      assert.equal(node.name, skill.Name)
    }
  }
  assert.equal(result.baselineSha256, undefined)
})

test('numeric projection retains native records and mode patches without secondary identity inputs', async t => {
  const directory = await fixture(t)
  run(directory, 'update-native-stats.mjs')
  run(directory, 'update-native-stats.mjs', ['--check'])
  const native = JSON.parse(await readFile(join(directory, 'src/catalog/native-game-data.json')))
  const result = JSON.parse(await readFile(join(directory, 'src/catalog/native-stats-v1.json')))
  assert.deepEqual(result.patches.map(patch => patch.name), native.databases.patch.map(patch => patch.Name))
  assert.equal(result.records.job.find(job => job.ID === 0).HPRating, native.databases.job[0].HPRating)
  for (const field of ['crosswalkDigest', 'wikiDigest', 'starterDigest']) assert.equal(result[field], undefined)
  assert.equal(result.bindings, undefined)
  assert.equal(result.catalogId, undefined)
})

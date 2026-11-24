import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { BaseSequencer } from 'vitest/node'
import NativeTestSequencer from './native-test-sequencer.ts'

const root = '/synthetic-project'
const spec = (path, project = 'worker') => ({ moduleId: join(root, path), project: { name: project } })
const partition = (files, index, count = 2) => new NativeTestSequencer({ config: { root, shard: { index, count } } }).shard(files)

async function configuredSequencer({ ci, native, hosted } = {}) {
  const environment = { CI: ci, CRYKIT_NATIVE_TEST_PARTITION: native, CRYKIT_HOSTED_PERSISTENCE_PARTITION: hosted }
  const original = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  function setEnvironment(values) {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    setEnvironment(environment)
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vite.config.ts')
    assert.ok(loaded)
    return loaded.config.test.sequence?.sequencer
  } finally {
    setEnvironment(original)
  }
}

test('balances expensive fixtures without omitting new files or overlapping projects', async () => {
  const files = [spec('src/persistence/conflicts.test.ts', 'persistence-service'), spec('src/persistence/lineage-conflicts.test.ts', 'persistence-service'), spec('src/persistence/mapping-bulk-conflicts.test.ts', 'persistence-service'), spec('worker/new.test.ts'), spec('worker/new.test.ts', 'future-project')]
  const first = await partition(files, 1), second = await partition(files, 2)
  assert.equal(first.includes(files[0]), true)
  assert.equal(second.includes(files[1]), true)
  assert.equal(second.includes(files[2]), true)
  assert.equal(new Set([...first, ...second]).size, files.length)
  assert.equal(first.length + second.length, files.length)
  assert.deepEqual(await partition([...files].reverse(), 1), first)
  assert.deepEqual(await partition([...files].reverse(), 2), second)
})

test('empty, filtered and additional shards still partition every discovered specification once', async () => {
  for (const files of [[], [spec('worker/unknown.test.ts')], [spec('worker/a.test.ts'), spec('worker/b.test.ts'), spec('worker/c.test.ts')]]) {
    for (const count of [1, 2, 4]) {
      const shards = await Promise.all(Array.from({ length: count }, (_, index) => partition(files, index + 1, count)))
      assert.equal(shards.flat().length, files.length)
      assert.equal(new Set(shards.flat()).size, files.length)
      for (const file of files) assert.ok(shards.flat().includes(file))
    }
  }
})

test('hosted persistence balances eight bins independently of discovery order and cached timings', async () => {
  const Sequencer = await configuredSequencer({ ci: 'true', hosted: 'balanced' }) ?? BaseSequencer
  const recovery = spec('src/persistence/signin-reconciliation-recovery.test.ts', 'persistence-service')
  const conflicts = spec('src/persistence/conflicts.test.ts', 'persistence-service')
  const unknown = (suffix, project = 'persistence') => spec(`src/persistence/extra-${suffix}.test.ts`, project)
  const a = unknown('a'), aService = unknown('a', 'persistence-service')
  const b = unknown('b'), c = unknown('c'), d = unknown('d'), e = unknown('e')
  const f = unknown('f'), g = unknown('g'), h = unknown('h')
  const files = [h, conflicts, aService, e, c, recovery, g, a, b, d, f]
  const assign = (discovered, cache) => Promise.all(Array.from({ length: 8 }, (_, offset) =>
    new Sequencer({ config: { root, shard: { index: offset + 1, count: 8 } }, cache }).shard(discovered)))

  const bins = await assign(files)
  // Unknown files must grow their bin's cost, including a new project at the same path
  assert.deepEqual(bins, [[recovery], [conflicts], [a, f], [aService, g], [b, h], [c], [d], [e]])
  assert.equal(bins.flat().length, files.length)
  assert.deepEqual(new Set(bins.flat()), new Set(files))
  const staleCache = { getTestSpecificationResult() { throw new Error('Placement read cached timings') } }
  assert.deepEqual(await assign([...files].reverse(), staleCache), bins)
  assert.deepEqual(await assign([aService]), [[aService], [], [], [], [], [], [], []])
  assert.deepEqual(await assign([]), [[], [], [], [], [], [], [], []])
})

test('placement markers select hosted CI or local native costs only in their intended environment', async () => {
  // These fixtures rank in opposite order under the local and hosted cost tables
  const copiedJourney = spec('src/persistence/copied-conflict-journey.test.ts', 'persistence-service')
  const lineageConflicts = spec('src/persistence/lineage-conflicts.test.ts', 'persistence-service')
  const firstBin = Sequencer => new (Sequencer ?? BaseSequencer)({ config: { root, shard: { index: 1, count: 2 } } }).shard([copiedJourney, lineageConflicts])

  assert.deepEqual(await firstBin(await configuredSequencer({ native: 'balanced', hosted: 'balanced' })), [lineageConflicts])
  assert.deepEqual(await firstBin(await configuredSequencer({ ci: 'true', native: 'balanced', hosted: 'balanced' })), [copiedJourney])
  assert.equal(await configuredSequencer({ hosted: 'balanced' }), undefined)
  assert.equal(await configuredSequencer({ ci: 'true', native: 'balanced' }), undefined)
  assert.equal(await configuredSequencer({ ci: 'true', hosted: 'true' }), undefined)
})

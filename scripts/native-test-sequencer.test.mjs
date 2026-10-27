import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import NativeTestSequencer from './native-test-sequencer.ts'

const root = '/synthetic-project'
const spec = (path, project = 'worker') => ({ moduleId: join(root, path), project: { name: project } })
const partition = (files, index, count = 2) => new NativeTestSequencer({ config: { root, shard: { index, count } } }).shard(files)

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

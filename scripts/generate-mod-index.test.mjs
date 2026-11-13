import assert from 'node:assert/strict'
import test from 'node:test'
import { recordSourceRevision } from './generate-mod-index.mjs'

const vanilla = { id: 'crystal-project/vanilla', revisionId: 'v1', checksum: `builtin:sha256:${'1'.repeat(64)}` }

test('a bundled source revision cannot acquire a different checksum', () => {
  const receipts = [vanilla]
  assert.deepEqual(recordSourceRevision(receipts, vanilla), receipts)
  assert.throws(() => recordSourceRevision(receipts, { ...vanilla, checksum: `builtin:sha256:${'2'.repeat(64)}` }), /Immutable source revision/)
  assert.deepEqual(receipts, [vanilla])
})

test('sources allocate revisions independently while keeping historical receipts', () => {
  const next = { ...vanilla, revisionId: 'v2', checksum: `builtin:sha256:${'2'.repeat(64)}` }
  const guide = { ...vanilla, id: 'crystal-project/guide/modding', checksum: `builtin:sha256:${'3'.repeat(64)}` }
  assert.deepEqual(recordSourceRevision(recordSourceRevision([vanilla], next), guide), [vanilla, next, guide])
})

test('a bundle cannot change its payload source or interpretation under the same receipt', () => {
  const receipt = { ...vanilla, id: 'crystal-project/mod/synthetic', payloadSource: { catalogId: `crystal-project/imported/ce1-${'a'.repeat(64)}`, catalogRevisionId: `j1-${'b'.repeat(64)}-p1` } }
  assert.throws(() => recordSourceRevision([receipt], { ...receipt, payloadSource: { ...receipt.payloadSource, catalogRevisionId: `j1-${'b'.repeat(64)}-p2` } }), /Immutable source revision/)
})

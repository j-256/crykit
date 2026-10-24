import { expect, it } from 'vitest'
import { readBlob } from './blobs'
import { assembleWorkspace, splitWorkspace } from './documents'
import { editorClosureFixture as fixture } from './test-helpers'
import { validateWorkspaceClosure, publicationDocuments } from './closure'


it('retains exact invalid pending metadata and bytes without publishing pending-only bodies', async () => {
  const { state, file } = await fixture()
  await validateWorkspaceClosure(state)
  const documents = splitWorkspace(state)
  const roundTrip = assembleWorkspace(documents, 0)
  await validateWorkspaceClosure(roundTrip)
  expect(roundTrip.retainedContent).toEqual(state.retainedContent)
  expect(JSON.parse(new TextDecoder().decode(await readBlob(roundTrip.blobs[1].content, 10000)))).toEqual(file)
  expect(await readBlob(roundTrip.blobs[0].content, 2)).toEqual(new Uint8Array([0x00, 0xd8]))
  expect((await publicationDocuments(state)).filter(document => ['blob', 'blob-reference', 'retained-content'].includes(document.kind))).toEqual([])
})
it('rejects omitted required bytes, unsupported entries and mismatched retained file identity', async () => {
  const { state, add, entries, closure } = await fixture()
  await expect(validateWorkspaceClosure({ ...state, blobs: state.blobs.slice(1) })).rejects.toThrow()
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [{ ...entries[0], kind: 'workspace-control' }, entries[1]], children: [] }, 'bad-index')
  await expect(validateWorkspaceClosure({ ...state, blobs: state.blobs, retainedContent: [{ version: 1, kind: 'file-history', id: 'history', fileKind: 'editor', documentId: 'wrong', retainedAt: '2026-01-01', retention: 'protected', content: { ...closure, index } }] })).rejects.toThrow()
})

it('round trips nonempty conflicts with exact ancestor and alternative immutable file identities', async () => {
  const { state, file, add, entries, closure } = await fixture()
  const otherFile = { ...file, filename: 'other.json', revision: 1, unfinished: { ...file.unfinished, fieldState: { password: 'other inert text' } } }
  const otherRoot = await add(otherFile, 'other-root')
  const otherIndex = await add({ version: 1, kind: 'conflict-closure-page', entries: [{ ...entries[0], ref: otherRoot }, entries[1]], children: [] }, 'other-index')
  const other = { version: 1 as const, root: otherRoot, index: otherIndex }
  const conflict = { version: 1 as const, id: 'file-conflict', unit: { kind: 'record' as const, privateKey: entries[0].key }, commonAncestor: { kind: 'present' as const, closure }, branches: [{ role: 'local-pending' as const, closure }, { role: 'accepted-cloud' as const, closure: other }] as const, disposition: { kind: 'resolved' as const, choice: 'other' as const, result: other } }
  const original = { ...state, conflicts: [conflict] }
  const reopened = assembleWorkspace(splitWorkspace(original), 0)
  await validateWorkspaceClosure(reopened)
  expect(reopened.conflicts).toEqual(original.conflicts)
  expect(reopened.editorDocuments).toEqual([])
  expect(JSON.parse(new TextDecoder().decode(await readBlob(reopened.blobs.find(blob => blob.ref.documentId === otherRoot.documentId)!.content, 10000)))).toEqual(otherFile)
  expect((await publicationDocuments(reopened)).some(document => document.kind === 'blob' && document.key.includes('other-root'))).toBe(true)
})

it('retains exact shard evidence without treating unrelated allocations as revision dependencies', async () => {
  const { state, add, entries, closure } = await fixture()
  const key = entries[0].key
  const evidence = await add({ version: 1, kind: 'directory', shard: 7, entries: [{ key, documentId: closure.root.documentId }, { key: 'unrelated allocation', documentId: 'unavailable-unrelated-document' }], children: [] }, 'shard-evidence')
  const mapping = await add({ version: 1, kind: 'directory-mapping-unit', privateKey: key, shard: 7, shardEvidence: evidence, allocation: { kind: 'present', sourceDocumentId: closure.root.documentId, valueRoot: closure.root } }, 'mapping')
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [...entries, { version: 1, ref: evidence, documentVersion: 1, kind: 'directory', key: '["directory","7"]', encoding: 'json', dependencies: [] }, { version: 1, ref: mapping, documentVersion: 1, kind: 'directory-mapping-unit', key, encoding: 'json', dependencies: [evidence, closure.root] }], children: [] }, 'mapping-index')
  const target = { version: 1 as const, root: mapping, index }
  const portable = { ...state, retainedContent: [{ version: 1 as const, kind: 'pending-content' as const, id: 'mapping-pending', groupId: 'group', unit: { kind: 'directory-mapping' as const, privateKey: key, shard: 7 }, base: { kind: 'absent' as const }, target }] }
  await validateWorkspaceClosure(portable)
  await expect(validateWorkspaceClosure({ ...portable, blobs: portable.blobs.filter(blob => blob.ref.documentId !== closure.root.documentId) })).rejects.toThrow()
})

it('rejects unsupported future team checkpoint payloads instead of accepting arbitrary JSON', async () => {
  const { state, add } = await fixture()
  const root = await add({ version: 9, arbitrary: 'unvalidated' }, 'future-team')
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [{ version: 1, ref: root, documentVersion: 1, kind: 'team-checkpoint', key: '["team-checkpoint","future-team"]', encoding: 'json', dependencies: [] }], children: [] }, 'future-index')
  await expect(validateWorkspaceClosure({ ...state, retainedContent: [{ version: 1, kind: 'pending-content', id: 'future', groupId: 'future', unit: { kind: 'record', privateKey: '["team-checkpoint","future-team"]' }, base: { kind: 'absent' }, target: { version: 1, root, index } }] })).rejects.toMatchObject({ name: 'ZodError', issues: expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys', keys: ['version', 'arbitrary'] })]) })
})

it('rejects a valid file body installed under another semantic private key', async () => {
  const { state, add, file, entries, closure } = await fixture()
  const root = await add({ ...file, id: 'different-file' }, 'foreign-file')
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [{ ...entries[0], ref: root }, entries[1]], children: [] }, 'foreign-file-index')
  await expect(validateWorkspaceClosure({ ...state, retainedContent: [{ ...state.retainedContent[0], target: { ...closure, root, index } } as typeof state.retainedContent[0]] })).rejects.toThrow('identity')
})

it('binds a directory allocation to its singular semantic value key rather than transport identity alone', async () => {
  const { state, add, entries, closure } = await fixture()
  const key = '["editor","different-editor"]'
  const evidence = await add({ version: 1, kind: 'directory', shard: 7, entries: [{ key, documentId: closure.root.documentId }], children: [] }, 'wrong-value-shard')
  const mapping = await add({ version: 1, kind: 'directory-mapping-unit', privateKey: key, shard: 7, shardEvidence: evidence, allocation: { kind: 'present', sourceDocumentId: closure.root.documentId, valueRoot: closure.root } }, 'wrong-value-mapping')
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [...entries, { version: 1, ref: evidence, documentVersion: 1, kind: 'directory', key: '["directory","7"]', encoding: 'json', dependencies: [] }, { version: 1, ref: mapping, documentVersion: 1, kind: 'directory-mapping-unit', key, encoding: 'json', dependencies: [evidence, closure.root] }], children: [] }, 'wrong-value-index')
  await expect(validateWorkspaceClosure({ ...state, retainedContent: [{ version: 1, kind: 'pending-content', id: 'wrong-value', groupId: 'group', unit: { kind: 'directory-mapping', privateKey: key, shard: 7 }, base: { kind: 'absent' }, target: { version: 1, root: mapping, index } }] })).rejects.toThrow('semantic value')
})

for (const tombstone of [false, true]) it(`accepts a singular compound directory value with tombstone=${tombstone}`, async () => {
  const { state, add, entries, closure } = await fixture()
  const key = entries[0].key
  const primary = tombstone ? await add({ version: 1, kind: 'tombstone', privateKey: key }, 'deleted-value') : closure.root
  const valueEntries = tombstone ? [{ version: 1, ref: primary, documentVersion: 1, kind: 'tombstone', key, encoding: 'json', dependencies: [] }] : entries
  const compound = await add({ version: 1, kind: 'unit-index', roots: [primary], relation: { kind: 'unit', privateKey: key, primary } }, 'compound-value')
  const evidence = await add({ version: 1, kind: 'directory', shard: 7, entries: [{ key, documentId: primary.documentId }, { key: 'unrelated', documentId: 'unavailable' }], children: [] }, 'compound-shard')
  const mapping = await add({ version: 1, kind: 'directory-mapping-unit', privateKey: key, shard: 7, shardEvidence: evidence, allocation: { kind: 'present', sourceDocumentId: primary.documentId, valueRoot: compound } }, 'compound-mapping')
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [...valueEntries, { version: 1, ref: compound, documentVersion: 1, kind: 'unit-index', key: '["unit-index","compound-value"]', encoding: 'json', dependencies: [primary] }, { version: 1, ref: evidence, documentVersion: 1, kind: 'directory', key: '["directory","7"]', encoding: 'json', dependencies: [] }, { version: 1, ref: mapping, documentVersion: 1, kind: 'directory-mapping-unit', key, encoding: 'json', dependencies: [evidence, compound] }], children: [] }, 'compound-index')
  await validateWorkspaceClosure({ ...state, retainedContent: [{ version: 1, kind: 'pending-content', id: 'compound', groupId: 'group', unit: { kind: 'directory-mapping', privateKey: key, shard: 7 }, base: { kind: 'absent' }, target: { version: 1, root: mapping, index } }] })
})

it('publicationSelectionUsesItsAlreadyValidatedExactClosureRefsOnlyWithinThatCall', async () => {
  const { state, closure, entries } = await fixture()
  const { validatedWorkspaceRetentionEdges } = await import('./closure')
  const calls = new Map<string, number>()
  const observed = { ...state, retainedContent: [], conflicts: [{ version: 1 as const, id: 'same-closed-roles', unit: { kind: 'record' as const, privateKey: entries[0].key }, commonAncestor: { kind: 'present' as const, closure }, branches: [{ role: 'local-pending' as const, closure }, { role: 'accepted-cloud' as const, closure }] as const, disposition: { kind: 'resolved' as const, choice: 'this' as const, result: closure } }], blobs: state.blobs.map(blob => ({ ...blob, content: { ...blob.content, async *open() { calls.set(blob.ref.documentId, (calls.get(blob.ref.documentId) ?? 0) + 1); yield* blob.content.open() } } })) }
  await validatedWorkspaceRetentionEdges(observed)
  const validation = Object.fromEntries(calls)
  const readings = []
  for (let pass = 0; pass < 2; pass++) { calls.clear(); await publicationDocuments(observed); readings.push(Object.fromEntries(calls)) }
  const proof = { validation, readings }
  if (process.env.CRYKIT_SYNC_MEASUREMENTS) (await import('node:fs')).appendFileSync(process.env.CRYKIT_SYNC_MEASUREMENTS, `${JSON.stringify(proof)}\n`)
  expect(readings).toEqual([validation, validation])
  // A cached valid closure never supplies another semantic unit or a contradictory full root reference
  await expect(publicationDocuments({ ...observed, conflicts: [...observed.conflicts, { ...observed.conflicts[0], id: 'wrong-unit', unit: { kind: 'record', privateKey: '["editor","foreign"]' } }] })).rejects.toThrow('unit')
  await expect(publicationDocuments({ ...observed, conflicts: [{ ...observed.conflicts[0], disposition: { kind: 'resolved', choice: 'this', result: { ...closure, root: { ...closure.root, byteLength: closure.root.byteLength + 1 } } } }] })).rejects.toThrow()
})


it('does not reuse a parsed body across validation invocations after its bytes change', async () => {
  const { state } = await fixture()
  const original = state.blobs[1]
  let bytes = await readBlob(original.content, original.ref.byteLength)
  const source = { byteLength: bytes.byteLength, async *open() { yield bytes } }
  const observed = { ...state, blobs: state.blobs.map(blob => blob === original ? { ...blob, content: source } : blob) }
  await validateWorkspaceClosure(observed)
  bytes = bytes.slice(); bytes[0] ^= 1
  await expect(validateWorkspaceClosure(observed)).rejects.toThrow('digest mismatch')
})

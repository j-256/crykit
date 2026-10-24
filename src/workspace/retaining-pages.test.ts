import { expect, it } from 'vitest'
import { editorClosureFixture } from './test-helpers'
import { inspectWorkspaceClosure, validateWorkspaceClosure } from './closure'
import { blobIdentity, memoryBlob } from './blobs'
import type { WorkspaceBlobRef, WorkspaceConflictClosureEntry } from './documents'

for (const malformed of ['none', 'owner', 'key', 'duplicate', 'missing', 'cycle', 'primary'] as const) it(`validates explicitly associated retaining pages: ${malformed}`, async () => {
  const { state, file, add, entries, closure } = await editorClosureFixture()
  const owner = closure.root, privateKey = entries[0].key
  const relation = { kind: 'retaining-edges', privateKey: malformed === 'key' ? 'foreign-key' : privateKey, owner: malformed === 'owner' ? { ...owner, revisionId: 'foreign' } : owner }
  const roots = malformed === 'duplicate' ? [entries[1].ref, entries[1].ref] : [entries[1].ref]
  const retainingIndex = await add({ version: 1, kind: 'unit-index', roots, relation }, 'retaining-page')
  const pageEntry: WorkspaceConflictClosureEntry = { version: 1, ref: retainingIndex, documentVersion: 1, kind: 'unit-index', key: '["unit-index","retaining-page"]', encoding: 'json', dependencies: roots }
  const ownerEntry = { ...entries[0], retainingIndex, dependencies: [retainingIndex] }
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [ownerEntry, entries[1], pageEntry], children: [] }, 'retaining-closure')
  const target = { ...closure, index, ...(malformed === 'primary' ? { root: retainingIndex } : {}) }
  const portable = { ...state, retainedContent: [{ ...state.retainedContent[0], target } as typeof state.retainedContent[0]] }
  if (malformed === 'none') {
    await validateWorkspaceClosure(portable)
    expect((await inspectWorkspaceClosure(portable, target)).value).toEqual(file)
    return
  }
  if (malformed === 'missing') portable.blobs = portable.blobs.filter(blob => blobIdentity(blob.ref) !== blobIdentity(retainingIndex))
  if (malformed === 'cycle') {
    // Structural cycle proof bypasses digest authentication; constructing a self-hashed body is not possible
    const cyclic = { version: 1, kind: 'unit-index', roots: [retainingIndex], relation }
    const content = memoryBlob(new TextEncoder().encode(JSON.stringify(cyclic)))
    portable.blobs = portable.blobs.map(blob => blobIdentity(blob.ref) === blobIdentity(retainingIndex) ? { ...blob, content } : blob)
    await expect(inspectWorkspaceClosure(portable, target)).rejects.toThrow('Cyclic')
    return
  }
  await expect(validateWorkspaceClosure(portable)).rejects.toThrow()
})

it('does not authorize unrelated retaining pages through a compound evidence wrapper', async () => {
  const { state, add, entries, closure } = await editorClosureFixture()
  const relation = { kind: 'retaining-edges', privateKey: entries[0].key, owner: closure.root }
  const declared = await add({ version: 1, kind: 'unit-index', roots: [entries[1].ref], relation }, 'declared-retaining')
  const extra = await add({ version: 1, kind: 'unit-index', roots: [entries[1].ref], relation }, 'extra-retaining')
  const root = await add({ version: 1, kind: 'unit-index', roots: [closure.root, extra], relation: { kind: 'unit', privateKey: entries[0].key, primary: closure.root } }, 'outer-unit')
  const unit = (ref: WorkspaceBlobRef, roots: WorkspaceBlobRef[]): WorkspaceConflictClosureEntry => ({ version: 1, ref, documentVersion: 1, kind: 'unit-index', key: JSON.stringify(['unit-index', blobIdentity(ref)]), encoding: 'json', dependencies: roots })
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [{ ...entries[0], retainingIndex: declared, dependencies: [declared] }, entries[1], unit(declared, [entries[1].ref]), unit(extra, [entries[1].ref]), unit(root, [closure.root, extra])], children: [] }, 'outer-index')
  await expect(validateWorkspaceClosure({ ...state, retainedContent: [{ ...state.retainedContent[0], target: { version: 1, root, index } } as typeof state.retainedContent[0]] })).rejects.toThrow('Undeclared')
})

it('preserves bounded legacy direct archive entries beyond the transport dependency count', async () => {
  const { state, add } = await editorClosureFixture()
  // This boundary depends on distinct catalog edges, not decoding native gameplay definitions
  const catalogs = Array.from({ length: 257 }, (_, i) => ({ id: `legacy-direct-${i}`, revisionId: 'exact', schemaVersion: '1', checksum: `synthetic-${i}`, importedAt: '2026-01-01T00:00:00.000Z', applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: {}, claims: [] }))
  const entries: WorkspaceConflictClosureEntry[] = [], roots: WorkspaceBlobRef[] = []
  for (const catalog of catalogs) {
    const ref = await add(catalog, catalog.id)
    roots.push(ref); entries.push({ version: 1, ref, documentVersion: 1, kind: 'catalog', key: JSON.stringify(['catalog', catalog.id, catalog.revisionId]), encoding: 'json', dependencies: [] })
  }
  const value = { version: 1, layers: catalogs.map(catalog => ({ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: true })) }
  const root = await add(value, 'legacy-direct-owner'), key = '["library-defaults"]'
  entries.unshift({ version: 1, ref: root, documentVersion: 1, kind: 'library-defaults', key, encoding: 'json', dependencies: roots })
  const children: WorkspaceBlobRef[] = []
  for (let at = 0; at < entries.length; at += 64) children.push(await add({ version: 1, kind: 'conflict-closure-page', entries: entries.slice(at, at + 64), children: [] }, `legacy-direct-page-${at}`))
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries: [], children }, 'legacy-direct-index')
  const target = { version: 1 as const, root, index }
  const portable = { ...state, retainedContent: [{ version: 1 as const, kind: 'pending-content' as const, id: 'legacy-direct', groupId: 'legacy-direct', unit: { kind: 'record' as const, privateKey: key }, base: { kind: 'absent' as const }, target }] }
  await validateWorkspaceClosure(portable)
  expect((await inspectWorkspaceClosure(portable, target)).value).toEqual(value)
})

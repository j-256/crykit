import { expect, it } from 'vitest'
import { addTestBuild, createTestLocalData } from '../domain/test-helpers'
import { withBuildReferenceNames } from '../domain/build-reference-names'
import { syntheticCatalog } from '../workspace/test-helpers'
import { createPublicSnapshot, decodePublicSnapshot, encodePublicSnapshot } from './public-share'
import { PublicCheckpointContextSchema } from './public-source-context-schema'
import type { CatalogRef } from '../domain/types'

function fixture() {
  const source = syntheticCatalog('missing-share', undefined, { selected: { id: 'selected' as never, name: 'Saved selection', kind: 'class', aliases: [], fields: {}, sources: [] } })
  const ref: CatalogRef = { kind: 'catalog', catalogId: source.id, catalogRevisionId: source.revisionId, entityId: 'selected' as never }
  const initial = addTestBuild(createTestLocalData(), 'saved', '', {}, { primaryClass: ref, catalogLock: { [source.id]: source.revisionId } })
  const revision = initial.buildRevisions['saved-revision']!
  const localData = { ...initial, buildRevisions: { ...initial.buildRevisions, [revision.id]: { ...revision, content: withBuildReferenceNames(revision.content, [source]) } } }
  return { source, ref, localData, target: { kind: 'build' as const, revisionId: revision.id } }
}

it.each([false, true])('retains exact saved names with explicit origins available %s and no source body', origins => {
  const { localData, target, ref } = fixture(), revision = localData.buildRevisions[target.revisionId]!
  const content = { ...revision.content, referenceNames: revision.content.referenceNames!.map(value => ({ ...value, ...(origins ? {} : { origins: undefined }) })) }
  const changed = { ...localData, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content } } }, before = structuredClone(changed)
  const snapshot = createPublicSnapshot({ planner: { localData: changed, catalogs: [] } }, target, { includeNotes: false })
  expect(snapshot.receipts[0]).toMatchObject({ ref, name: 'Saved selection', kind: null })
  if (origins) expect(snapshot.receipts[0]?.origins).toEqual({ mechanical: ref, text: ref })
  else expect(snapshot.receipts[0]?.origin).toBeNull()
  expect(decodePublicSnapshot(encodePublicSnapshot(snapshot))).toEqual(snapshot)
  expect(changed).toEqual(before)
  for (const field of ['rawDescription', 'identityMappings', 'fields', 'sources']) expect(JSON.stringify(snapshot)).not.toContain(`"${field}"`)
})

it('requires saved display evidence instead of deriving names from numeric identity', () => {
  const { localData, target } = fixture(), revision = localData.buildRevisions[target.revisionId]!
  const changed = { ...localData, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, referenceNames: [] } } } }
  expect(() => createPublicSnapshot({ planner: { localData: changed, catalogs: [] } }, target, { includeNotes: false })).toThrow('exact saved display receipt')
})

it('rejects old copied contexts and incomplete personal receipts in the launch context', () => {
  const { localData, target } = fixture(), snapshot = createPublicSnapshot({ planner: { localData, catalogs: [] } }, target, { includeNotes: false })
  const checkpoint = { version: 3, setupDigest: 'a'.repeat(64), receipts: snapshot.receipts, personalBindings: [] }
  expect(PublicCheckpointContextSchema.safeParse(checkpoint).success).toBe(true)
  for (const version of [1, 2]) expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, version }).success).toBe(false)
  const value = 'b'.repeat(64), fingerprint = { kind: 'personal-definition-v1', value }
  const personal = { ref: { kind: 'personal', fingerprint }, kind: 'item', name: 'Personal selected item', fingerprint, origin: { kind: 'personal', projectId: 'personal-definition-v1', sourceRevisionId: value, catalogId: 'personal-definition-v1', catalogRevisionId: value } }
  expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, receipts: [personal] }).success).toBe(true)
  for (const missing of [{ kind: null }, { origin: null }, { fingerprint: undefined }]) expect(PublicCheckpointContextSchema.safeParse({ ...checkpoint, receipts: [{ ...personal, ...missing }] }).success).toBe(false)
})

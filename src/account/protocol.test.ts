import { describe, expect, it } from 'vitest'
import { MutationTransitionResponseSchema, MutationTransitionDocumentsSchema, maxMutationTransitionResponseBytes, ChangePageSchema, CommitRequestSchema, KeyEnvelopeSchema, OpaqueIdSchema, UploadStartSchema, maxChangedHeads } from './protocol'

const id = 'AAAAAAAAAAAAAAAAAAAAAA'
const revisionId = 'AQEBAQEBAQEBAQEBAQEBAQ'
const digest = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const envelope = { version: 1, algorithm: 'xchacha20poly1305-ietf', nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
const upload = { version: 1, uploadId: id, documentId: id, revisionId, metadataBytes: 1024, chunks: [{ index: 0, cipherBytes: 18, cipherDigest: digest }] }
const revision = { format: 1, accountId: id, documentId: id, revisionId, parents: [], dependencies: [], protected: false, plainBytes: 1, keyEnvelope: envelope, streamHeader: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', uploadId: id, chunks: upload.chunks }

describe('account wire boundaries', () => {
  it('acceptsCanonicalIdsAndRejectsAlternateEncodings', () => {
    expect(OpaqueIdSchema.safeParse(id).success).toBe(true)
    for (const value of [id + '=', 'AAAAAAAAAAAAAAAAAAAAAB', 'short', 'a'.repeat(1024)]) expect(OpaqueIdSchema.safeParse(value).success).toBe(false)
  })
  it('acceptsOnlyEncryptedVersionedKeyEnvelopes', () => {
    expect(KeyEnvelopeSchema.safeParse(envelope).success).toBe(true)
    for (const patch of [{ password: 'secret' }, { version: 2 }, { nonce: id }, { ciphertext: digest }]) expect(KeyEnvelopeSchema.safeParse({ ...envelope, ...patch }).success).toBe(false)
  })
  it('boundsChunksAndRejectsDuplicateOrNoncontiguousIndices', () => {
    expect(UploadStartSchema.safeParse(upload).success).toBe(true)
    for (const chunks of [[], [{ ...upload.chunks[0], index: 1 }], [upload.chunks[0], upload.chunks[0]], [{ ...upload.chunks[0], cipherBytes: 4194322 }], [{ ...upload.chunks[0], cipherBytes: 16 }]]) expect(UploadStartSchema.safeParse({ ...upload, chunks }).success).toBe(false)
  })
  it('requiresCompleteAtomicCommitAndRejectsDuplicateHeads', () => {
    const commit = { version: 1, mutationId: id, expected: [{ documentId: id, revisionId: null }], heads: [{ documentId: id, revisionId }], revisions: [revision] }
    expect(CommitRequestSchema.safeParse(commit).success).toBe(true)
    for (const patch of [{ password: 'secret' }, { heads: [] }, { expected: [...commit.expected, ...commit.expected] }, { revisions: [{ ...revision, plainBytes: 2 }] }, { revisions: [{ ...revision, dependencies: [{ documentId: id, revisionId }, { documentId: id, revisionId }] }] }]) expect(CommitRequestSchema.safeParse({ ...commit, ...patch }).success).toBe(false)
  })
  it('registersStagedBranchesWithoutPublishingHeads', () => {
    const staged = { version: 1, mutationId: id, expected: [], heads: [], revisions: [revision] }
    expect(CommitRequestSchema.safeParse(staged).success).toBe(true)
    expect(CommitRequestSchema.safeParse({ ...staged, revisions: [revision, { ...revision, revisionId: 'AgICAgICAgICAgICAgICAg' }] }).success).toBe(true)
    expect(CommitRequestSchema.safeParse({ ...staged, revisions: [revision, revision] }).success).toBe(false)
    expect(CommitRequestSchema.safeParse({ ...staged, revisions: [] }).success).toBe(false)
  })
  it('publishesReadyRevisionsWithExactExpectedHeadGuards', () => {
    const publish = { version: 1, mutationId: id, expected: [{ documentId: id, revisionId: null }], heads: [{ documentId: id, revisionId }], revisions: [] }
    expect(CommitRequestSchema.safeParse(publish).success).toBe(true)
    for (const expected of [[], [{ documentId: revisionId, revisionId: null }], [...publish.expected, ...publish.expected]]) expect(CommitRequestSchema.safeParse({ ...publish, expected }).success).toBe(false)
  })

  it('boundsAtomicPublicationsAndArchivedRegistrationsIndependently', () => {
    const idFor = (value: number) => btoa(String.fromCharCode(...new Uint8Array([value >> 8, value & 255, ...new Array<number>(14).fill(0)]))).replace(/=+$/, '')
    const revisions = Array.from({ length: 33 }, (_, index) => ({ ...revision, documentId: idFor(index), revisionId: idFor(index) }))
    const heads = revisions.map(({ documentId, revisionId }) => ({ documentId, revisionId }))
    const expected = heads.map(({ documentId }) => ({ documentId, revisionId: null }))
    const commit = { version: 1, mutationId: id, revisions: revisions.slice(0, 32), heads: heads.slice(0, 32), expected: expected.slice(0, 32) }
    expect(CommitRequestSchema.safeParse(commit).success).toBe(true)
    expect(CommitRequestSchema.safeParse({ ...commit, heads, expected }).success).toBe(false)
    expect(CommitRequestSchema.safeParse({ ...commit, revisions }).success).toBe(false)
    const parents = [idFor(1), idFor(2)]
    expect(CommitRequestSchema.safeParse({ ...commit, heads: [], expected: [], revisions: [{ ...revision, parents }] }).success).toBe(true)
    expect(CommitRequestSchema.safeParse({ ...commit, heads: [], expected: [], revisions: [{ ...revision, parents: [...parents, idFor(3)] }] }).success).toBe(false)
  })
  it('rejects oversized revision collections before reading revision bodies', () => {
    // Byte caps do not bound issue-object allocation after invalid revisions are traversed
    const revisions = Array.from({ length: maxChangedHeads + 1 }, () => ({ get documentId() { throw new Error('Revision body was parsed before the collection bound') } }))
    const result = CommitRequestSchema.safeParse({ version: 1, mutationId: id, expected: [], heads: [], revisions })
    if (result.success) throw new Error('An oversized revision collection was accepted')
    expect(result.error.issues).toEqual([expect.objectContaining({ code: 'too_big', path: ['revisions'] })])
  })
  it('keepsStagingAndHeadPublicationDistinctInChangePages', () => {
    const staging = { sequence: 1, mutationId: id, heads: [], revisions: [revision] }
    const publish = { sequence: 2, mutationId: revisionId, heads: [{ documentId: id, revisionId }], revisions: [] }
    const page = { version: 1, mode: 'incremental', watermark: 2, publicationEpoch: 1, cursor: 'authenticated-cursor', hasMore: false, groups: [staging, publish] }
    expect(ChangePageSchema.safeParse(page).success).toBe(true)
    expect(ChangePageSchema.safeParse({ ...page, groups: [{ sequence: 1, mutationId: id, revisions: [revision] }] }).success).toBe(false)
    expect(ChangePageSchema.safeParse({ ...page, groups: [{ ...staging, revisions: [] }] }).success).toBe(false)
  })

  it('chargesHeadOnlyGroupsAgainstTheChangePageBudget', () => {
    const heads = Array.from({ length: 32 }, (_, index) => ({ documentId: btoa(String.fromCharCode(...new Uint8Array(16).fill(index))).replace(/=+$/, ''), revisionId }))
    const group = { sequence: 1, mutationId: id, heads, revisions: [] }
    const groups = [group, { ...group, sequence: 2 }, { ...group, sequence: 3 }, { ...group, sequence: 4, heads: heads.slice(0, 4) }]
    const page = { version: 1, mode: 'initial', watermark: 4, publicationEpoch: 1, cursor: 'authenticated-cursor', hasMore: false, groups }
    expect(ChangePageSchema.safeParse(page).success).toBe(true)
    expect(ChangePageSchema.safeParse({ ...page, groups: [...groups.slice(0, 3), { ...groups[3], heads: heads.slice(0, 5) }] }).success).toBe(false)
  })

})

const transition = { version: 1, kind: 'mutation-transition', accountId: id, mutationId: id, requestDigest: digest, receipt: { version: 1, mutationId: id, sequence: 1, publicationEpoch: 1, heads: [{ documentId: id, revisionId }] }, previousPublicationEpoch: 0, documents: [{ documentId: id, before: null, after: revisionId }] }
it('validates physical transition identity, epochs and receipt outputs without changing v1', () => {
  expect(MutationTransitionResponseSchema.safeParse(transition).success).toBe(true)
  for (const patch of [{ version: 2 }, { extra: true }, { requestDigest: id }, { mutationId: revisionId }, { previousPublicationEpoch: 2 }, { previousPublicationEpoch: -1 }, { receipt: { ...transition.receipt, sequence: 0 } }, { receipt: { ...transition.receipt, publicationEpoch: 2 } }, { documents: [] }, { documents: [...transition.documents, ...transition.documents] }, { documents: [{ ...transition.documents[0], after: null }] }]) expect(MutationTransitionResponseSchema.safeParse({ ...transition, ...patch }).success).toBe(false)
  for (const reason of ['unknown-mutation', 'history-unavailable']) expect(MutationTransitionResponseSchema.safeParse({ version: 1, kind: 'mutation-transition-unavailable', mutationId: id, reason }).success).toBe(true)
  expect(MutationTransitionResponseSchema.safeParse({ version: 1, kind: 'mutation-transition-unavailable', mutationId: id, reason: 'unknown-mutation', documents: [] }).success).toBe(false)
  for (const documents of [[], [id, id], ['AAAAAAAAAAAAAAAAAAAAAB'], Array(33).fill(id)]) expect(MutationTransitionDocumentsSchema.safeParse(documents).success).toBe(false)
})
it('fits unique maximum-width successful transition in its response budget', () => {
  const documents = Array.from({ length: 32 }, (_, i) => ({ documentId: btoa(String.fromCharCode(...new Uint8Array(16).fill(i))).replace(/=+$/, ''), before: id, after: revisionId }))
  const value = { ...transition, previousPublicationEpoch: Number.MAX_SAFE_INTEGER - 1, documents, receipt: { ...transition.receipt, sequence: Number.MAX_SAFE_INTEGER, publicationEpoch: Number.MAX_SAFE_INTEGER, heads: documents.map(({ documentId, after }) => ({ documentId, revisionId: after })) } }
  expect(MutationTransitionResponseSchema.safeParse(value).success).toBe(true)
  expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThanOrEqual(maxMutationTransitionResponseBytes)
})

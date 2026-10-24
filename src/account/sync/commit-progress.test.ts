import { expect, it } from 'vitest'
import { checkCommitProgress, commitRequestDigest } from './commit-progress'

const mutationId = 'AAAAAAAAAAAAAAAAAAAAAA', workId = 'BBBBBBBBBBBBBBBBBBBBBA'
it('onlyAdvancingExactUnexpiredWorkCanContinueWithoutConsumingFailureBudget', async () => {
  const request = JSON.stringify({ version: 1, mutationId, revisions: [], heads: [{ documentId: mutationId, revisionId: workId }], expected: [{ documentId: mutationId, revisionId: null }] }), digest = await commitRequestDigest(request)
  const first = { mutationId, requestDigest: digest, workId, expiresAt: 10_000, processed: 48 }
  expect(await checkCommitProgress(request, undefined, first, 100)).toBe(true)
  expect(await checkCommitProgress(request, first, { ...first, processed: 96 }, 200)).toBe(true)
  for (const next of [first, { ...first, processed: 47 }, { ...first, workId: 'CCCCCCCCCCCCCCCCCCCCCA' }]) expect(await checkCommitProgress(request, first, next, 200)).toBe(false)
  expect(await checkCommitProgress(request, first, { ...first, processed: 96 }, 10_000)).toBe(false)
  for (const next of [{ ...first, mutationId: workId }, { ...first, requestDigest: 'A'.repeat(43) }, { ...first, expiresAt: 20_000 }, { ...first, processed: -1 }, { ...first, extra: true }]) await expect(checkCommitProgress(request, first, next, 200)).rejects.toThrow('INTEGRITY_FAILED')
})

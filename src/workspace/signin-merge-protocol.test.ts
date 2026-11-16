import { expect, it } from 'vitest'
import { accountLocalId } from './account-cache'
import { assertSigninMergeBudget, encodeSigninMergeManifest, SigninMergeTicketSchema, SIGNIN_MERGE_LIMITS } from './signin-merge-protocol'

it('admits the exact merge resource bounds and refuses overflow before allocation', () => {
  expect(() => assertSigninMergeBudget(SIGNIN_MERGE_LIMITS.manifestBytes, SIGNIN_MERGE_LIMITS.records, SIGNIN_MERGE_LIMITS.observationBytes)).not.toThrow()
  for (const values of [[SIGNIN_MERGE_LIMITS.manifestBytes + 1, 0, 0], [0, SIGNIN_MERGE_LIMITS.records + 1, 0], [0, 0, SIGNIN_MERGE_LIMITS.observationBytes + 1], [-1, 0, 0], [0, Infinity, 0]]) expect(() => assertSigninMergeBudget(...values as [number, number, number])).toThrow('SIGNIN_MERGE_RESOURCE_LIMIT')
})
it('refuses incomplete and foreign ticket envelope fields', () => {
  const value = { version: 1, operationId: accountLocalId(), copyId: accountLocalId(), manifest: { documentId: accountLocalId(), revisionId: accountLocalId() } }
  expect(SigninMergeTicketSchema.safeParse(value).success).toBe(false)
  expect(SigninMergeTicketSchema.safeParse({ ...value, workspace: {} }).success).toBe(false)
})

it('bounds actual JSON encoding before allocation while retaining exact escaping and Unicode', () => {
  const value = { absent: undefined, text: 'ASCII \" \\ \n \u0001 \uD800 \uDFFF \uD83D\uDE00 é 日本語', nested: [1, -0, true, null] }
  const bytes = encodeSigninMergeManifest(value)
  expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(value))
  expect(() => encodeSigninMergeManifest('x'.repeat(SIGNIN_MERGE_LIMITS.manifestBytes))).toThrow('SIGNIN_MERGE_RESOURCE_LIMIT')
})

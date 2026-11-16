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

it('reports only real guard failures with exact bounded numeric dimensions', async () => {
  const { signinMergeResourceFailure, SigninMergeResourceFailureSchema } = await import('./signin-merge-protocol')
  const fail = (values: [number, number, number]) => { try { assertSigninMergeBudget(...values); throw new Error('Expected real budget refusal') } catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('SIGNIN_MERGE_RESOURCE_LIMIT'); return signinMergeResourceFailure(error) } }
  expect(fail([SIGNIN_MERGE_LIMITS.manifestBytes + 1, 0, 0])).toEqual({ dimension: 'manifestBytes', value: SIGNIN_MERGE_LIMITS.manifestBytes + 1, limit: SIGNIN_MERGE_LIMITS.manifestBytes, basis: 'counted-byte-prefix' })
  expect(fail([0, SIGNIN_MERGE_LIMITS.records + 1, 0])).toEqual({ dimension: 'records', value: SIGNIN_MERGE_LIMITS.records + 1, limit: SIGNIN_MERGE_LIMITS.records, basis: 'record-cardinality' })
  const bytes = fail([0, 2, SIGNIN_MERGE_LIMITS.observationBytes + 1])!
  expect(bytes).toEqual({ dimension: 'observationBytes', value: SIGNIN_MERGE_LIMITS.observationBytes + 1, limit: SIGNIN_MERGE_LIMITS.observationBytes, basis: 'counted-byte-prefix', records: 2 })
  expect(Object.isFrozen(bytes)).toBe(true)
  expect(fail([-1, 0, 0])).toBeUndefined()
  expect(fail([0, Infinity, 0])).toBeUndefined()
  expect(fail([NaN, 0, 0])).toBeUndefined()
  expect(fail([0, 1.5, 0])).toBeUndefined()
  expect(fail([SIGNIN_MERGE_LIMITS.manifestBytes + 1, SIGNIN_MERGE_LIMITS.records + 1, 0])?.dimension).toBe('manifestBytes')
  expect(signinMergeResourceFailure(new Error('SIGNIN_MERGE_RESOURCE_LIMIT'))).toBeUndefined()
  expect(signinMergeResourceFailure({ dimension: 'records', value: 99999 })).toBeUndefined()
  expect(SigninMergeResourceFailureSchema.safeParse({ ...bytes, label: 'private' }).success).toBe(false)
  expect(SigninMergeResourceFailureSchema.safeParse({ ...bytes, value: NaN }).success).toBe(false)
  expect(SigninMergeResourceFailureSchema.safeParse({ ...bytes, limit: 1 }).success).toBe(false)
  expect(SigninMergeResourceFailureSchema.safeParse({ ...bytes, value: bytes.limit }).success).toBe(false)
  let deep: unknown = null
  for (let index = 0; index < 66; index++) deep = [deep]
  for (const unsupported of ['x'.repeat(SIGNIN_MERGE_LIMITS.manifestBytes), deep]) {
    expect(() => encodeSigninMergeManifest(unsupported)).toThrow('SIGNIN_MERGE_RESOURCE_LIMIT')
    try { encodeSigninMergeManifest(unsupported) } catch (error) { expect(signinMergeResourceFailure(error)).toBeUndefined() }
  }
})

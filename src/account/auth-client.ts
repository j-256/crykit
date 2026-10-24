import { withAuthLock } from './auth-coordinator'
import { captureProfileEpoch } from './profile'
import type { z } from 'zod'
import { AccountMetadataSchema, CredentialCommitSchema, CredentialReceiptSchema, CredentialStartedSchema, EmailPendingSchema, EmailReceiptSchema, OpaqueIdSchema, ReauthReceiptSchema, UsernameReceiptSchema, ApiErrorSchema, credentialIdForRole, opaqueIdBytes, LoginReceiptSchema, LoginStartedSchema, SignupPendingSchema, SignupStartedSchema } from './protocol'
import * as opaque from './crypto/opaque'
import { deriveWrappingKey, unwrapSecret, wrapSecret } from './crypto/envelopes'
import { accountKeyBytes, type AccountKey } from './crypto/types'
import { validatePassword } from './password-policy'
import { createRecoveryCode, parseRecoveryCode, recoveryCredentialSecret } from './recovery'
import { serviceNoticeRequest, ServiceRequestError as AccountRequestError } from './service-notice'

export interface UnlockResult {
  readonly accountId: string; readonly username: string; readonly key: AccountKey
  readonly sessionId: string; readonly deviceId: string; readonly csrf: string; readonly authenticatedAt: number
}
function password(value: string): void { if (!validatePassword(value).valid) throw new Error('INVALID_PASSWORD') }
function randomId(): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(opaqueIdBytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export async function accountRequest<T>(path: string, input: object | undefined, schema: z.ZodType<T>, csrf?: string, method = input ? 'POST' : 'GET', signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const notice = serviceNoticeRequest(`account:${path}`, signal)
  const init = { ...(signal ? { signal } : {}), method, credentials: 'same-origin' as const, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }
  const response = await fetch(`/api/v1/${path}`, init)
  // Fence late transport/body results even when a caller's fetch adapter ignores cancellation
  signal?.throwIfAborted()
  if (response.status === 429) {
    // Edge rejection precedes CryKit and need not use the account JSON protocol
    void response.body?.cancel().catch(() => {})
    throw notice.failure(response, 'RATE_LIMITED')
  }
  const value: unknown = await response.json()
  signal?.throwIfAborted()
  if (!response.ok) { const error = ApiErrorSchema.parse(value).error; throw notice.failure(response, error.code, error.requestId, error.retryAfterSeconds) }
  notice.succeeded()
  return schema.parse(value)
}
function post<T>(path: string, input: object, schema: z.ZodType<T>): Promise<T> { return accountRequest(`auth/${path}`, input, schema) }
export async function registerAccount(input: { email: string; username: string; password: string; remember: boolean }): Promise<{ transactionId: string; pending: true }> {
  password(input.password)
  const start = await opaque.startRegistration(input.password)
  const response = await post('signup/start', { email: input.email, username: input.username, registrationRequest: start.request }, SignupStartedSchema)
  if (response.credentialId !== credentialIdForRole(response.accountId, 'password')) throw new Error('AUTH_FAILED')
  const registered = await opaque.finishRegistration(start.state, response.registrationResponse, input.password, response.credentialId)
  const key = crypto.getRandomValues(new Uint8Array(accountKeyBytes))
  let wrappingKey: Uint8Array | undefined
  try {
    wrappingKey = await deriveWrappingKey(registered.exportKey, response.accountId, 'password')
    const accountEnvelope = await wrapSecret(key, wrappingKey, [1, response.accountId])
    // A pending registration never keeps a data key or claims an unlocked session
    return await post('signup/finish', { attemptId: response.attemptId, transactionId: randomId(), registrationRecord: registered.record, accountEnvelope, remember: input.remember }, SignupPendingSchema)
  } finally { key.fill(0); registered.exportKey.fill(0); wrappingKey?.fill(0) }
}
export async function loginAccount(input: { email: string; password: string; remember: boolean }): Promise<UnlockResult> {
  const epoch = captureProfileEpoch()
  password(input.password)
  const start = await opaque.startLogin(input.password)
  const response = await post('login/start', { email: input.email, role: 'password', startLoginRequest: start.request }, LoginStartedSchema)
  const completed = await opaque.finishLogin(start.state, response.loginResponse, input.password, response.credentialId)
  let wrappingKey: Uint8Array | undefined
  let key: AccountKey | undefined
  try {
    return await withAuthLock(async run => {
      const receipt = await run(signal => accountRequest('auth/login/finish', { attemptId: response.attemptId, finishLoginRequest: completed.request, remember: input.remember }, LoginReceiptSchema, undefined, 'POST', signal))
      // Bind the returned envelope to the authenticated stable credential identity
      if (response.credentialId !== credentialIdForRole(receipt.accountId, 'password')) throw new Error('AUTH_FAILED')
      wrappingKey = await deriveWrappingKey(completed.exportKey, receipt.accountId, 'password')
      key = await unwrapSecret(receipt.accountEnvelope, wrappingKey, [1, receipt.accountId])
      try {
        const actual = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
        if (actual.accountId !== receipt.accountId || actual.sessionId !== receipt.sessionId) throw new Error('AUTH_SESSION_UNCERTAIN')
        epoch.assertCurrent()
        return { accountId: receipt.accountId, username: receipt.username, key, sessionId: actual.sessionId, deviceId: actual.deviceId, csrf: actual.csrf, authenticatedAt: actual.authenticatedAt }
      } catch (error) { key.fill(0); throw error }
    }, epoch)
  } catch (error) {
    // The coordinator may reject after its callback returns; the undelivered result still owns this key
    key?.fill(0); throw error
  } finally { completed.exportKey.fill(0); wrappingKey?.fill(0) }
}

export async function accountMetadata(unlocked: UnlockResult, signal?: AbortSignal) {
  const metadata = await accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal)
  if (metadata.accountId !== unlocked.accountId || metadata.sessionId !== unlocked.sessionId) throw new AccountRequestError('AUTH_REQUIRED')
  return metadata
}
export async function loginWithRecovery(email: string, code: string, remember: boolean): Promise<UnlockResult> {
  const epoch = captureProfileEpoch()
  const secret = await parseRecoveryCode(code)
  let wrappingKey: Uint8Array | undefined
  let key: AccountKey | undefined
  let exportKey: Uint8Array | undefined
  try {
    const credentialSecret = recoveryCredentialSecret(secret)
    const start = await opaque.startLogin(credentialSecret)
    const response = await post('login/start', { email, role: 'recovery', startLoginRequest: start.request }, LoginStartedSchema)
    const completed = await opaque.finishLogin(start.state, response.loginResponse, credentialSecret, response.credentialId)
    exportKey = completed.exportKey
    return await withAuthLock(async run => {
      const receipt = await run(signal => accountRequest('auth/login/finish', { attemptId: response.attemptId, finishLoginRequest: completed.request, remember }, LoginReceiptSchema, undefined, 'POST', signal))
      if (response.credentialId !== credentialIdForRole(receipt.accountId, 'recovery')) throw new Error('AUTH_FAILED')
      // Authentication alone does not authorize replacement UI; the recovery secret must also unwrap the root
      wrappingKey = await deriveWrappingKey(secret, receipt.accountId, 'recovery')
      key = await unwrapSecret(receipt.accountEnvelope, wrappingKey, [1, receipt.accountId])
      try {
        const actual = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
        if (actual.accountId !== receipt.accountId || actual.sessionId !== receipt.sessionId) throw new Error('AUTH_SESSION_UNCERTAIN')
        epoch.assertCurrent()
        return { accountId: receipt.accountId, username: receipt.username, key, sessionId: actual.sessionId, deviceId: actual.deviceId, csrf: actual.csrf, authenticatedAt: actual.authenticatedAt }
      } catch (error) { key.fill(0); throw error }
    }, epoch)
  } catch (error) {
    // Keep ownership through coordinator settlement, including its final generation fence
    key?.fill(0); throw error
  } finally { secret.fill(0); wrappingKey?.fill(0); exportKey?.fill(0) }
}
export class CredentialChangeUnconfirmedError extends Error {
  readonly transactionId: string
  constructor(transactionId: string) { super('CREDENTIAL_CHANGE_UNCONFIRMED'); this.transactionId = transactionId }
}
const pendingCredentialLifetimeMs = 10 * 60 * 1000
interface PendingCredential {
  readonly accountId: string; readonly sessionId: string; readonly expiresAt: number
  readonly input: z.infer<typeof CredentialCommitSchema>; readonly recoveryDisplay?: string
}
const pendingCredentials = new Map<string, PendingCredential>()
let credentialPreparationGeneration = 0
export function clearPendingCredentialChanges(accountId?: string): void {
  // Also cancel in-flight derivation so it cannot repopulate the map after cleanup
  credentialPreparationGeneration++
  // Lock, sign-out and profile switches drop these memory-only references, including recovery displays
  // This cannot cancel or reverse a server commit; cleared or expired state requires fresh sign-in if uncertain
  for (const [id, pending] of pendingCredentials) if (!accountId || pending.accountId === accountId) pendingCredentials.delete(id)
}
function expirePendingCredentials(): void {
  for (const [id, pending] of pendingCredentials) if (pending.expiresAt <= Date.now()) pendingCredentials.delete(id)
}
async function confirmCredential(unlocked: UnlockResult, pending: PendingCredential, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const input = pending.input
  const commit = () => accountRequest('account/credentials/commit', input, CredentialReceiptSchema, unlocked.csrf, 'POST', signal)
  const confirm = (receipt: z.infer<typeof CredentialReceiptSchema>) => {
    if (receipt.transactionId !== input.transactionId || receipt.credentialRevision !== input.expectedCredentialRevision + 1) throw new Error('INVALID_CREDENTIAL_RECEIPT')
  }
  try { confirm(await commit()) }
  catch (error) {
    signal?.throwIfAborted()
    if (error instanceof AccountRequestError && error.message !== 'SERVICE_UNAVAILABLE') throw error
    try {
      confirm(await accountRequest(`account/transactions/${input.transactionId}`, undefined, CredentialReceiptSchema, undefined, 'GET', signal))
      // Lookup discovers a receipt; exact-body replay proves it belongs to this request, not a reused ID
      confirm(await commit())
    } catch (reconcileError) {
      if (reconcileError instanceof AccountRequestError && reconcileError.message === 'IDEMPOTENCY_MISMATCH') throw reconcileError
      throw new CredentialChangeUnconfirmedError(input.transactionId)
    }
  }
}
export async function resumeCredentialChange(unlocked: UnlockResult, transactionId: string, signal?: AbortSignal): Promise<{ role: 'password' } | { role: 'recovery'; display: string }> {
  OpaqueIdSchema.parse(transactionId)
  expirePendingCredentials()
  const pending = pendingCredentials.get(transactionId)
  if (!pending) throw new Error('CREDENTIAL_CHANGE_NOT_PENDING')
  if (pending.accountId !== unlocked.accountId || pending.sessionId !== unlocked.sessionId) throw new Error('AUTH_REQUIRED')
  try { await accountMetadata(unlocked, signal) } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof AccountRequestError) throw error
    throw new CredentialChangeUnconfirmedError(transactionId)
  }
  expirePendingCredentials()
  if (pendingCredentials.get(transactionId) !== pending) throw new Error('CREDENTIAL_CHANGE_LOCAL_STATE_CLEARED')
  try { await confirmCredential(unlocked, pending, signal) }
  catch (error) {
    if (!(error instanceof CredentialChangeUnconfirmedError)) pendingCredentials.delete(transactionId)
    throw error
  }
  if (pendingCredentials.get(transactionId) !== pending) throw new Error('CREDENTIAL_CHANGE_LOCAL_STATE_CLEARED')
  pendingCredentials.delete(transactionId)
  return pending.input.role === 'recovery' ? { role: 'recovery', display: pending.recoveryDisplay! } : { role: 'password' }
}
async function activateCredential(unlocked: UnlockResult, input: z.infer<typeof CredentialCommitSchema>, generation: number, recoveryDisplay?: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (generation !== credentialPreparationGeneration) throw new Error('CREDENTIAL_CHANGE_LOCAL_STATE_CLEARED')
  pendingCredentials.set(input.transactionId, { input, accountId: unlocked.accountId, sessionId: unlocked.sessionId, expiresAt: Date.now() + pendingCredentialLifetimeMs, recoveryDisplay })
  await resumeCredentialChange(unlocked, input.transactionId, signal)
}
async function prepareCredential(unlocked: UnlockResult, secret: string, role: 'password' | 'recovery', transactionId: string, signal?: AbortSignal) {
  OpaqueIdSchema.parse(transactionId)
  expirePendingCredentials()
  if (pendingCredentials.has(transactionId)) throw new Error('CREDENTIAL_CHANGE_PENDING')
  const metadata = await accountMetadata(unlocked, signal)
  const revision = role === 'password' ? metadata.credentials.passwordRevision : metadata.credentials.recoveryRevision ?? 0
  const start = await opaque.startRegistration(secret)
  const response = await accountRequest('account/credentials/start', { transactionId, role, registrationRequest: start.request }, CredentialStartedSchema, unlocked.csrf, 'POST', signal)
  if (response.credentialId !== credentialIdForRole(unlocked.accountId, role)) throw new Error('AUTH_FAILED')
  return { registered: await opaque.finishRegistration(start.state, response.registrationResponse, secret, response.credentialId), revision }
}
export async function changePassword(unlocked: UnlockResult, passwordValue: string, transactionId: string, signal?: AbortSignal): Promise<void> {
  password(passwordValue)
  const generation = credentialPreparationGeneration
  const { registered, revision } = await prepareCredential(unlocked, passwordValue, 'password', transactionId, signal)
  let wrappingKey: Uint8Array | undefined
  try {
    wrappingKey = await deriveWrappingKey(registered.exportKey, unlocked.accountId, 'password')
    const accountEnvelope = await wrapSecret(unlocked.key, wrappingKey, [1, unlocked.accountId])
    await activateCredential(unlocked, { transactionId, role: 'password', expectedCredentialRevision: revision, registrationRecord: registered.record, accountEnvelope }, generation, undefined, signal)
    // A04/A05 may update the captured profile's offline envelope only after this confirmed return
  } finally { wrappingKey?.fill(0); registered.exportKey.fill(0) }
}
export async function replaceRecoveryCode(unlocked: UnlockResult, transactionId: string, signal?: AbortSignal): Promise<string> {
  const generation = credentialPreparationGeneration
  const code = await createRecoveryCode(unlocked.key, unlocked.accountId)
  const { registered, revision } = await prepareCredential(unlocked, code.credentialSecret, 'recovery', transactionId, signal)
  try {
    await activateCredential(unlocked, { transactionId, role: 'recovery', expectedCredentialRevision: revision, registrationRecord: registered.record, accountEnvelope: code.envelope }, generation, code.display, signal)
    return code.display
  } finally { registered.exportKey.fill(0) }
}
export async function reauthenticateAccount(unlocked: UnlockResult, input: { role: 'password' | 'recovery'; secret: string }, signal?: AbortSignal): Promise<{ authenticatedAt: number }> {
  const recovery = input.role === 'recovery' ? await parseRecoveryCode(input.secret) : undefined
  const credentialSecret = recovery ? recoveryCredentialSecret(recovery) : input.secret
  let exportKey: Uint8Array | undefined
  try {
    const start = await opaque.startLogin(credentialSecret)
    const response = await accountRequest('account/reauth/start', { role: input.role, startLoginRequest: start.request }, LoginStartedSchema, unlocked.csrf, 'POST', signal)
    if (response.credentialId !== credentialIdForRole(unlocked.accountId, input.role)) throw new Error('AUTH_FAILED')
    const completed = await opaque.finishLogin(start.state, response.loginResponse, credentialSecret, response.credentialId)
    exportKey = completed.exportKey
    return await accountRequest('account/reauth/finish', { attemptId: response.attemptId, finishLoginRequest: completed.request }, ReauthReceiptSchema, unlocked.csrf, 'POST', signal)
  } finally { recovery?.fill(0); exportKey?.fill(0) }
}
export async function changeUsername(unlocked: UnlockResult, username: string, transactionId: string, expectedRevision: number, signal?: AbortSignal) {
  return accountRequest('account/username', { transactionId, username, expectedRevision }, UsernameReceiptSchema, unlocked.csrf, 'PATCH', signal)
}
export async function startEmailChange(unlocked: UnlockResult, email: string, transactionId: string, expectedRevision: number, signal?: AbortSignal) {
  return accountRequest('account/email/start', { transactionId, email, expectedRevision }, EmailPendingSchema, unlocked.csrf, 'POST', signal)
}
export async function confirmEmailChange(unlocked: UnlockResult, capability: string, signal?: AbortSignal) {
  return accountRequest('account/email/confirm', { capability }, EmailReceiptSchema, unlocked.csrf, 'POST', signal)
}

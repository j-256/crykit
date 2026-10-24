import { base64urlSchema, credentialIdForRole, digestBytes, opaqueIdBytes, type ApiErrorCode } from '../../src/account/protocol'
import type { ServiceContext } from '../context'
import { runGuardedBatch, type SqlGuard } from '../db/guarded-batch'
import { ApiFailure } from '../http'

const reservedNames = new Set(['admin', 'administrator', 'crykit', 'crystal_kit', 'support', 'system', 'api', 'account', 'accounts', 'login', 'logout', 'signup', 'settings', 'mods', 'teams', 'builds', 'share', 'staff', 'owner'])
export const pendingRegistrationMs = 24 * 60 * 60 * 1000
export const verificationMs = 30 * 60 * 1000
export const loginAttemptMs = 10 * 60 * 1000
export function normalizedEmail(email: string): string { return email.trim().toLowerCase() }
export function assertUsername(username: string): void { if (reservedNames.has(username)) throw new ApiFailure('INVALID_REQUEST') }
export function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export function randomId(): string { return encode(crypto.getRandomValues(new Uint8Array(opaqueIdBytes))) }
export function randomToken(): string { return encode(crypto.getRandomValues(new Uint8Array(digestBytes))) }
export async function keyedHash(secret: string | undefined, purpose: string, value: string): Promise<string> {
  if (!base64urlSchema(digestBytes).safeParse(secret).success) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const bytes = Uint8Array.from(atob(secret!.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify([1, purpose, value])))))
}
export async function dummyCredentialId(email: string, role: 'password' | 'recovery', context: ServiceContext): Promise<string> {
  // Stable target identity prevents comparing repeated starts to discover accounts
  // This dedicated recoverable PRF secret never allocates an account or grants authority
  const secret = context.env.DUMMY_IDENTITY_SECRET
  if ([context.env.SESSION_SECRET, context.env.CAPABILITY_SECRET, context.env.CURSOR_SECRET].includes(secret)) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const digest = await keyedHash(secret, 'dummy-identity', normalizedEmail(email))
  const bytes = Uint8Array.from(atob(digest.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  return credentialIdForRole(encode(bytes.slice(0, opaqueIdBytes)), role)
}
export async function guarded(context: ServiceContext, guard: SqlGuard, statements: readonly D1PreparedStatement[], denied: ApiErrorCode = 'INVALID_REQUEST'): Promise<void> {
  try { await runGuardedBatch(context.env.DB!, guard, statements) } catch (error) {
    if (String(error).includes('CHECK constraint failed: transaction_guard_passed')) throw new ApiFailure(denied)
    context.emit({ operation: 'auth', stage: 'database', code: 'SERVICE_UNAVAILABLE' })
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
}

import { DeletionStatusSchema, deletionConfirmation, deletionStatusHeader, type DeletionStatus } from './deletion-protocol'
export { deletionConfirmation, type DeletionStatus } from './deletion-protocol'
import { base64urlSchema, digestBytes, ApiErrorSchema } from './protocol'
import { assertActiveProfile, invalidateProfile, profileSignal, withProfileSession, type ProfileToken } from './profile'

const statusKey = 'crykit-deletion-status-v1'
const originalAccountKey = 'crykit-deletion-account-v1'
// Tab-scoped recovery grant is independent of encrypted account/session backups and never enters a URL
export function hasDeletionStatus(): boolean {
  try { return base64urlSchema(digestBytes).safeParse(sessionStorage.getItem(statusKey)).success } catch { return false }
}
async function request(capability: string, init?: RequestInit): Promise<DeletionStatus> {
  const response = await fetch('/api/v1/account/deletion', { ...init, credentials: 'same-origin', cache: 'no-store', headers: {...init?.headers, [deletionStatusHeader]:capability} })
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(ApiErrorSchema.parse(value).error.code)
  return DeletionStatusSchema.parse(value)
}
export async function readDeletionStatus(): Promise<DeletionStatus> {
  const capability = sessionStorage.getItem(statusKey)
  if (!base64urlSchema(digestBytes).safeParse(capability).success) throw new Error('NOT_FOUND')
  return request(capability!)
}
export function forgetDeletionStatus(): void { sessionStorage.removeItem(statusKey); sessionStorage.removeItem(originalAccountKey) }
export function canRetryDeletion(token?: ProfileToken): boolean {
  // Older capability-only grants remain readable but cannot safely infer an original owner
  try {
    const original = JSON.parse(sessionStorage.getItem(originalAccountKey) ?? 'null') as {accountId?:unknown;capability?:unknown}|null
    return !!token && hasDeletionStatus() && original?.accountId === token.accountId && original.capability === sessionStorage.getItem(statusKey)
  } catch { return false }
}
async function submit(token: ProfileToken, capability: string, confirmation: string): Promise<DeletionStatus> {
  return withProfileSession(token, unlocked => request(capability,{method:'POST',signal:profileSignal(token),headers:{'content-type':'application/json','x-csrf-token':unlocked.csrf},body:JSON.stringify({confirmation})}))
}
export async function retryDeletion(token: ProfileToken, confirmation: string): Promise<DeletionStatus> {
  if (confirmation !== deletionConfirmation) throw new Error('INVALID_REQUEST')
  assertActiveProfile(token)
  if (!canRetryDeletion(token)) throw new Error('DELETION_ORIGINAL_ACCOUNT_REQUIRED')
  const capability = sessionStorage.getItem(statusKey)!
  let result: DeletionStatus
  try { result = await request(capability) } catch (error) {
    assertActiveProfile(token)
    if (!(error instanceof Error) || error.message !== 'NOT_FOUND') throw error
    // A GET404 cannot exclude an in-flight original POST; replay its grant, never mint or rebind one
    result = await submit(token, capability, confirmation)
  }
  assertActiveProfile(token)
  invalidateProfile()
  return result
}
export async function deleteAccount(token: ProfileToken, confirmation: string): Promise<DeletionStatus> {
  if (confirmation !== deletionConfirmation) throw new Error('INVALID_REQUEST')
  assertActiveProfile(token)
  if (hasDeletionStatus()) throw new Error('DELETION_STATUS_PENDING')
  const capability = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(digestBytes)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  // Persist before transport: the session can be revoked even when its response never reaches this tab
  sessionStorage.setItem(originalAccountKey,JSON.stringify({accountId:token.accountId,capability}))
  sessionStorage.setItem(statusKey,capability)
  let result: DeletionStatus
  try {
    result = await submit(token,capability,confirmation)
  } catch (error) {
    // A known precondition rejection is safe to correct; uncertain responses retain the status grant
    if (error instanceof Error && ['AUTH_REQUIRED','CSRF_FAILED','INVALID_REQUEST','NOT_FOUND','FORBIDDEN'].includes(error.message)) forgetDeletionStatus()
    throw error
  }
  assertActiveProfile(token)
  invalidateProfile()
  return result
}

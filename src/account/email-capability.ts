import { z } from 'zod'
import { accountRequest } from './auth-client'
import { DigestSchema, EmailPendingSchema } from './protocol'
import { confirmProfileEmail } from './management'
import type { ProfileToken } from './profile'

let pending: { kind: 'verify' | 'confirm-email'; capability: string } | undefined
// Intake runs before React/navigation and on later hash changes; capabilities never become route state
export function captureEmailCapability(): boolean {
  const match = /^#\/account\/(verify|confirm-email)\/(.*)$/.exec(window.location.hash)
  if (!match) return false
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/settings/account`)
  const parsed = DigestSchema.safeParse(match[2])
  pending = parsed.success ? { kind: match[1] as 'verify' | 'confirm-email', capability: parsed.data } : undefined
  return true
}
export function emailConfirmationKind() { return pending?.kind }
export function clearEmailCapability(): void { pending = undefined }
export async function confirmPendingEmail(token?: ProfileToken): Promise<void> {
  const captured = pending
  if (!captured) throw new Error('EMAIL_LINK_EXPIRED')
  if (captured.kind === 'verify') await accountRequest('auth/verify', { capability: captured.capability }, z.strictObject({ verified: z.literal(true) }))
  else { if (!token) throw new Error('AUTH_REQUIRED'); await confirmProfileEmail(token, captured.capability) }
  if (pending === captured) pending = undefined
}
export async function resendVerification(email: string): Promise<void> {
  await accountRequest('auth/resend', { email }, EmailPendingSchema)
}

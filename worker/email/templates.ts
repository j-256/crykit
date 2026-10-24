import { z } from 'zod'
import { maxCapabilityCharacters, maxRequestIdCharacters } from '../../src/account/protocol'
import { ApiFailure } from '../http'
import type { ServiceEmail } from './types'

export const ServiceEmailSchema = z.strictObject({
  kind: z.enum(['verify-account', 'verify-email', 'security-notice', 'admin-invite']),
  recipient: z.email().max(254).regex(/^[\x21-\x7e]+$/),
  capability: z.string().min(22).max(maxCapabilityCharacters).regex(/^[A-Za-z0-9_-]+$/).optional(),
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  correlationId: z.string().min(1).max(maxRequestIdCharacters).regex(/^[A-Za-z0-9_.:-]+$/),
}).refine(message => message.kind === 'security-notice' ? message.capability === undefined : message.capability !== undefined && message.expiresAt !== undefined)

export function validateServiceEmail(message: ServiceEmail): ServiceEmail {
  const parsed = ServiceEmailSchema.safeParse(message)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  return parsed.data
}

export function renderServiceEmail(message: ServiceEmail, origin: string): { readonly subject: string; readonly text: string } {
  validateServiceEmail(message)
  // Capability fragments reach only the confirmation UI; GET never consumes authority
  // Route owners must clear the fragment before an explicit confirmation POST
  const routes = {
    'verify-account': '/#/account/verify/', 'verify-email': '/#/account/confirm-email/',
    'admin-invite': '/admin/accept-invitation/#',
  } as const
  let url: URL
  try { url = new URL(origin) } catch { throw new ApiFailure('SERVICE_UNAVAILABLE') }
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new ApiFailure('SERVICE_UNAVAILABLE')
  switch (message.kind) {
    case 'verify-account': return { subject: 'Verify your Crystal Kit account', text: `Confirm this email address for your Crystal Kit account:\n\n${origin}${routes[message.kind]}${message.capability}\n\nOpen the link, then choose Confirm. Email verification does not unlock encrypted data. If you did not request this, ignore this message.` }
    case 'verify-email': return { subject: 'Confirm your Crystal Kit email address', text: `Confirm your new Crystal Kit email address:\n\n${origin}${routes[message.kind]}${message.capability}\n\nOpen the link, then choose Confirm while signed in. If you did not request this change, keep your existing address and review your account security.` }
    case 'admin-invite': return { subject: 'Crystal Kit operator invitation', text: `You have been invited to operate Crystal Kit:\n\n${origin}${routes[message.kind]}${message.capability}\n\nThe owner must first allow your invited email through the admin Access policy. Open the link, sign in with that email, then explicitly accept the invitation within 24 hours. If you did not expect this invitation, ignore this message.` }
    case 'security-notice': return { subject: 'Crystal Kit account security notice', text: 'A security setting on your Crystal Kit account changed. Open Crystal Kit directly to review your account security. If you did not make this change, review your active devices and credentials. This message cannot unlock encrypted data.' }
  }
}

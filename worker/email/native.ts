import type { SendEmail } from '@cloudflare/workers-types/experimental'
import { z } from 'zod'
import { base64urlSchema } from '../../src/account/protocol'
import type { ServiceContext } from '../context'
import type { EmailTransport } from './types'
import { renderServiceEmail } from './templates'

export type EmailFailureDisposition = 'retryable' | 'permanent' | 'suppressed' | 'uncertain'
export type EmailFailureCode = 'RATE_LIMITED' | 'QUOTA_LIMITED' | 'SENDER_UNAVAILABLE' | 'RECIPIENT_NOT_ALLOWED' | 'RECIPIENT_SUPPRESSED' | 'INVALID_MESSAGE' | 'TRANSPORT_UNCERTAIN' | 'PAYLOAD_UNAVAILABLE' | 'BEFORE_SEND_FAILED'
export class EmailSendFailure extends Error {
  constructor(readonly code: EmailFailureCode, readonly disposition: EmailFailureDisposition, readonly retryAfterSeconds?: number) { super(code) }
}
const senderSchema = z.email().max(254).regex(/^[\x21-\x7e]+$/)
export const serviceEmailSecretBytes = 32
const maxEmailMessageIdCharacters = 256
export function validEmailMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxEmailMessageIdCharacters && !/[\x00-\x1f\x7f]/.test(value)
}

export function nativeEmailTransport(binding: SendEmail, sender: string, origin: string): EmailTransport {
  return {
    async send(message) {
      if (!senderSchema.safeParse(sender).success) throw new EmailSendFailure('SENDER_UNAVAILABLE', 'permanent')
      const rendered = renderServiceEmail(message, origin)
      try {
        // Pinned experimental SendEmail accepts a structured builder and returns messageId
        // No idempotency parameter exists, and acceptance is not delivery evidence
        const result = await binding.send({ from: sender, to: message.recipient, ...rendered })
        if (!result || !validEmailMessageId(result.messageId)) throw new EmailSendFailure('TRANSPORT_UNCERTAIN', 'uncertain')
        return { messageId: result.messageId }
      } catch (error) {
        // Only documented rejection codes establish an unsent boundary
        // Internal/delivery errors do not establish a known-unsent stage
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        switch (code) {
          case 'E_RECIPIENT_SUPPRESSED': throw new EmailSendFailure('RECIPIENT_SUPPRESSED', 'suppressed')
          case 'E_RATE_LIMIT_EXCEEDED': throw new EmailSendFailure('RATE_LIMITED', 'retryable')
          case 'E_DAILY_LIMIT_EXCEEDED': throw new EmailSendFailure('QUOTA_LIMITED', 'retryable')
          case 'E_SENDER_NOT_VERIFIED': case 'E_SENDER_DOMAIN_NOT_AVAILABLE': throw new EmailSendFailure('SENDER_UNAVAILABLE', 'permanent')
          case 'E_RECIPIENT_NOT_ALLOWED': throw new EmailSendFailure('RECIPIENT_NOT_ALLOWED', 'permanent')
          case 'E_VALIDATION_ERROR': case 'E_FIELD_MISSING': case 'E_CONTENT_TOO_LARGE': throw new EmailSendFailure('INVALID_MESSAGE', 'permanent')
          default: throw new EmailSendFailure('TRANSPORT_UNCERTAIN', 'uncertain')
        }
      }
    },
  }
}

export function serviceEmailAvailable(context: ServiceContext): boolean {
  const { env } = context
  // Headroom is an explicit operational gate, never inferred from owning a Paid plan
  return env.ACCOUNTS_ACTIVE === 'true' && env.EMAIL_SENDING_ACTIVE === 'true' && env.EMAIL_HEADROOM === 'available'
    && base64urlSchema(serviceEmailSecretBytes).safeParse(env.EMAIL_STATE_SECRET).success
    && ![env.SESSION_SECRET, env.CURSOR_SECRET, env.CAPABILITY_SECRET, env.DUMMY_IDENTITY_SECRET].includes(env.EMAIL_STATE_SECRET)
    && (!!context.emailTransport || !!env.NATIVE_EMAIL && senderSchema.safeParse(env.EMAIL_FROM).success && !!env.SERVICE_ORIGIN)
}

export function serviceEmailTransport(context: ServiceContext): EmailTransport | undefined {
  if (!serviceEmailAvailable(context)) return undefined
  if (context.emailTransport) return context.emailTransport
  return nativeEmailTransport(context.env.NATIVE_EMAIL!, context.env.EMAIL_FROM!, context.env.SERVICE_ORIGIN!)
}

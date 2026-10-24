import { EmailSendFailure } from '../email/native'
import type { EmailTransport } from '../email/types'

// Never import from production: the capture entry is reserved-domain local proof
export function capturedEmailTransport(binding: Fetcher | undefined, now: () => number): EmailTransport {
  return {
    async send(message) {
      if (!binding || !/^[^@]+@example\.(com|org|net)$/.test(message.recipient)) throw new EmailSendFailure('RECIPIENT_NOT_ALLOWED', 'permanent')
      const response = await binding.fetch('http://email/send', { method: 'POST', body: JSON.stringify(message) })
      if (!response.ok) {
        const header = response.headers.get('retry-after')
        const seconds = header && /^\d+$/.test(header) ? Number(header) : header ? Math.ceil((Date.parse(header) - now()) / 1000) : undefined
        const body = await response.json().catch(() => null) as { code?: string } | null
        if (response.status === 429) throw new EmailSendFailure(body?.code === 'QUOTA_LIMITED' ? 'QUOTA_LIMITED' : 'RATE_LIMITED', 'retryable', Number.isSafeInteger(seconds) && seconds! >= 0 ? seconds : undefined)
        if (response.status === 400 && body?.code === 'RECIPIENT_SUPPRESSED') throw new EmailSendFailure('RECIPIENT_SUPPRESSED', 'suppressed')
        throw new EmailSendFailure('TRANSPORT_UNCERTAIN', 'uncertain')
      }
      return await response.json() as { messageId: string }
    },
  }
}

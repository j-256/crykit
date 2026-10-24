export interface ServiceEmail {
  readonly kind: 'verify-account' | 'verify-email' | 'security-notice' | 'admin-invite'
  readonly recipient: string
  readonly capability?: string
  readonly expiresAt?: number
  readonly correlationId: string
}
export interface EmailTransport {
  send(message: ServiceEmail): Promise<{ readonly messageId: string }>
}

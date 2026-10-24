import { AdminCommandSchema, AdminPreviewSchema, AdminReceiptSchema, type AdminCommand, type AdminPreview, type AdminReceipt } from '../../account/admin-protocol'
import { ApiErrorSchema, type ApiErrorCode } from '../../account/protocol'

const API = '/api/admin/v1/'
export interface AdminSession { role: 'owner' | 'administrator'; csrf: string; sessionId: string; expiresAt: number; permissions: string[] }
export interface AccessSession { csrf: string; sessionId: string; expiresAt: number; invitationAcceptanceOnly: true }
export class AdminRequestError extends Error {
  constructor(readonly code: ApiErrorCode | 'NETWORK_UNCERTAIN', readonly requestId?: string, readonly actionId?: string, readonly diagnostic?: string) { super(code) }
}
export class AdminClient {
  private csrf: string | null = null
  private sessionId: string | null = null
  private expiresAt = 0
  private generation = 0
  private sessionLostListeners = new Set<() => void>()
  onSessionLost(listener: () => void): () => void { this.sessionLostListeners.add(listener); return () => this.sessionLostListeners.delete(listener) }
  private clearSession() {
    this.generation++
    this.csrf = null
    this.sessionId = null
    this.expiresAt = 0
    for (const listener of this.sessionLostListeners) listener()
  }
  private async request<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
    if (method === 'POST' && (!this.csrf || !this.sessionId || Date.now() >= this.expiresAt)) {
      this.clearSession()
      throw new AdminRequestError('AUTH_REQUIRED')
    }
    const generation = this.generation
    let response: Response
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-csrf-token': this.csrf! } : {},
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      if (generation !== this.generation) throw new AdminRequestError(method === 'POST' ? 'NETWORK_UNCERTAIN' : 'AUTH_REQUIRED')
      throw new AdminRequestError('NETWORK_UNCERTAIN')
    }
    // Late responses belong to the credentials that sent them, never a replacement session
    if (generation !== this.generation) throw new AdminRequestError(method === 'POST' ? 'NETWORK_UNCERTAIN' : 'AUTH_REQUIRED')
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.clearSession()
      const result = ApiErrorSchema.safeParse(await response.json().catch(() => null))
      throw new AdminRequestError(result.success ? result.data.error.code : 'SERVICE_UNAVAILABLE', result.success ? result.data.error.requestId : undefined)
    }
    const value = await response.json() as T
    if (generation !== this.generation) throw new AdminRequestError(method === 'POST' ? 'NETWORK_UNCERTAIN' : 'AUTH_REQUIRED')
    return value
  }
  async session(): Promise<AdminSession> {
    this.clearSession()
    const generation = this.generation
    const session = await this.request<AdminSession>(`${API}session`)
    if (generation !== this.generation) throw new AdminRequestError('AUTH_REQUIRED')
    this.csrf = session.csrf
    this.sessionId = session.sessionId
    this.expiresAt = session.expiresAt
    return session
  }
  async accessSession(): Promise<AccessSession> {
    this.clearSession()
    const generation = this.generation
    const session = await this.request<AccessSession>(`${API}access-session`)
    if (generation !== this.generation) throw new AdminRequestError('AUTH_REQUIRED')
    this.csrf = session.csrf
    this.sessionId = session.sessionId
    this.expiresAt = session.expiresAt
    return session
  }
  async acceptInvitation(capability: string): Promise<AdminSession> {
    const generation = this.generation
    const session = await this.request<AdminSession>(`${API}invitations/accept`, 'POST', { capability })
    if (generation !== this.generation) throw new AdminRequestError('NETWORK_UNCERTAIN')
    this.clearSession()
    this.csrf = session.csrf
    this.sessionId = session.sessionId
    this.expiresAt = session.expiresAt
    return session
  }
  get<T>(path: string): Promise<T> { return this.request<T>(`${API}${path}`) }
  async preview(command: AdminCommand): Promise<AdminPreview> {
    return AdminPreviewSchema.parse(await this.request(`${API}actions/preview`, 'POST', AdminCommandSchema.parse(command)))
  }
  async lookup(actionId: string): Promise<AdminReceipt> {
    const receipt = AdminReceiptSchema.parse(await this.get(`actions/${encodeURIComponent(actionId)}`))
    if (receipt.actionId !== actionId) throw new AdminRequestError('SERVICE_UNAVAILABLE')
    return receipt
  }
  async execute(command: AdminCommand): Promise<AdminReceipt> {
    const submitted = AdminCommandSchema.parse(command)
    const generation = this.generation
    try {
      const receipt = AdminReceiptSchema.parse(await this.request(`${API}actions`, 'POST', submitted))
      if (receipt.actionId !== submitted.actionId) throw new Error('Mismatched action receipt')
      return receipt
    } catch (error) {
      if (error instanceof AdminRequestError && error.code !== 'NETWORK_UNCERTAIN') throw error
      if (generation !== this.generation) throw new AdminRequestError('NETWORK_UNCERTAIN', undefined, submitted.actionId, 'AUTH_REQUIRED')
      try { return await this.lookup(submitted.actionId) }
      catch (lookupError) {
        const diagnostic = lookupError instanceof AdminRequestError ? lookupError.code : 'INVALID_RESPONSE'
        throw new AdminRequestError('NETWORK_UNCERTAIN', lookupError instanceof AdminRequestError ? lookupError.requestId : undefined, submitted.actionId, diagnostic)
      }
    }
  }
  async confirm(preview: AdminPreview, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AdminRequestError('FORBIDDEN')
    const generation = this.generation
    let challenge: { challengeId: string; expiresAt: number; confirmationPath: string }
    try { challenge = await this.request(`${API}confirmations`, 'POST', { commandDigest: preview.commandDigest }) }
    catch (error) { if (generation !== this.generation) throw new AdminRequestError('AUTH_REQUIRED'); throw error }
    if (generation !== this.generation) throw new AdminRequestError('AUTH_REQUIRED')
    if (signal?.aborted) throw new AdminRequestError('FORBIDDEN')
    if (challenge.confirmationPath !== '/admin/confirm/' || challenge.expiresAt <= Date.now()) throw new AdminRequestError('FORBIDDEN')
    const popup = window.open(challenge.confirmationPath, '_blank', 'popup,width=520,height=640')
    if (!popup) throw new AdminRequestError('FORBIDDEN')
    const origin = window.location.origin
    const sessionId = this.sessionId
    const csrf = this.csrf
    const challengeId = challenge.challengeId
    const ready = (value: unknown): value is { type: 'admin-confirm-ready' } =>
      !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && (value as { type?: unknown }).type === 'admin-confirm-ready'
    const result = (value: unknown): value is { type: 'admin-confirm-result'; challengeId: string; ok: boolean } =>
      !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'challengeId,ok,type' && (value as { type?: unknown }).type === 'admin-confirm-result' && (value as { challengeId?: unknown }).challengeId === challengeId && typeof (value as { ok?: unknown }).ok === 'boolean'
    // The challenge and CSRF travel only between this exact opener and popup in same-origin memory
    // The server still checks the separate assertion, live session and bound command digest
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearInterval(check); clearTimeout(timeout); window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort); offLost() }
      const abort = () => { stop(); popup.close(); reject(new AdminRequestError('FORBIDDEN')) }
      const offLost = this.onSessionLost(() => { stop(); popup.close(); reject(new AdminRequestError('AUTH_REQUIRED')) })
      const check = window.setInterval(() => { if (popup.closed) { stop(); reject(new AdminRequestError('FORBIDDEN')) } }, 250)
      const timeout = window.setTimeout(() => { stop(); popup.close(); reject(new AdminRequestError('FORBIDDEN')) }, Math.max(0, Math.min(15 * 60_000, challenge.expiresAt - Date.now())))
      const receive = (event: MessageEvent) => {
        if (event.origin !== origin || event.source !== popup || this.generation !== generation || this.sessionId !== sessionId) return
        if (ready(event.data)) popup.postMessage({ type: 'admin-confirm-challenge', challengeId, csrf }, origin)
        if (result(event.data)) {
          stop()
          if (event.data.ok) resolve()
          else reject(new AdminRequestError('FORBIDDEN'))
          popup.close()
        }
      }
      window.addEventListener('message', receive)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
}
export function adminErrorMessage(error: unknown): string {
  if (!(error instanceof AdminRequestError)) return 'Service unavailable. Try again.'
  switch (error.code) {
    case 'HEAD_CONFLICT': case 'STALE_CURSOR': return 'Conflicting changes. Refresh the preview.'
    case 'AUTH_REQUIRED': return 'Access changed. Sign in again and refresh.'
    case 'FORBIDDEN': return 'Not authorized or confirmation unavailable. Refresh your session.'
    case 'NETWORK_UNCERTAIN': return `Outcome unknown. Look up action ${error.actionId ?? ''} before trying again.${error.diagnostic ? ` Lookup: ${error.diagnostic}${error.requestId ? ` (request ${error.requestId})` : ''}.` : ''}`
    case 'SERVICE_PAUSED': return 'This service is paused.'
    default: return `${error.code}${error.requestId ? ` (request ${error.requestId})` : ''}`
  }
}

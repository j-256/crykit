import { captureProfileEpoch, currentProfileToken, onProfileTransition, profileSessionIdentity } from './profile'

export interface ServiceNotice {
  readonly code: 'RATE_LIMITED' | 'SERVICE_PAUSED'
  readonly requestId?: string
  readonly retryAt?: number
  readonly occurredAt: number
}
export class ServiceRequestError extends Error {
  constructor(code: string, readonly requestId?: string, readonly retryAt?: number) { super(code) }
}
const maximumDate = 8_640_000_000_000_000
const referencePattern = /^[A-Za-z0-9_-]{1,128}$/
const listeners = new Set<() => void>()
let serial = 0
let current: (ServiceNotice & { readonly requestKey: string; readonly serial: number }) | undefined
export const readServiceNotice = () => current
export function subscribeServiceNotice(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function clearServiceNotice(): void { if (current) { current = undefined; for (const listener of listeners) listener() } }
onProfileTransition(clearServiceNotice)

function retryTime(response: Response, seconds?: number): number | undefined {
  const now = Date.now(), header = response.headers.get('retry-after')
  const fromHeader = header === null ? NaN : /^\d+$/.test(header) ? now + Number(header) * 1000 : Date.parse(header)
  const fromBody = seconds === undefined ? NaN : now + seconds * 1000
  const times = [fromHeader, fromBody].filter(value => Number.isFinite(value) && value >= now && value <= maximumDate)
  return times.length ? Math.max(...times) : undefined
}

export function serviceNoticeRequest(requestKey: string, signal?: AbortSignal) {
  const requestSerial = ++serial
  const epoch = captureProfileEpoch()
  const identity = () => { const token = currentProfileToken(); return token ? profileSessionIdentity(token).sessionId : undefined }
  const session = identity()
  const isCurrent = () => { try { epoch.assertCurrent(); return !signal?.aborted && session === identity() } catch { return false } }
  return {
    failure(response: Response, code: string, bodyRequestId?: string, retryAfterSeconds?: number): ServiceRequestError {
      const candidate = bodyRequestId ?? response.headers.get('x-crykit-request-id')
      const requestId = candidate && referencePattern.test(candidate) ? candidate : undefined
      const retryAt = retryTime(response, retryAfterSeconds)
      if ((code === 'RATE_LIMITED' || code === 'SERVICE_PAUSED') && isCurrent() && (!current || current.serial <= requestSerial)) {
        // Keep only diagnostic metadata in memory; a late response cannot follow a profile or session switch
        current = { code, requestId, retryAt, occurredAt: Date.now(), requestKey, serial: requestSerial }
        for (const listener of listeners) listener()
      }
      return new ServiceRequestError(code, requestId, retryAt)
    },
    // Concurrent reads can finish out of order; an older success does not establish recovery from a newer denial
    succeeded() { if (isCurrent() && current?.requestKey === requestKey && current.serial <= requestSerial) clearServiceNotice() },
  }
}

export function serviceSupportLink(notice: ServiceNotice, revision?: string): string {
  const body = [`CryKit service interruption: ${notice.code}`, `Time: ${new Date(notice.occurredAt).toISOString()}`, ...(notice.requestId ? [`Reference: ${notice.requestId}`] : []), ...(revision ? [`App version: ${revision}`] : []), '', 'What were you trying to do?'].join('\n')
  // Never include a page URL: email confirmation and recovery links can carry private capabilities
  return `mailto:abuse@crykit.lasers.app?subject=${encodeURIComponent('CryKit service interruption')}&body=${encodeURIComponent(body)}`
}

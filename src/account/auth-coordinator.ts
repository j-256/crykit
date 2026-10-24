import { AccountMetadataSchema } from './protocol'
import { captureProfileEpoch } from './profile'

export const authLockName = 'crykit-account-session-v1'
export const authAcquisitionDeadlineMs = 30_000
export const authRequestDeadlineMs = 30_000
export class AuthCoordinationError extends Error {
  constructor(readonly code: 'AUTH_COORDINATION_UNAVAILABLE' | 'AUTH_ACQUISITION_TIMEOUT' | 'AUTH_REQUEST_TIMEOUT' | 'AUTH_SESSION_UNCERTAIN') { super(code) }
}
export type AuthRequestRunner = <T>(request: (signal: AbortSignal) => Promise<T>) => Promise<T>
interface AuthLockManager { request<T>(name: string, options: { mode: 'exclusive'; signal: AbortSignal }, callback: () => Promise<T>): Promise<T> }
const browser = globalThis as unknown as { navigator?: { locks?: AuthLockManager }; window?: EventTarget }
export function authCoordinationAvailable(): boolean { return !!browser.navigator?.locks?.request }
export async function withAuthLock<T>(operation: (run: AuthRequestRunner) => Promise<T>, epoch = captureProfileEpoch()): Promise<T> {
  if (!authCoordinationAvailable()) throw new AuthCoordinationError('AUTH_COORDINATION_UNAVAILABLE')
  epoch.assertCurrent(); epoch.signal.throwIfAborted()
  const acquisition = new AbortController()
  const page = browser.window
  const requests = new Set<AbortController>()
  const cancel = () => {
    acquisition.abort(epoch.signal.reason)
    for (const request of requests) request.abort(epoch.signal.reason)
  }
  epoch.signal.addEventListener('abort', cancel, { once: true })
  page?.addEventListener('pagehide', cancel, { once: true })
  const waiting = setTimeout(() => acquisition.abort(new AuthCoordinationError('AUTH_ACQUISITION_TIMEOUT')), authAcquisitionDeadlineMs)
  try {
    return await browser.navigator!.locks!.request(authLockName, { mode: 'exclusive', signal: acquisition.signal }, async () => {
      clearTimeout(waiting)
      epoch.assertCurrent(); acquisition.signal.throwIfAborted()
      const run: AuthRequestRunner = async request => {
        epoch.assertCurrent(); acquisition.signal.throwIfAborted()
        const transport = new AbortController()
        requests.add(transport)
        const deadline = setTimeout(() => transport.abort(new AuthCoordinationError('AUTH_REQUEST_TIMEOUT')), authRequestDeadlineMs)
        try {
          // Await native fetch AND body settlement; a timeout race alone would release the cookie lock early
          const result = await request(transport.signal)
          transport.signal.throwIfAborted(); epoch.assertCurrent(); return result
        } catch (error) {
          // WebKit can reject native fetch with a generic AbortError instead of the supplied reason
          // Normalize only after native settlement, preserving the exclusion and explicit deadline cause
          if (transport.signal.aborted) throw transport.signal.reason
          throw error
        } finally { clearTimeout(deadline); requests.delete(transport) }
      }
      try { const result = await operation(run); epoch.assertCurrent(); acquisition.signal.throwIfAborted(); return result }
      catch (error) {
        // A lost response can follow a server commit or applied cookie; inspect real authority while excluded
        // This does not recover a lost envelope or authorize attaching any key to the observed principal
        if (!acquisition.signal.aborted) {
          try {
            await run(async signal => {
              const init = { credentials: 'same-origin' as const, signal }
              const response = await fetch('/api/v1/account', init)
              const body: unknown = await response.json()
              if (response.ok) AccountMetadataSchema.parse(body)
            })
          } catch { /* Fresh explicit authentication/reconnect must establish authority before publication */ }
        }
        throw error
      }
    })
  } finally {
    clearTimeout(waiting)
    epoch.signal.removeEventListener('abort', cancel)
    page?.removeEventListener('pagehide', cancel)
  }
}

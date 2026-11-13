import { useCallback, useEffect, useState } from 'react'
import { ServiceStatusSchema } from '../../account/protocol'

const accountAvailabilityTimeoutMs = 10_000
type Availability =
  | { state: 'checking' | 'failed' }
  | { state: 'ready'; accountsAvailable: boolean; signupAvailable: boolean }

export function useAccountServiceStatus() {
  const [availability, setAvailability] = useState<Availability>({ state: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    setAvailability({ state: 'checking' })
    setAttempt(value => value + 1)
  }, [])
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      setAvailability({ state: 'failed' })
      controller.abort()
    }, accountAvailabilityTimeoutMs)
    void (async () => {
      try {
        // Readiness is public and transient; cached success must not reopen disabled controls
        const response = await fetch('/api/v1/service', { credentials: 'omit', cache: 'no-store', signal: controller.signal })
        controller.signal.throwIfAborted()
        if (!response.ok) throw new Error('SERVICE_UNAVAILABLE')
        const status = ServiceStatusSchema.parse(await response.json())
        // Navigation, retries, and deadlines can outlive adapters that ignore fetch cancellation
        controller.signal.throwIfAborted()
        if (active) setAvailability({ state: 'ready', accountsAvailable: status.accountsAvailable, signupAvailable: status.accountsAvailable && status.signupAvailable })
      } catch {
        if (active) setAvailability({ state: 'failed' })
      } finally {
        clearTimeout(timeout)
      }
    })()
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [attempt])
  return { ...availability, retry }
}

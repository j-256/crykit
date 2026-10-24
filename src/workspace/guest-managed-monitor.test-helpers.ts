import 'fake-indexeddb/auto'
import { afterEach, beforeEach, vi } from 'vitest'
import { compareManagedGuestRetained } from './guest-managed-retained'
import { invalidateProfile } from '../account/profile'
import type { GuestMonitorRequest, GuestMonitorResponse } from './guest-managed-monitor-worker'

// Node persistence tests run the actual retained comparator against fake IndexedDB
// Browser proofs separately cover worker transport, lifetime and native reader cancellation
let comparisons = 0
export const managedMonitorComparisonCount = () => comparisons
beforeEach(() => {
  comparisons = 0
  vi.stubGlobal('Worker', class {
    onmessage?: (event: MessageEvent<GuestMonitorResponse>) => void
    onerror?: () => void
    controller = new AbortController()
    postMessage(request: GuestMonitorRequest) {
      if (request.kind === 'cancel') { this.controller.abort(); return }
      comparisons++
      void compareManagedGuestRetained(request.databaseName, request.manifest, this.controller.signal).then(notices => {
        if (!this.controller.signal.aborted) this.onmessage?.({ data: { id: request.id, status: 'complete', notices } } as MessageEvent<GuestMonitorResponse>)
      }, () => { if (!this.controller.signal.aborted) this.onerror?.() })
    }
    terminate() { this.controller.abort() }
  })
})
afterEach(() => { invalidateProfile(); vi.unstubAllGlobals() })

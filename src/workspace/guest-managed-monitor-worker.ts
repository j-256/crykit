import { compareManagedGuestRetained, RetainedGuestSelectionChanged } from './guest-managed-retained'
import { LEGACY_CHECK_BUDGET_MS } from './legacy-capture'
import type { GuestManagedManifest } from './guest-local-store'
import type { GuestRecoveryNotice } from './guest-recovery'

export type GuestMonitorRequest = { readonly kind: 'compare'; readonly id: string; readonly databaseName: string; readonly manifest: GuestManagedManifest } | { readonly kind: 'cancel'; readonly id: string }
export type GuestMonitorResponse = { readonly id: string; readonly status: 'complete'; readonly notices: readonly GuestRecoveryNotice[] } | { readonly id: string; readonly status: 'incomplete'; readonly reason: 'cancelled' | 'expired' | 'unavailable' | 'selection-changed' }

let current: { id: string; controller: AbortController } | undefined
self.addEventListener('message', (event: MessageEvent<GuestMonitorRequest>) => {
  const request = event.data
  if (request.kind === 'cancel') { if (current?.id === request.id) current.controller.abort(); return }
  if (current) return
  const controller = new AbortController()
  current = { id: request.id, controller }
  let expired = false
  const deadline = setTimeout(() => { expired = true; controller.abort() }, LEGACY_CHECK_BUDGET_MS)
  const reply = (response: GuestMonitorResponse) => self.postMessage(response)
  void compareManagedGuestRetained(request.databaseName, request.manifest, controller.signal).then(notices => {
    if (controller.signal.aborted) reply({ id: request.id, status: 'incomplete', reason: expired ? 'expired' : 'cancelled' })
    else reply({ id: request.id, status: 'complete', notices })
  }, error => reply({ id: request.id, status: 'incomplete', reason: error instanceof RetainedGuestSelectionChanged ? 'selection-changed' : expired ? 'expired' : controller.signal.aborted ? 'cancelled' : 'unavailable' })).finally(() => {
    clearTimeout(deadline); current = undefined
  })
})

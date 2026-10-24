import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiErrorSchema } from '../../account/protocol'
import './admin.css'

const origin = window.location.origin
const opener = window.opener
function ConfirmAction() {
  const [status, setStatus] = useState(opener ? 'Waiting for the action challenge...' : 'Return to the action and open confirmation again.')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!opener) return
    let consumed = false
    const listener = async (event: MessageEvent) => {
      if (consumed || event.origin !== origin || event.source !== opener || !event.data || typeof event.data !== 'object' || Array.isArray(event.data) || Object.keys(event.data).sort().join(',') !== 'challengeId,csrf,type' || event.data.type !== 'admin-confirm-challenge') return
      const { challengeId, csrf } = event.data as { challengeId?: unknown; csrf?: unknown }
      if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(challengeId) || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) return
      consumed = true
      clearInterval(readyTimer)
      setBusy(true); setStatus('Confirming with the separate Access session...')
      try {
        const response = await fetch('/admin/confirm/api/v1/complete', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ challengeId }) })
        if (!response.ok) {
          const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null))
          throw new Error(parsed.success ? parsed.data.error.code : 'SERVICE_UNAVAILABLE')
        }
        setStatus('Confirmed. Return to the action.')
        opener.postMessage({ type: 'admin-confirm-result', challengeId, ok: true }, origin)
      } catch (error) {
        setStatus(`Confirmation failed: ${error instanceof Error ? error.message : 'SERVICE_UNAVAILABLE'}`)
        opener.postMessage({ type: 'admin-confirm-result', challengeId, ok: false }, origin)
      } finally { setBusy(false) }
    }
    window.addEventListener('message', listener)
    const readyTimer = window.setInterval(() => { if (!consumed && !opener.closed) opener.postMessage({ type: 'admin-confirm-ready' }, origin) }, 500)
    opener.postMessage({ type: 'admin-confirm-ready' }, origin)
    return () => { clearInterval(readyTimer); window.removeEventListener('message', listener) }
  }, [])
  return <main className="admin-landing"><h1>Confirm administrator action</h1><p>This page must be protected by the separate confirmation Access application. A normal admin session cannot confirm the action.</p><p role="status">{status}</p>{busy && <p>Keep this window open.</p>}<button type="button" onClick={() => window.close()}>Close</button></main>
}
createRoot(document.getElementById('root')!).render(<ConfirmAction />)

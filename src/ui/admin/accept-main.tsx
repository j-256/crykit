import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AdminClient, adminErrorMessage } from './admin-client'
import './admin.css'

// Remove the one-use capability before any further navigation or UI observer can retain the URL
const capability = window.location.hash.slice(1)
window.history.replaceState(null, '', window.location.pathname)
const client = new AdminClient()
function AcceptInvitation() {
  const [status, setStatus] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  async function prepare() {
    setBusy(true); setStatus('')
    try { await client.accessSession(); setReady(true) }
    catch (reason) { setStatus(adminErrorMessage(reason)) }
    finally { setBusy(false) }
  }
  async function accept() {
    if (!capability || !ready) return
    setBusy(true); setStatus('')
    try { await client.acceptInvitation(capability); window.location.replace('/admin/') }
    catch (reason) { setStatus(adminErrorMessage(reason)); setBusy(false) }
  }
  return <main className="admin-landing"><h1>Accept administrator invitation</h1><p>This invitation requires a verified identity matching the invited email and permission in the admin Access policy. Ask the owner to add you to that policy before continuing.</p>{!capability ? <p role="alert">Invitation link is missing or expired.</p> : <><button type="button" disabled={busy} onClick={() => void prepare()}>Check Access session</button>{ready && <button type="button" disabled={busy} onClick={() => void accept()}>Accept invitation</button>}</>}{status && <p className="admin-error" role="alert">{status}</p>}</main>
}
createRoot(document.getElementById('root')!).render(<AcceptInvitation />)

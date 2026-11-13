import { useState } from 'react'
import { Button, InlineNotice } from './components'

export function PrelaunchWorkspaceNotice({ onStart }: { readonly onStart: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const start = async () => {
    setBusy(true)
    setError(undefined)
    try { await onStart() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The new workspace could not be saved. Please retry.') }
    finally { setBusy(false) }
  }
  return <main className="error-screen panel"><div className="panel__body stack"><p className="eyebrow">CryKit</p><h1>A new source catalog</h1><p>This browser has a workspace from a prelaunch CryKit format. It cannot be opened by this version.</p><p>You can start a new workspace with labeled sample records. Your prelaunch data will remain stored in this browser.</p>{error && <InlineNotice title="Workspace could not be started" tone="danger">{error}</InlineNotice>}<Button disabled={busy} onClick={() => void start()}>{busy ? 'Starting workspace...' : 'Start new workspace'}</Button></div></main>
}

import { useEffect, useRef, useState } from 'react'
import type { AdminCommand, AdminPreview, AdminReceipt } from '../../account/admin-protocol'
import { AdminClient, AdminRequestError, adminErrorMessage } from './admin-client'
import { actionPresentation } from './admin-action-presentation'

interface Props { client: AdminClient; command: AdminCommand; environmentLabel: string; onClose(): void; onSubmitted(actionId: string): void; onUncertain(actionId: string, message: string): void; onDefinitiveFailure(actionId: string): void; onComplete(receipt: AdminReceipt): void }
interface JobState { type?: string; outcome?: string; phase?: string; code?: string | null; request_id?: string; next_at?: number; observedAt?: number }
export function AdminActionDialog({ client, command, environmentLabel, onClose, onSubmitted, onUncertain, onDefinitiveFailure, onComplete }: Props) {
  const [preview, setPreview] = useState<AdminPreview | null>(null)
  const [receipt, setReceipt] = useState<AdminReceipt | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [uncertainActionId, setUncertainActionId] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)
  const pending = useRef(new AbortController())
  const submittedRef = useRef(false)
  useEffect(() => () => pending.current.abort(), [])
  useEffect(() => {
    let active = true
    first.current?.focus()
    client.preview(command).then(result => { if (active) setPreview(result) }).catch(reason => { if (active) setError(adminErrorMessage(reason)) })
    const off = client.onSessionLost(() => { pending.current.abort(); setPreview(null); setError('Access changed. Sign in again and refresh.') })
    return () => { active = false; off() }
  }, [client, command])
  useEffect(() => {
    if (!receipt?.jobId) return
    let active = true
    const load = () => client.get<JobState>(`jobs/${encodeURIComponent(receipt.jobId!)}`).then(result => { if (active) setJob(result) }).catch(reason => { if (active) setError(adminErrorMessage(reason)) })
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [client, receipt?.jobId])
  async function apply() {
    if (!preview || busy || preview.expiresAt <= Date.now()) { setError('Preview expired. Close this dialog and start a new action.'); return }
    setBusy(true)
    setError('')
    try {
      if (preview.requiresConfirmation) await client.confirm(preview, pending.current.signal)
      if (pending.current.signal.aborted) return
      submittedRef.current = true
      setSubmitted(true)
      onSubmitted(command.actionId)
      const result = await client.execute(command)
      onComplete(result)
      if (!pending.current.signal.aborted) setReceipt(result)
    } catch (reason) {
      if (submittedRef.current) {
        if (reason instanceof AdminRequestError && reason.code === 'NETWORK_UNCERTAIN') onUncertain(command.actionId, adminErrorMessage(reason))
        else onDefinitiveFailure(command.actionId)
      }
      if (pending.current.signal.aborted) return
      setError(adminErrorMessage(reason))
      if (reason instanceof AdminRequestError && reason.code === 'HEAD_CONFLICT') setPreview(null)
      if (submittedRef.current && reason instanceof AdminRequestError && reason.code === 'NETWORK_UNCERTAIN') { setPreview(null); setUncertainActionId(command.actionId) }
    } finally { setBusy(false) }
  }
  async function checkAction() {
    if (!uncertainActionId) return
    setBusy(true)
    try { const result = await client.lookup(uncertainActionId); setReceipt(result); setUncertainActionId(null); setError(''); onComplete(result) }
    catch (reason) { const message = reason instanceof AdminRequestError && reason.code === 'NOT_FOUND' ? `No receipt observed for action ${uncertainActionId}. Check again before starting another action.` : adminErrorMessage(reason); setError(message); onUncertain(uncertainActionId, message) }
    finally { setBusy(false) }
  }
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); pending.current.abort(); onClose() }
    if (event.key !== 'Tab' || !dialog.current) return
    const controls = Array.from(dialog.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    if (!controls.length) return
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
  }
  const emailUncertain = job?.type === 'email' && (job.phase === 'uncertain' || job.phase === 'accepted')
  const presentation = actionPresentation(command)
  const jobLabel = emailUncertain ? job.phase === 'accepted' ? 'Transport accepted, delivery unconfirmed' : 'Delivery uncertain'
    : job?.outcome === 'complete' ? 'Complete' : job?.outcome === 'failed' ? 'Failed'
      : job?.outcome === 'running' ? 'Running' : job?.outcome === 'waiting' ? 'Waiting to retry'
        : job?.outcome === 'pending' || job?.outcome === 'queued' ? 'Queued' : 'Status unavailable'
  return <div className="admin-dialog-backdrop"><div ref={dialog} className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-action-title" onKeyDown={onKeyDown}>
    <h2 id="admin-action-title">{presentation.title}</h2>
    <section className={presentation.danger ? 'admin-review-summary admin-danger' : 'admin-review-summary'}><h3>Proposed change</h3><ul>{presentation.changes.map((change) => <li key={change}>{change}</li>)}</ul><p>{presentation.consequence}</p></section>
    <dl className="admin-facts"><div><dt>Environment</dt><dd>{environmentLabel}</dd></div><div><dt>Target</dt><dd className="admin-id">{command.target.kind} {command.target.id}</dd></div><div><dt>Action</dt><dd>{command.command.type}</dd></div><div><dt>Reason</dt><dd>{command.reason}</dd></div><div><dt>Action ID</dt><dd className="admin-id">{command.actionId}</dd></div></dl>
    {!preview && !error && <p role="status">Loading server preview...</p>}
    {preview && <><h3>Impact</h3><ul>{preview.impact.map(impact => <li key={impact}>{impact}</li>)}</ul><p>Preview expires {new Date(preview.expiresAt).toLocaleString()}.</p>{preview.requiresConfirmation && <p>Separate Access confirmation is required. Its availability depends on the configured confirmation application.</p>}</>}
    {error && <p className="admin-error" role="alert">{error}</p>}
    {receipt && <section aria-live="polite"><h3>Result</h3><p>{receipt.state === 'queued' ? 'Accepted and queued' : 'Complete'} · Request {receipt.requestId}</p>{receipt.jobId && <><p>Job <span className="admin-id">{receipt.jobId}</span>: {jobLabel}</p>{job?.code && <p>Diagnostic code: {job.code}</p>}{job?.next_at && job.outcome === 'waiting' && <p>Next retry: {new Date(job.next_at).toLocaleString()}</p>}</>}</section>}
    <div className="admin-actions"><button ref={first} type="button" onClick={() => { pending.current.abort(); onClose() }}>{receipt ? 'Close' : submitted ? 'Hide status' : 'Cancel'}</button>{preview && !receipt && <button data-action="apply" className={presentation.danger ? 'admin-action--danger' : ''} type="button" disabled={busy || preview.expiresAt <= Date.now()} onClick={() => void apply()}>{busy ? 'Applying...' : 'Apply action'}</button>}{uncertainActionId && <button type="button" disabled={busy} onClick={() => void checkAction()}>Check action status</button>}</div>
  </div></div>
}

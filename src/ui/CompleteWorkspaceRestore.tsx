import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { GuestRestorePreview } from '../workspace/restore'
import type { AccountRestorePreview } from '../workspace/account-restore'
import { Button, InlineNotice, Spinner } from './components'
import { formatAppError } from './model'

export type CompleteWorkspaceRestorePreview = GuestRestorePreview | AccountRestorePreview

interface RestoreActions {
  readonly disabled: boolean
  readonly onPreview: (file: File) => Promise<CompleteWorkspaceRestorePreview>
  readonly onActivate: (preview: CompleteWorkspaceRestorePreview) => Promise<void>
  readonly onClear: () => Promise<void>
}

export function CompleteWorkspaceRestore({ disabled, onPreview, onActivate, onClear }: RestoreActions) {
  const [preview, setPreview] = useState<CompleteWorkspaceRestorePreview>()
  const [filename, setFilename] = useState('')
  const [fileBytes, setFileBytes] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'reading' | 'restoring' | 'failed' | 'finished'>('idle')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const serial = useRef(0)
  useEffect(() => () => { serial.current++; void onClear().catch(() => {}) }, [])
  const clear = async () => {
    serial.current++
    setPreview(undefined); setConfirmed(false); setError(''); setPhase('idle'); setFilename('')
    await onClear()
  }
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || disabled || phase === 'reading' || phase === 'restoring') return
    const request = ++serial.current
    setPreview(undefined); setConfirmed(false); setError(''); setPhase('reading')
    try {
      await onClear()
      const result = await onPreview(file)
      if (serial.current !== request) return
      setPreview(result); setFilename(file.name); setFileBytes(file.size); setPhase('idle')
    } catch (reason) {
      if (serial.current === request) { setPhase('idle'); setError(formatAppError(reason, 'The complete workspace backup could not be previewed.')) }
    }
  }
  const restore = async () => {
    if (!preview || !confirmed || disabled || phase !== 'idle') return
    setPhase('restoring'); setError('')
    try { await onActivate(preview); setPhase('finished') }
    catch (reason) { setPhase('failed'); setError(formatAppError(reason, 'The complete workspace restore could not finish.')) }
  }
  return <div className="stack">
    {error && <InlineNotice title={phase === 'failed' ? 'Restore needs checking' : 'Backup could not be opened'} tone="danger">{error}{phase === 'failed' && <p>The earlier saved workspace is retained. Reopen CryKit to check which version is selected and review any recovery notice.</p>}</InlineNotice>}
    {phase === 'failed' && <div className="cluster"><Button onClick={() => window.location.reload()} tone="secondary">Reopen CryKit to check saved data</Button><Button onClick={() => { void clear() }} tone="quiet">Choose another backup</Button></div>}
    {preview && phase !== 'failed' && <div className="import-preview"><div className="split"><div><p className="eyebrow">Complete workspace preview</p><h4>{filename}</h4></div><Button disabled={phase === 'restoring'} onClick={() => { void clear() }} tone="quiet">Choose another backup</Button></div>
      <dl className="definition-list"><dt>Backup file</dt><dd>{fileBytes.toLocaleString()} bytes</dd><dt>Planner</dt><dd>{preview.categories.planner}</dd><dt>Editor documents</dt><dd>{preview.categories.editor}</dd><dt>Save documents</dt><dd>{preview.categories.save}</dd><dt>Assets</dt><dd>{preview.categories.asset}</dd><dt>History</dt><dd>{preview.categories.history}</dd><dt>Retained original bytes</dt><dd>{preview.privateBytes.toLocaleString()}</dd></dl>
      <InlineNotice title={preview.target === 'account' ? 'Replace the selected account workspace' : 'Replace the selected local workspace'} tone="warning">{preview.target === 'account' ? 'This backup replaces the selected account planner, private files, drafts, and history on this device. The previous saved workspace is kept for recovery. Sign in to resume sync after reopening if prompted; the replacement then syncs to your other devices after publication. Save any open edits before continuing.' : 'This backup replaces the selected planner, private files, drafts, and history on this device. The previous saved workspace is kept separately for recovery. Save any open edits before continuing.'}</InlineNotice>
      <label className="check-row"><input aria-label="Confirm complete workspace replacement" checked={confirmed} disabled={disabled || phase !== 'idle'} onChange={event => setConfirmed(event.target.checked)} type="checkbox"/><span><strong>Replace the selected saved workspace</strong></span></label>
      <Button disabled={!confirmed || disabled || phase !== 'idle'} icon="warning" onClick={() => { void restore() }} tone="danger">{phase === 'restoring' ? 'Restoring...' : 'Replace saved workspace'}</Button>
    </div>}
    {!preview && phase !== 'failed' && <><button className="import-zone" disabled={disabled || phase === 'reading'} onClick={() => input.current?.click()} type="button">{phase === 'reading' ? <Spinner label="Reading complete workspace backup"/> : <span><strong>Choose complete workspace backup</strong><span>Preview the private files and replacement before restoring.</span></span>}</button><input accept=".crykit,application/octet-stream" aria-label="Choose complete workspace backup" className="sr-only" onChange={event => { void choose(event) }} ref={input} type="file"/></>}
  </div>
}

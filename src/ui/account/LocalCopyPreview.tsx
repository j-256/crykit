import { downloadWorkspaceBackup, requestWorkspaceDownload, type DownloadSink } from '../download-stream'
import { ConflictFileVersion } from './ConflictFileVersion'
import { useEffect, useRef, useState } from 'react'
import { assertActiveProfile, type ProfileToken } from '../../account/profile'
import type { createGuestCopyService, GuestCopyPreview } from '../../workspace/guest-copy'

export type LocalCopyService = ReturnType<typeof createGuestCopyService>
export function LocalCopyPreview({ token, service }: { readonly token: ProfileToken; readonly service: LocalCopyService }) {
  const [comparisons, setComparisons] = useState<Awaited<ReturnType<LocalCopyService['inspectCopiedComparisons']>>>([])
  const [savedCopies, setSavedCopies] = useState<Awaited<ReturnType<LocalCopyService['listSavedGuestCopies']>>>([])
  const [actionable, setActionable] = useState(false)
  const [preview, setPreview] = useState<GuestCopyPreview>()
  const [requested, setRequested] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const lifetime = useRef(0)
  useEffect(() => () => { lifetime.current++; void service.dispose() }, [token, service])
  const current = (generation: number) => { assertActiveProfile(token); return lifetime.current === generation }
  async function show(selection?: readonly string[]) {
    const generation = ++lifetime.current
    if (selection) setRequested(selection)
    // Keep visible choices available for correction, but never submit an older accepted preview
    setActionable(false)
    setOpened(true); setBusy(true); setError(''); setStatus('')
    try { const next = await service.previewGuestCopy(token, selection); if (current(generation)) { setPreview(next); setRequested(next.selectedKeys); setActionable(true) } }
    catch (reason) { try { if (current(generation)) setError(reason instanceof Error ? reason.message : 'Local records could not be captured. Saved work stays in place.') } catch { /* A retired profile cannot present a late result */ } }
    finally { if (generation === lifetime.current) setBusy(false) }
  }
  async function cancel() {
    lifetime.current++; setActionable(false); setPreview(undefined); setOpened(false); setBusy(false); setError('')
    try { await service.dispose() } catch { setError('The local preview could not be released. Saved work stays in place.') }
  }
  async function copy() {
    if (!preview || busy || !actionable) return
    const generation = ++lifetime.current
    setBusy(true); setError('')
    try {
      await service.commitGuestCopy(token, preview)
      if (current(generation)) { setPreview(undefined); setOpened(false); setStatus('Copied to this account on this device. Sync will upload the saved copy. Local work is unchanged.'); await service.dispose() }
    } catch (reason) {
      try { if (current(generation)) setError(reason instanceof Error ? reason.message : 'Copy could not finish. Reopen this preview to resume saved preparation.') } catch { /* A new account owns its own presentation */ }
    } finally { if (generation === lifetime.current) setBusy(false) }
  }
  async function previewOriginal(id: string) {
    const generation = ++lifetime.current
    setActionable(false); setBusy(true); setError('')
    try {
      const next = await service.previewRetainedComparison(token, id)
      if (current(generation)) { setPreview(next); setRequested(next.selectedKeys); setActionable(true); setOpened(true); setComparisons([]) }
    } catch (reason) { try { if (current(generation)) setError(reason instanceof Error ? reason.message : 'The original comparison could not be previewed') } catch { /* The previous profile owns this result */ } }
    finally { if (generation === lifetime.current) setBusy(false) }
  }
  async function reviewCopies(copyId?: string) {
    const generation = ++lifetime.current
    setBusy(true); setError('')
    try {
      if (copyId) await service.continueCopiedComparisons(token, copyId)
      const values = await service.inspectCopiedComparisons(token)
      if (current(generation)) { setComparisons(values); if (copyId) setStatus('Comparison registration is saved. Sync, then refresh the copied comparisons.') }
    } catch (reason) { try { if (current(generation)) setError(reason instanceof Error ? reason.message : 'Copied comparisons could not be opened') } catch { /* The previous profile owns this result */ } }
    finally { if (generation === lifetime.current) setBusy(false) }
  }
  async function recoverSavedCopy() {
    if (!preview || busy) return
    const generation = ++lifetime.current
    setActionable(false); setBusy(true); setError('')
    try {
      const result = await service.keepSavedCopyAndRepreview(token, preview)
      if (!current(generation)) return
      const next = await service.previewGuestCopy(token)
      if (current(generation)) {
        setPreview(next); setRequested(next.selectedKeys); setActionable(true)
        setStatus(result.activated ? 'The saved copy was already added. Its backup remains in Review saved copies.' : 'The saved copy remains in Review saved copies. Choose records for a new copy.')
      }
    } catch (reason) { try { if (current(generation)) setError(reason instanceof Error ? reason.message : 'Saved copy recovery could not finish') } catch { /* The captured account owns recovery */ } }
    finally { if (generation === lifetime.current) setBusy(false) }
  }
  async function reviewSavedCopies() {
    const generation = ++lifetime.current
    setBusy(true); setError('')
    try { const values = await service.listSavedGuestCopies(token); if (current(generation)) setSavedCopies(values) }
    catch (reason) { try { if (current(generation)) setError(reason instanceof Error ? reason.message : 'Saved copies could not be opened') } catch { /* The previous profile owns its saved copies */ } }
    finally { if (generation === lifetime.current) setBusy(false) }
  }
  async function downloadSavedCopy(copyId: string) {
    const generation = ++lifetime.current
    let sink: DownloadSink | undefined
    setBusy(true); setError('')
    try {
      sink = await requestWorkspaceDownload()
      if (!current(generation)) throw new Error('Saved copy download was cancelled')
      await service.withSavedGuestCopy(token, copyId, snapshot => downloadWorkspaceBackup(snapshot, Promise.resolve(sink)))
      if (current(generation)) setStatus('Saved copy backup requested. Store it privately.')
    } catch (reason) {
      await sink?.abort(reason).catch(() => {})
      try { if (current(generation)) setError(reason instanceof Error ? reason.message : 'The saved copy could not be downloaded') } catch { /* A switched account cannot receive the download */ }
    } finally { if (generation === lifetime.current) setBusy(false) }
  }
  const dependencies = preview?.closure.filter(record => !preview.selectedKeys.includes(record.key)) ?? []
  return <section aria-label="Copy local work"><h2>Copy local work</h2><p>Choose saved local records to add to this account. Your local workspace stays unchanged.</p>{!opened && <button onClick={() => void show()}>Copy local work</button>}{!opened && <button disabled={busy} onClick={() => void reviewCopies()}>Review copied comparisons</button>}{!opened && <button disabled={busy} onClick={() => void reviewSavedCopies()}>Review saved copies</button>}{status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}{opened && <>
    {busy && <p role="status">Preparing local copy...</p>}
    {preview && <><h3>{preview.resumable ? 'Resume saved copy' : 'Choose local records'}</h3><p>Sample provenance stays labeled after edits. Samples are unchecked until you include them.</p><p>Copied comparisons retain both originals. If the account has no matching record, its original accepted version is copied first; comparison registration continues after sync.</p>
      <fieldset disabled={busy || preview.resumable}><legend>Saved records</legend>{preview.records.map(record => <label key={record.key} style={{ display: 'block' }}><input type="checkbox" checked={requested.includes(record.key)} onChange={event => { void show(event.target.checked ? [...requested, record.key] : requested.filter(key => key !== record.key)) }}/>{record.label}{record.sample && ' (Sample provenance)'}</label>)}</fieldset>
      {actionable && <><p>Estimated private content: {preview.estimatedBytes.toLocaleString()} bytes, before encryption and retained account history.</p>
      {dependencies.length > 0 && <details open><summary>Required sources, revisions and history</summary><ul>{dependencies.map(record => <li key={record.key}>{record.label}{record.sample && ' (Sample provenance)'}</li>)}</ul></details>}
      {preview.problems.map(problem => <p role="alert" key={problem}>{problem}</p>)}
      {preview.conflicts.length > 0 && <div role="alert"><p>These saved identities differ from the account version. The account version stays active. Copying retains the local version for explicit comparison after sync.</p><ul>{preview.conflicts.map(key => <li key={key}>{preview.records.find(record => record.key === key)?.label ?? key}</li>)}</ul></div>}
      </>}
      <button disabled={busy || !actionable || !preview.selectedKeys.length || !!preview.problems.length} onClick={() => void copy()}>{preview.resumable ? 'Resume copy' : 'Copy selected work'}</button>
      {preview.resumable && <><p>You can keep this saved copy for private backup and start a new preview. Its original selection and mappings stay unchanged.</p><button disabled={busy} onClick={() => void recoverSavedCopy()}>Keep saved copy and preview again</button></>}
    </>}
    <button onClick={() => void cancel()}>{preview?.resumable ? 'Keep pending copy for later' : 'Cancel'}</button>
  </>}{savedCopies.map(saved => <article key={saved.copyId}><h3>Saved copy</h3><p>{saved.labels.join(', ')}</p><p>{saved.activated ? 'Added to the account.' : 'Saved preparation; not added to the account.'}{saved.pending && ' Resume is available from Copy local work.'}</p><p>This private backup includes the captured account contents and exact source originals.</p><button disabled={busy} onClick={() => void downloadSavedCopy(saved.copyId)}>Download saved copy</button></article>)}{comparisons.map(comparison => <article key={comparison.id}><h3>Copied comparison</h3><p>{comparison.historical ? 'Retained source original. It stays inspectable independently of the device that copied it.' : comparison.registered ? 'This comparison is registered in the account. Both source originals are shown here.' : comparison.collision ? 'Choose the applicable version in Saved versions need review, sync that choice, then continue this copied comparison.' : 'Source originals are saved. Sync the copied records, then continue to register this comparison in the account.'}</p>{comparison.versions.map((version, index) => <section key={index}><h4>{index === 0 ? 'Original pending version' : 'Original accepted version'}</h4><ConflictFileVersion token={token} documents={version.documents} blobs={comparison.blobs} version={index === 0 ? 'pending' : 'accepted'}/><details><summary>Original record details</summary><pre>{JSON.stringify(version.value, null, 2)}</pre></details></section>)}{comparison.historical && <button disabled={busy} onClick={() => void previewOriginal(comparison.id)}>Preview original comparison</button>}{!comparison.registered && comparison.copyId && <button disabled={busy || comparison.collision} onClick={() => void reviewCopies(comparison.copyId)}>Continue copied comparison</button>}</article>)}</section>
}

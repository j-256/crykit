import type { CleanupCandidates } from '../../account/cleanup'
import type { CleanupPreview } from '../../account/storage-protocol'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { STORAGE_WARNING_FRACTION, type DeviceRemoval, type LocalStorageObservation, type StorageService } from '../../account/storage'

function size(bytes: number): string { return `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB` }
export function StoragePanel({ service }: { readonly service: StorageService }): ReactElement {
  const [candidates, setCandidates] = useState<CleanupCandidates>()
  const [preview, setPreview] = useState<CleanupPreview>()
  const [local, setLocal] = useState<LocalStorageObservation>()
  const [remote, setRemote] = useState<Awaited<ReturnType<StorageService['remote']>>>()
  const [recovery, setRecovery] = useState<Awaited<ReturnType<StorageService['recovery']>>>()
  const [removal, setRemoval] = useState<DeviceRemoval>()
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const lifetime = useRef(0), alert = useRef<HTMLParagraphElement>(null)
  useEffect(() => { lifetime.current++; return () => { lifetime.current++ } }, [service])
  useEffect(() => { if (error) alert.current?.focus() }, [error])
  async function perform(work: (current: () => boolean) => Promise<void>, failure: string) {
    const version = lifetime.current
    const current = () => lifetime.current === version
    setBusy(true); setError(''); setNotice('')
    try { await work(current) } catch { if (current()) setError(failure) } finally { if (current()) setBusy(false) }
  }
  const backup = () => perform(async current => { await service.backup(); if (current()) setNotice('Private backup download requested. Check that your file was saved before removing this copy.') }, 'Backup could not be downloaded. Saved data stays in place. Retry or use a browser with streamed file saving.')
  return <section aria-label="Storage and recovery"><h2>Storage and recovery</h2>
    <button disabled={busy} onClick={() => void perform(async current => {
      const results = await Promise.allSettled([service.local(), service.remote(), service.recovery()])
      if (!current()) return
      setLocal(results[0].status === 'fulfilled' ? results[0].value : undefined)
      setRemote(results[1].status === 'fulfilled' ? results[1].value : undefined)
      setRecovery(results[2].status === 'fulfilled' ? results[2].value : undefined)
      if (results[0].status === 'rejected') setError('Local storage details could not be read. Keep your saved data and retry after unlocking this account.')
    }, 'Storage could not be checked. Retry after reconnecting.')}>Refresh storage</button>
    {remote ? <><p>Cloud usage: {size(remote.usedBytes)} of {size(remote.capacityBytes)}. Observed {new Date(remote.observedAt).toLocaleString()}.</p>{remote.usedBytes >= remote.capacityBytes * STORAGE_WARNING_FRACTION && <p role="status">{remote.usedBytes >= remote.capacityBytes ? 'Storage full' : 'Storage is nearly full'}. Saved files and pending changes stay on this device.</p>}<p>Logical account usage includes encrypted data and sync records. Other devices and provider headroom are unknown.</p></> : <p>Cloud usage unknown. Refresh when signed in and connected.</p>}
    {local && <><p>Local content: {size(local.contentBytes)} before encryption. Observed {new Date(local.observedAt).toLocaleString()}. This is not total browser storage.</p><ul>{local.categories.map(category => <li key={category.label}>{category.label}: {category.count}</li>)}</ul>{local.pendingWork && <p>Changes are waiting to sync. Keep this device copy until they finish or save a private backup.</p>}</>}
    <h3>Unused sync data</h3><p>Cleanup preserves source files, drafts and history. Only unused sync versions older than 30 days are eligible, while keeping the latest 20 per record. References, pending work and service recovery copies can block cleanup.</p>
    {service.scanCleanup && <button disabled={busy} onClick={() => void perform(async current => { const page = await service.scanCleanup!(); if (current()) { setCandidates(page); setPreview(undefined) } }, 'Cleanup evidence could not be read. Keep this device copy and retry after unlocking.')}>Find unused sync data</button>}
    {candidates && <>{!candidates.candidates.length && <p>No locally readable unused sync versions found in this page. Other devices may have different cached versions.</p>}{candidates.unavailable && <p>Some encrypted evidence is unavailable on this device. Cleanup is blocked for those versions.</p>}<ul>{candidates.candidates.map(candidate => <li key={candidate.ref.revisionId}>{candidate.category} <button disabled={busy} onClick={() => void perform(async current => { const plan = await service.previewCleanup!(candidate); if (current()) setPreview(plan) }, 'Cleanup could not be checked. Sign in and reconnect, then retry.')}>Review unused version {candidate.ref.revisionId.slice(-6)}</button></li>)}</ul>{candidates.cursor && <button disabled={busy} onClick={() => void perform(async current => { const page = await service.scanCleanup!(candidates.cursor); if (current()) { setCandidates(page); setPreview(undefined) } }, 'The next cleanup page could not be read.')}>Check next page</button>}</>}
    {preview && <div><p>{preview.eligible ? `Estimated removable sync data: ${size(preview.reclaimableBytes)}.` : `Cleanup blocked: ${preview.reasons.join(', ')}.`} Preview observed {new Date(preview.observedAt).toLocaleString()}.</p><details><summary>Exact retained dependencies</summary><p>All these referenced versions remain saved. This action removes only the selected unused sync envelope.</p><ul>{preview.dependencies.map(ref => <li key={ref.revisionId}><code>{ref.documentId} / {ref.revisionId}</code></li>)}</ul></details><button disabled={busy || !preview.eligible} onClick={() => void perform(async current => { const result = await service.cleanup!(preview); if (current()) { setNotice(result.state === 'complete' ? 'Unused sync data removed. Source files and history remain.' : result.state === 'pending' ? 'Cleanup is pending. Retry this same reviewed version.' : 'Saved references changed or still need this version. Review cleanup again.'); if (result.state === 'complete') setPreview(undefined) } }, 'Cleanup is not confirmed. Retry this same reviewed version; saved files remain protected.')}>Remove unused sync data</button></div>}
    <h3>Recovery copies</h3><p>{recovery ? recovery.state === 'paused' ? 'Service recovery paused' : recovery.state === 'verified' ? 'Service recovery point verified' : 'Service recovery not verified' : 'Service recovery status unknown'}</p>
    {recovery?.lastVerifiedAt != null ? <p>Last verified recovery point: {new Date(recovery.lastVerifiedAt).toLocaleString()}. This does not confirm that your latest changes are included.</p> : <p>No verified recovery point is known. Download a private backup.</p>}
    {recovery?.code && <p>Recovery diagnostic: {recovery.code}</p>}
    <button disabled={busy} onClick={() => void backup()}>Account backup</button><p>Backups include private files, saved drafts and history. Store them privately.</p>
    <h3>Remove this device copy</h3><button disabled={busy} onClick={() => void perform(async current => { const review = await service.prepareRemoval(); if (current()) { setRemoval(review); setAcknowledged(false) } }, 'Finish or recover open edits before removing this device copy, then review it again.')}>Remove saved account from this device</button>
    {removal && <div>{removal.pendingWork && <p role="alert">Changes are waiting to sync. Removing this copy can lose those changes.</p>}<p>This removes encrypted account data and local unlock access from this browser. Cloud data and downloaded backups remain.</p><button disabled={busy} onClick={() => void backup()}>Download backup first</button><label className="account-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/>I saved the backup I need, or accept losing this device's unsynced changes.</label><button disabled={busy || !acknowledged} onClick={() => void perform(async current => { await removal.remove(); if (current()) { setRemoval(undefined); setNotice('Account data removed from this device.') } }, 'This device copy could not be removed. If saved data changed, review removal again.')}>Remove this device copy</button><button disabled={busy} onClick={() => { setRemoval(undefined); setAcknowledged(false) }}>Cancel removal</button></div>}
    {error && <p role="alert" ref={alert} tabIndex={-1}>{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>
}

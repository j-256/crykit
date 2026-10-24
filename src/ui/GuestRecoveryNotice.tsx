import { subscribeLocalData } from '../persistence/local-data'
import { useEffect, useState } from 'react'
import { guestRecoveryNotices, observeGuestRecovery, inspectRepositoryGuestRecovery, exportRepositoryGuestRecovery, copyRepositoryGuestRecovery } from '../workspace/guest-repository'
import { type GuestRecoveryNotice as Notice, type LegacyExportSink } from '../workspace/guest-recovery'
import { LEGACY_MONITOR_INTERVAL_MS } from '../workspace/legacy-capture'
import type { WorkspaceRepository } from '../workspace/repository'

interface RecoveryPicker { showSaveFilePicker(options: { suggestedName: string }): Promise<{ createWritable(): Promise<LegacyExportSink> }> }
export function GuestRecoveryNotice({ repository, canReplace }: { readonly repository: WorkspaceRepository; readonly canReplace: () => boolean }) {
  const [retry, setRetry] = useState(0)
  const [paused, setPaused] = useState(false)
  const [notices, setNotices] = useState<readonly Notice[]>([])
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [inspection, setInspection] = useState('')
  const [copyNotice, setCopyNotice] = useState<Notice>()
  const [copying, setCopying] = useState(false)
  useEffect(() => {
    let live = true, running = false, stopped = false, failures = 0
    let controller: AbortController | undefined
    const check = async () => {
      if (running || stopped || document.visibilityState === 'hidden') return
      running = true; controller = new AbortController(); setChecking(true)
      try {
        const result = await guestRecoveryNotices(repository, controller.signal)
        if (live) { setNotices(result); setError(''); failures = result.some(value => value.status === 'incomplete') ? failures + 1 : 0; if (failures >= 2) { stopped = true; setPaused(true) } }
      } catch { if (live) { setError('The older local workspace could not be checked. Keep it until recovery is complete.'); if (++failures >= 2) { stopped = true; setPaused(true) } } }
      finally { running = false; if (live) setChecking(false) }
    }
    const foreground = () => { if (document.visibilityState === 'hidden') controller?.abort(); else void check() }
    let cleanup = () => {}
    void observeGuestRecovery(repository, value => {
      if (!live) return
      setNotices(value.notices); setChecking(value.checking); setPaused(value.paused)
      setError(value.incomplete ? 'The older local workspace could not be checked. Keep it until recovery is complete.' : '')
    }).then(unsubscribeManaged => {
      if (!live) { unsubscribeManaged?.(); return }
      if (unsubscribeManaged) { cleanup = unsubscribeManaged; return }
      const interval = window.setInterval(() => { void check() }, LEGACY_MONITOR_INTERVAL_MS)
      window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground)
      const unsubscribe = subscribeLocalData(() => { void check() })
      cleanup = () => { controller?.abort(); unsubscribe(); window.clearInterval(interval); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground) }
      void check()
    }).catch(() => { if (live) setError('The older local workspace could not be checked. Keep it until recovery is complete.') })
    return () => { live = false; cleanup() }
  }, [repository, retry])
  const inspect = async (notice: Notice) => {
    try {
      const { plannerRecords, editorRecords } = await inspectRepositoryGuestRecovery(repository, notice)
      setInspection(`The retained branch contains ${plannerRecords} planner records and ${editorRecords} editor records. Its exact originals remain separate from this workspace.`)
    } catch { setError('The retained branch could not be captured completely. Its stored data remains unchanged.') }
  }
  const download = async (notice: Notice) => {
    try {
      const picker = window as unknown as Partial<RecoveryPicker>
      if (!picker.showSaveFilePicker) { setError('Use a browser with streamed file saving to export this exact recovery branch. The stored branch remains available.'); return }
      const handle = await picker.showSaveFilePicker({ suggestedName: 'crykit-local-recovery.bin' })
      await exportRepositoryGuestRecovery(repository, notice, await handle.createWritable())
      setInspection('The exact recovery branch was exported. It remains stored until you intentionally recover or discard it.')
    } catch { setError('The recovery export did not finish. The stored branch remains unchanged.') }
  }
  const copy = async (notice: Notice) => {
    setCopying(true)
    try {
      await copyRepositoryGuestRecovery(repository, notice, canReplace)
      setCopyNotice(undefined)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The retained data could not be copied. Both workspaces remain stored.') }
    finally { setCopying(false) }
  }
  if (!notices.length && !error) return null
  return <section className="panel guest-recovery-notice" role="alert" aria-label="Older local workspace needs recovery"><h2>Older local edits need recovery</h2><p>Your newer workspace and open drafts are preserved. Review the separate older branch before copying or syncing all local work.</p>{checking && <p role="status">Checking retained local data...</p>}{error && <p>{error}</p>}{paused && <p>Automatic checks paused after repeated incomplete attempts. <button onClick={() => { setPaused(false); setRetry(value => value + 1); void guestRecoveryNotices(repository).catch(() => {}) }}>Retry recovery check</button></p>}{notices.map(notice => <div key={notice.id}><p>{notice.status === 'diverged' ? 'An older tab changed its saved data after this workspace opened.' : 'The retained branch could not be compared completely.'}</p><button onClick={() => { void inspect(notice) }}>Inspect retained data</button><button onClick={() => { void download(notice) }}>Export exact recovery branch</button><button onClick={() => setCopyNotice(notice)}>Copy retained data into this workspace</button></div>)}{copyNotice && <div><p>Close older CryKit tabs before continuing. This replaces the selected saved workspace with the captured retained branch. Both saved versions remain recoverable. Later edits in older tabs stay in their separate branch.</p><button disabled={copying} onClick={() => { void copy(copyNotice) }}>Confirm recovery copy</button><button disabled={copying} onClick={() => setCopyNotice(undefined)}>Cancel recovery copy</button></div>}{inspection && <p role="status">{inspection}</p>}</section>
}

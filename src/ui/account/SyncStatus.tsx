import type { ReactElement } from 'react'
import type { SyncState } from '../../account/sync/scheduler'

export interface SyncStatusProps {
  readonly localSaveState: 'saved' | 'saving' | 'unsaved' | 'error'
  readonly syncState: SyncState
  readonly onRetry: () => void
  readonly onReview: () => void
}
const labels: Record<SyncState, string> = {
  synced: 'Synced', syncing: 'Syncing', offline: 'Offline with changes waiting',
  'signin-required': 'Needs sign-in', conflict: 'Conflicting versions', quota: 'Storage full',
  failed: 'Sync failed', paused: 'Sync paused',
}
export function SyncStatus({ localSaveState, syncState, onRetry, onReview }: SyncStatusProps): ReactElement {
  const saved = localSaveState === 'saved'
  const review = ['signin-required', 'conflict', 'quota'].includes(syncState)
  return <aside aria-label="Account sync" className="account-sync-status">
    <div role={localSaveState === 'error' ? 'alert' : undefined} aria-live="polite"><strong>{saved ? 'Saved on this device' : localSaveState === 'saving' ? 'Saving on this device' : localSaveState === 'error' ? 'Save failed' : 'Unsaved changes'}</strong>{localSaveState === 'error' && <p>Keep your open draft. Retry its save or download it for recovery before leaving.</p>}</div>
    <div role="status">{labels[syncState]}</div>{!saved && <span>Sync status describes previously saved changes.</span>}
    {review ? <button type="button" onClick={onReview}>{syncState === 'conflict' ? 'Review versions' : syncState === 'quota' ? 'Review storage' : 'Sign in'}</button> : ['failed', 'paused', 'offline'].includes(syncState) && <button type="button" onClick={onRetry}>Retry</button>}
  </aside>
}

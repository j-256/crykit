import { useEffect, useRef, useState } from 'react'
import { selectedPlaythrough } from '../domain'
import type { LocalData } from '../domain/types'
import { activateOfflineUpdate, getOfflineStatus, refreshOfflineApplication, requestOfflineReadiness, requestPersistentStorage, subscribeOfflineStatus, type OfflineStatus } from '../offline'
import { Badge, Button, InlineNotice } from './components'
import { downloadBytes, formatAppError } from './model'
import { useNavigation, useNavigationBlocker } from './navigation'
import { useNavigationNotice } from './useNavigationNotice'
import { ErrorMessage } from './ErrorMessage'
import { OFFLINE_EXTRAS, type OfflineExtra } from '../offline-content'

type StorageOperation = 'prepare' | 'refresh' | 'update' | 'persist' | 'export'
export const APP_REFRESH_PENDING_MESSAGE = 'Wait for the app refresh to finish before leaving this section.'
const BYTES_PER_MB = 1_000_000
const appSize = (bytes: number) => `${(bytes / BYTES_PER_MB).toFixed(1)} MB`

export function StorageSection({ localData, dirty, saving, saveError, onExport, onExportWorkspace, onReloadingChange }: { localData: LocalData; dirty: boolean; saving: boolean; saveError?: string; onExport: () => Promise<Uint8Array>; onExportWorkspace?: () => Promise<void>; onReloadingChange: (value: boolean) => void }) {
  const [offline, setOffline] = useState<OfflineStatus>({ state: 'checking' })
  const [operation, setOperation] = useState<StorageOperation>()
  const [persisted, setPersisted] = useState<boolean>()
  const [exportError, setExportError] = useState<string>()
  const [storageError, setStorageError] = useState<string>()
  const [extras, setExtras] = useState<readonly OfflineExtra[]>([])
  const selectionInitialized = useRef(false)
  const { noticeRef, revealNotice } = useNavigationNotice()
  const reloading = useRef(false)
  const navigation = useNavigation()
  const busy = operation !== undefined || saving
  const preparing = operation === 'prepare' || offline.state === 'checking'
  const selectionReady = offline.state === 'ready' && extras.every(id => offline.contents?.find(content => content.id === id)?.ready !== false)
  const reloadBlocked = busy || preparing || dirty || Boolean(saveError)
  useNavigationBlocker(navigation.route, () => reloading.current, () => { setStorageError(APP_REFRESH_PENDING_MESSAGE); revealNotice() })
  useEffect(() => {
    const unsubscribe = subscribeOfflineStatus(value => {
      setOffline(value)
      if (value.selectionKnown && value.contents && !selectionInitialized.current) {
        selectionInitialized.current = true
        setExtras(value.contents.filter(content => content.id !== 'core' && content.selected).map(content => content.id as OfflineExtra))
      }
    })
    void getOfflineStatus().catch(() => setStorageError('Offline readiness could not be inspected.'))
    return unsubscribe
  }, [])

  const runStorageOperation = async (next: StorageOperation, action: () => Promise<unknown>) => {
    setOperation(next)
    setStorageError(undefined)
    reloading.current = next === 'refresh' || next === 'update'
    onReloadingChange(reloading.current)
    try { await action() } catch (reason) { setStorageError(formatAppError(reason, 'The storage operation could not be completed.')) } finally { reloading.current = false; onReloadingChange(false); setOperation(undefined) }
  }
  const exportNow = async () => {
    setOperation('export')
    setExportError(undefined)
    try {
      if (onExportWorkspace) { await onExportWorkspace(); return }
      const label = selectedPlaythrough(localData)?.label ?? 'planner'
      downloadBytes(await onExport(), `crykit-${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-') || 'playthrough'}.zip`, 'application/zip')
    } catch (error) { setExportError(formatAppError(error, 'The backup could not be prepared.')) } finally { setOperation(undefined) }
  }

  return <div className="stack">
    {saveError && <InlineNotice title="Local save failed" tone="danger"><ErrorMessage message={saveError}/> Retry the failed save before creating a complete backup. The save error also offers a separate planner recovery copy.</InlineNotice>}
    {dirty && <InlineNotice title="Unsaved changes" tone="warning">Save open forms before exporting. A complete backup stops if an open form cannot be saved.</InlineNotice>}
    {storageError && <div aria-label="Storage navigation warning" ref={noticeRef} role="region" tabIndex={-1}><InlineNotice title={storageError === APP_REFRESH_PENDING_MESSAGE ? 'App refresh is still in progress' : 'Storage operation failed'} tone={storageError === APP_REFRESH_PENDING_MESSAGE ? 'warning' : 'danger'}>{storageError}</InlineNotice></div>}
    <section className="settings-section">
      <div className="split"><div><h3>Portable backup</h3><p className="settings-section__intro">{onExportWorkspace ? 'Includes saved records, private files, drafts and history. Store this backup privately.' : 'Back up your planner data. Download Mod Inspector files and edited game saves separately.'}</p></div><Button disabled={busy} icon="download" onClick={() => void exportNow()}>Export backup</Button></div>
      {exportError && <InlineNotice title="Export failed" tone="danger">{exportError}</InlineNotice>}
    </section>
    <section className="settings-section">
      <div className="split"><div><h3>Use CryKit offline</h3><p className="settings-section__intro">{offline.detail ?? 'Checking downloaded app files...'}</p></div><Badge icon={selectionReady ? 'check' : offline.state === 'error' ? 'warning' : 'info'} tone={selectionReady ? 'positive' : offline.state === 'error' ? 'danger' : 'neutral'}>{selectionReady ? 'Offline ready' : offline.state === 'checking' ? 'Checking' : offline.state === 'unsupported' ? 'Unsupported' : offline.state === 'error' ? 'Unavailable' : 'Not ready'}</Badge></div>
      {offline.state !== 'unsupported' && <>
        <p className="settings-section__intro"><strong>Core app included</strong> · Planner, reference data and editing tools{offline.contents?.find(content => content.id === 'core') ? ` · ${appSize(offline.contents.find(content => content.id === 'core')!.bytes)} of app files` : ''}</p>
        <fieldset className="offline-downloads"><legend>Optional downloads</legend>{(Object.entries(OFFLINE_EXTRAS) as [OfflineExtra, typeof OFFLINE_EXTRAS[OfflineExtra]][]).map(([id, option]) => {
          const content = offline.contents?.find(content => content.id === id)
          return <label className="check-row" key={id}><input aria-label={option.label} checked={extras.includes(id)} disabled={busy || preparing} onChange={event => { const selected = event.target.checked; selectionInitialized.current = true; setExtras(previous => selected ? [...previous, id] : previous.filter(value => value !== id)) }} type="checkbox"/><span><strong>{option.label}{content ? ` · ${appSize(content.bytes)}` : ''}{content?.ready ? ' · Downloaded' : ''}</strong><small>{option.detail}</small></span></label>
        })}</fieldset>
        <Button disabled={busy || preparing} icon="download" onClick={() => void runStorageOperation('prepare', () => requestOfflineReadiness(extras))} tone="secondary">Prepare for offline use</Button>
        {offline.progress && <div className="offline-download-progress" role="status"><progress aria-label="Offline download" max={offline.progress.totalFiles} value={offline.progress.completedFiles}/><span>{offline.progress.completedFiles} of {offline.progress.totalFiles} files · {appSize(offline.progress.completedBytes)} of {appSize(offline.progress.totalBytes)}</span></div>}
        <p className="settings-section__intro">Only selected extras are prepared for offline use. Unchecking an extra keeps its downloaded files.</p>
      </>}
      {offline.updateAvailable && <Button disabled={reloadBlocked} onClick={() => void runStorageOperation('update', activateOfflineUpdate)} tone="secondary">{dirty ? 'Save or discard changes before updating' : 'Apply app update'}</Button>}
      <p className="settings-section__intro">{import.meta.env.DEV ? 'Reload this tab to load the latest preview.' : 'Missing an update? Refresh the app files and reload this tab.'} Your saved Playthroughs, Builds, imports, and Mod Inspector drafts will be kept.{!import.meta.env.DEV && ' A connection is required.'}</p>
      <Button disabled={reloadBlocked || !import.meta.env.DEV && offline.state === 'unsupported'} onClick={() => void runStorageOperation('refresh', refreshOfflineApplication)} tone="secondary">{operation === 'refresh' ? 'Refreshing app...' : 'Refresh app'}</Button>
      {(dirty || saving || saveError) && <p className="settings-section__intro">Save or discard changes and resolve any failed save before refreshing.</p>}
    </section>
    <section className="settings-section">
      <div className="split"><div><h3>Help keep data on this device</h3><p className="settings-section__intro">Ask your browser to protect saved data when storage is low. Keep a backup too; clearing site data still removes your records.</p></div>{persisted !== undefined && <Badge icon={persisted ? 'shield' : 'info'} tone={persisted ? 'positive' : 'neutral'}>{persisted ? 'Storage protection granted' : 'Browser did not grant protection'}</Badge>}</div>
      <Button disabled={busy} icon="shield" onClick={() => void runStorageOperation('persist', async () => setPersisted(await requestPersistentStorage()))} tone="secondary">Ask browser to keep data</Button>
    </section>
  </div>
}

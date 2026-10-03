import { useEffect, useRef, useState } from 'react'
import { requirePlaythrough } from '../domain'
import type { LocalData } from '../domain/types'
import { activateOfflineUpdate, getOfflineStatus, refreshOfflineApplication, requestOfflineReadiness, requestPersistentStorage, subscribeOfflineStatus, type OfflineStatus } from '../offline'
import { Badge, Button, InlineNotice } from './components'
import { downloadBytes, formatAppError } from './model'
import { useNavigation, useNavigationBlocker } from './navigation'

type StorageOperation = 'prepare' | 'refresh' | 'update' | 'persist' | 'export'
export const APP_REFRESH_PENDING_MESSAGE = 'Wait for the app refresh to finish before leaving this section.'

export function StorageSection({ localData, dirty, saving, saveError, onExport, onReloadingChange }: { localData: LocalData; dirty: boolean; saving: boolean; saveError?: string; onExport: () => Promise<Uint8Array>; onReloadingChange: (value: boolean) => void }) {
  const [offline, setOffline] = useState<OfflineStatus>({ state: 'checking' })
  const [operation, setOperation] = useState<StorageOperation>()
  const [persisted, setPersisted] = useState<boolean>()
  const [exportError, setExportError] = useState<string>()
  const [storageError, setStorageError] = useState<string>()
  const reloading = useRef(false)
  const navigation = useNavigation()
  const busy = operation !== undefined || saving
  const reloadBlocked = busy || dirty || Boolean(saveError)
  useNavigationBlocker(navigation.route, () => reloading.current, () => setStorageError(APP_REFRESH_PENDING_MESSAGE))
  useEffect(() => {
    const unsubscribe = subscribeOfflineStatus(setOffline)
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
      const label = requirePlaythrough(localData).label
      downloadBytes(await onExport(), `crykit-${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-') || 'playthrough'}.zip`, 'application/zip')
    } catch (error) { setExportError(formatAppError(error, 'The backup could not be prepared.')) } finally { setOperation(undefined) }
  }

  return <div className="stack">
    {saveError && <InlineNotice title="Local save failed" tone="danger">{saveError} The retained transaction is included in a recovery backup. Fields still only in an unsubmitted form are not included.</InlineNotice>}
    {dirty && <InlineNotice title="Unsaved changes" tone="warning">Save or submit open form fields before exporting. Backups include retained failed-save transactions, but not fields that still exist only in a form.</InlineNotice>}
    {storageError && <InlineNotice title="Storage operation failed" tone="danger">{storageError}</InlineNotice>}
    <section className="settings-section">
      <div className="split"><div><h3>Portable backup</h3><p className="settings-section__intro">Export planner data for recovery or transfer. Download Mod Inspector originals and drafts separately.</p></div><Button disabled={busy} icon="download" onClick={() => void exportNow()}>Export backup</Button></div>
      {exportError && <InlineNotice title="Export failed" tone="danger">{exportError}</InlineNotice>}
    </section>
    <section className="settings-section">
      <div className="split"><div><h3>Offline application</h3><p className="settings-section__intro">{offline.detail ?? 'Checking cached application files...'}</p></div><Badge tone={offline.state === 'ready' ? 'positive' : offline.state === 'error' ? 'danger' : 'warning'}>{offline.state === 'ready' ? 'Offline ready' : offline.state === 'checking' ? 'Checking' : offline.state === 'unsupported' ? 'Unsupported' : offline.state === 'error' ? 'Unavailable' : 'Not ready'}</Badge></div>
      {offline.state !== 'ready' && offline.state !== 'unsupported' && <Button disabled={busy} icon="download" onClick={() => void runStorageOperation('prepare', requestOfflineReadiness)} tone="secondary">Prepare for offline use</Button>}
      {offline.updateAvailable && <Button disabled={reloadBlocked} onClick={() => void runStorageOperation('update', activateOfflineUpdate)} tone="secondary">{dirty ? 'Save or discard changes before updating' : 'Apply app update'}</Button>}
      <p className="settings-section__intro">Missing an update? Refresh the app files and reload this tab. Your saved Playthroughs, Builds, imports, and Mod Inspector drafts will be kept. A connection is required.</p>
      <Button disabled={reloadBlocked || offline.state === 'unsupported'} onClick={() => void runStorageOperation('refresh', refreshOfflineApplication)} tone="secondary">{operation === 'refresh' ? 'Refreshing app...' : 'Refresh app'}</Button>
      {(dirty || saving || saveError) && <p className="settings-section__intro">Save or discard changes and resolve any failed save before refreshing.</p>}
    </section>
    <section className="settings-section">
      <div className="split"><div><h3>Browser storage</h3><p className="settings-section__intro">Persistent storage can reduce eviction risk but is not a backup.</p></div>{persisted !== undefined && <Badge tone={persisted ? 'positive' : 'warning'}>{persisted ? 'Persistence granted' : 'Request not granted'}</Badge>}</div>
      <Button disabled={busy} onClick={() => void runStorageOperation('persist', async () => setPersisted(await requestPersistentStorage()))} tone="secondary">Request persistent storage</Button>
    </section>
  </div>
}

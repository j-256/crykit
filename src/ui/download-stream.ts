import { captureProfileEpoch, currentProfileToken, trackProfileUrl } from '../account/profile'
import { exportWorkspaceBackup } from '../interchange/workspace-backup'
import { assertWorkspaceSnapshotCurrent, captureWorkspaceSnapshot, disposeWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/snapshot'
import type { WorkspaceRepository } from '../workspace/repository'
import { markWorkspaceBackup, WORKSPACE_BACKUP_PHASE } from '../diagnostics/workspace-backup'

export const WORKSPACE_DOWNLOAD_FALLBACK_BYTES = 128 * 1024 * 1024
const URL_LIFETIME_MS = 30_000
export interface DownloadSink { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> }
export async function writeDownloadStream(stream: AsyncIterable<Uint8Array>, sink: DownloadSink, check: () => void): Promise<void> {
  try {
    check()
    for await (const bytes of stream) { check(); await sink.write(bytes); check() }
    check(); await sink.close(); check()
  } catch (error) { await sink.abort(error).catch(() => {}); throw error }
}
export async function collectDownloadBlob(stream: AsyncIterable<Uint8Array>, check: () => void): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let length = 0
  for await (const bytes of stream) {
    check(); length += bytes.length
    if (length > WORKSPACE_DOWNLOAD_FALLBACK_BYTES) throw new Error('This backup is too large for this browser download. Use a browser with streamed file saving; your saved data is unchanged.')
    chunks.push(bytes.slice())
  }
  check(); return new Blob(chunks, { type: 'application/octet-stream' })
}
export function requestWorkspaceDownload(): Promise<DownloadSink | undefined> {
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<DownloadSink> }> }).showSaveFilePicker
  if (!picker) return Promise.resolve(undefined)
  // The picker must start in the explicit click, before capture or owner flush consumes user activation
  return picker({ suggestedName: 'crykit-workspace.crykit', types: [{ description: 'CryKit private workspace', accept: { 'application/octet-stream': ['.crykit'] } }] }).then(handle => handle.createWritable())
}
export async function downloadWorkspaceBackup(snapshot: WorkspaceSnapshot, destination = requestWorkspaceDownload()): Promise<void> {
  const profile = captureProfileEpoch(), token = currentProfileToken()
  const sink = await destination
  try {
    profile.assertCurrent()
    markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.encoding)
    if (sink) await writeDownloadStream(exportWorkspaceBackup(snapshot), sink, profile.assertCurrent)
    else {
      const blob = await collectDownloadBlob(exportWorkspaceBackup(snapshot), profile.assertCurrent)
      markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.encoded)
      await assertWorkspaceSnapshotCurrent(snapshot); profile.assertCurrent()
      const url = URL.createObjectURL(blob)
      try {
        if (token) trackProfileUrl(token, url)
        profile.assertCurrent()
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'crykit-workspace.crykit'; anchor.click()
        markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.downloadRequested)
        setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME_MS)
      } catch (error) { URL.revokeObjectURL(url); throw error }
    }
  } catch (error) { await sink?.abort(error).catch(() => {}); throw error }
}
export async function downloadCapturedWorkspace(repository: WorkspaceRepository, flush: () => Promise<void> = async () => {}): Promise<void> {
  markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.requested)
  const profile = captureProfileEpoch()
  const destination = requestWorkspaceDownload()
  let snapshot: WorkspaceSnapshot | undefined, sink: DownloadSink | undefined
  try {
    sink = await destination; profile.assertCurrent()
    markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.destinationReady)
    await flush(); profile.assertCurrent()
    markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.flushed)
    snapshot = await captureWorkspaceSnapshot(repository); profile.assertCurrent()
    markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.captured)
    await downloadWorkspaceBackup(snapshot, Promise.resolve(sink))
  } catch (error) { markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.failed); await sink?.abort(error).catch(() => {}); throw error }
  finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); markWorkspaceBackup(WORKSPACE_BACKUP_PHASE.released) }
}

export const WORKSPACE_BACKUP_MARK = 'crykit-workspace-backup'
export const WORKSPACE_BACKUP_PHASE = Object.freeze({
  requested: 'requested',
  destinationReady: 'destination-ready',
  flushed: 'flushed',
  captured: 'captured',
  encoding: 'encoding',
  encoded: 'encoded',
  downloadRequested: 'download-requested',
  failed: 'failed',
  released: 'released',
})

type BackupPhase = typeof WORKSPACE_BACKUP_PHASE[keyof typeof WORKSPACE_BACKUP_PHASE]

export function markWorkspaceBackup(phase: BackupPhase): void {
  if (typeof performance === 'undefined' || !performance.mark || !performance.clearMarks) return
  // Retain only the latest local phase, without workspace identities, filenames or content
  // An observer can retain progress before a stalled await without evaluating the blocked page
  performance.clearMarks(WORKSPACE_BACKUP_MARK)
  performance.mark(WORKSPACE_BACKUP_MARK, { detail: { phase } })
}

import type { ConflictResolutionIntent } from './conflict-authority'
import type { CatalogSnapshot, LocalData, ModCatalogPin } from '../domain/types'
import type { CommitImportOptions, ImportPreview, LoadedLocalData, LocalDataNotification, PersistedHistoryEntry, SourceArchiveRecord } from '../interchange/types'
import type { LocalDataWriteResult } from '../persistence/local-data'
import type { WorkspaceState } from './documents'

export interface WorkspaceRepository {
  readonly kind: 'guest' | 'account'
  readWorkspace(): Promise<WorkspaceState>
  commitWorkspace(next: WorkspaceState, expectedRevision: number, options?: { readonly conflictResolution: ConflictResolutionIntent }): Promise<LoadedLocalData>
  load(): Promise<LoadedLocalData>
  save(localData: LocalData, expectedRevision: number): Promise<LocalDataWriteResult>
  undo(expectedRevision: number): Promise<LocalDataWriteResult>
  previewImport(bytes: Uint8Array, filename: string): Promise<ImportPreview>
  commitImport(preview: ImportPreview, options?: CommitImportOptions): Promise<LoadedLocalData>
  commitModSetup(previews: readonly ImportPreview[], expectedRevision: number, skip?: boolean): Promise<LoadedLocalData>
  prepareModCatalogs(localData: LocalData, catalogs: readonly CatalogSnapshot[]): Promise<readonly CatalogSnapshot[]>
  readModSource(pin: ModCatalogPin): Promise<{ filename: string; text: string }>
  readSources(): Promise<readonly SourceArchiveRecord[]>
  readHistory(): Promise<readonly PersistedHistoryEntry[]>
  exportPlannerBackup(localDataOverride?: LocalData): Promise<Uint8Array>
  subscribe(listener: (event: LocalDataNotification) => void): () => void
}

export class WorkspaceError extends Error {
  constructor(readonly code: 'LOCAL_REVISION_CONFLICT' | 'ACCOUNT_CAPABILITY_UNAVAILABLE' | 'LOCAL_INTEGRITY_FAILED' | 'LOCAL_MATERIALIZATION_LIMIT', message: string) { super(message) }
}

import type { CorrectionCollection } from '../domain/corrections'
import type {
  CatalogId,
  CatalogSnapshot,
  JsonValue,
  LocalData,
  LocalDataId,
  SourceRef,
  Timestamp,
} from '../domain/types'

export type ImportFormat = 'research-json-1.1.0' | 'research-zip-1.1.0' | 'xlsx-v2' | 'native-backup-2.0.0' | 'native-backup-2.1.0' | 'crystal-edit-json-1'
export type ImportGroup = 'reference' | 'personal' | 'mixed' | 'ignored'

export interface ImportProblem {
  readonly severity: 'warning' | 'error'
  readonly code: string
  readonly message: string
  readonly locator?: string
}

export interface ImportCounts {
  readonly reference: number
  readonly personal: number
  readonly mixed: number
  readonly ignored: number
}

export interface EvidenceRecord {
  readonly id: string
  readonly sourceDigest: string
  readonly group: ImportGroup
  readonly kind: string
  readonly locator: string
  readonly sources: readonly SourceRef[]
  readonly payload: JsonValue
  readonly private: boolean
}

export interface SourceArchiveRecord {
  readonly id: string
  readonly digest: string
  readonly filename: string
  readonly mediaType: string
  readonly format: ImportFormat
  readonly importedAt: Timestamp
  readonly bytes: Uint8Array
}

export interface LocalDataLineage {
  readonly rootLocalDataId: LocalDataId
  readonly parentLocalDataId?: LocalDataId
  readonly sourceLocalDataId?: LocalDataId
  readonly sourceRevision?: number
  readonly forkedAt?: Timestamp
}

export interface PersistedHistoryEntry {
  readonly id: string
  readonly localDataId: LocalDataId
  readonly command: string
  readonly previousRevision: number
  readonly nextRevision: number
  readonly before: LocalData
  readonly after: LocalData
  readonly recordedAt: Timestamp
}

export interface ImportCandidate {
  readonly corrections?: CorrectionCollection
  readonly localData: LocalData
  readonly lineage: LocalDataLineage
  readonly catalogs: readonly CatalogSnapshot[]
  readonly evidence: readonly EvidenceRecord[]
  readonly sources: readonly SourceArchiveRecord[]
  readonly history: readonly PersistedHistoryEntry[]
}

export interface ImportPreview {
  readonly id: string
  readonly filename: string
  readonly detectedFormat: ImportFormat
  readonly detectedSchema: string
  readonly sourceDigest: string
  readonly counts: ImportCounts
  readonly warnings: readonly ImportProblem[]
  readonly errors: readonly ImportProblem[]
  readonly localData: {
    readonly label: string
    readonly identity?: LocalDataId
    readonly ancestry?: LocalDataLineage
  }
  readonly proposed: ImportCandidate
}

export type ImportCommitMode = 'replace' | 'add-reference'

export interface CommitImportOptions {
  readonly restoreCorrections?: boolean
  readonly mode?: ImportCommitMode
  readonly targetLocalDataId?: LocalDataId
  readonly expectedRevision?: number
  readonly includeModInReference?: CatalogId
}

export interface LoadedLocalData {
  readonly localData: LocalData
  readonly lineage: LocalDataLineage
  readonly catalogs: readonly CatalogSnapshot[]
  readonly evidence: readonly EvidenceRecord[]
  readonly revision: number
  readonly canUndo: boolean
}

export interface LocalDataNotification {
  readonly localDataId: LocalDataId
  readonly revision: number
  readonly reason: 'save' | 'import' | 'undo'
}

export interface NativeBackupSourceManifest {
  readonly id: string
  readonly digest: string
  readonly filename: string
  readonly mediaType: string
  readonly format: ImportFormat
  readonly importedAt: Timestamp
  readonly path: string
  readonly size: number
}

export interface NativeBackupManifest {
  readonly format: 'crykit-backup'
  readonly formatVersion: '2.0.0' | '2.1.0'
  readonly exportedAt: Timestamp
  readonly payload: 'bundle.json'
  readonly sources: readonly NativeBackupSourceManifest[]
  readonly history?: {
    readonly stored: number
    readonly exported: number
    readonly truncated: boolean
  }
}

export interface NativeBackupPayload {
  readonly corrections?: CorrectionCollection
  readonly localData: LocalData
  readonly lineage: LocalDataLineage
  readonly catalogs: readonly CatalogSnapshot[]
  readonly bundledCatalogs?: readonly Pick<CatalogSnapshot, 'id' | 'revisionId' | 'checksum'>[]
  readonly evidence: readonly EvidenceRecord[]
  readonly history: readonly PersistedHistoryEntry[]
}

import type { CorrectionCollection } from '../domain/corrections'
import type {
  CatalogSnapshot,
  JsonValue,
  Profile,
  ProfileId,
  SourceRef,
  Timestamp,
} from '../domain/types'

export type ImportFormat = 'research-json-1.1.0' | 'research-zip-1.1.0' | 'xlsx-v2' | 'native-backup-1.0.0' | 'crystal-edit-json-1'
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

export interface ProfileLineage {
  readonly rootProfileId: ProfileId
  readonly parentProfileId?: ProfileId
  readonly sourceProfileId?: ProfileId
  readonly sourceRevision?: number
  readonly forkedAt?: Timestamp
}

export interface PersistedHistoryEntry {
  readonly id: string
  readonly profileId: ProfileId
  readonly command: string
  readonly previousRevision: number
  readonly nextRevision: number
  readonly before: Profile
  readonly after: Profile
  readonly recordedAt: Timestamp
}

export interface ImportCandidate {
  readonly corrections?: CorrectionCollection
  readonly profile: Profile
  readonly lineage: ProfileLineage
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
  readonly profile: {
    readonly label: string
    readonly identity?: ProfileId
    readonly ancestry?: ProfileLineage
  }
  readonly proposed: ImportCandidate
}

export type ImportCommitMode = 'new-profile' | 'merge' | 'replace' | 'add-reference'

export interface CommitImportOptions {
  readonly restoreCorrections?: boolean
  readonly mode?: ImportCommitMode
  readonly targetProfileId?: ProfileId
  readonly expectedRevision?: number
}

export interface Workspace {
  readonly profile: Profile
  readonly lineage: ProfileLineage
  readonly catalogs: readonly CatalogSnapshot[]
  readonly evidence: readonly EvidenceRecord[]
  readonly revision: number
  readonly canUndo: boolean
}

export interface WorkspaceNotification {
  readonly profileId: ProfileId
  readonly revision: number
  readonly reason: 'save' | 'import' | 'undo' | 'active-profile'
}

export interface ProfileSummary {
  readonly id: ProfileId
  readonly label: string
  readonly revision: number
  readonly updatedAt: Timestamp
  readonly lineage: ProfileLineage
  readonly active: boolean
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
  readonly format: 'crystal-companion-backup'
  readonly formatVersion: '1.0.0'
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
  readonly profile: Profile
  readonly lineage: ProfileLineage
  readonly catalogs: readonly CatalogSnapshot[]
  readonly evidence: readonly EvidenceRecord[]
  readonly history: readonly PersistedHistoryEntry[]
}

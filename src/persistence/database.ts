import Dexie, { type EntityTable } from 'dexie'
import type { CatalogSnapshot, Profile, ProfileId, Timestamp } from '../domain/types'
import type {
  EvidenceRecord,
  PersistedHistoryEntry,
  ProfileLineage,
  SourceArchiveRecord,
} from '../interchange/types'

export interface ProfileRecord {
  readonly id: string
  readonly revision: number
  readonly updatedAt: Timestamp
  readonly profile: Profile
  readonly lineage: ProfileLineage
}

export interface CatalogRecord {
  readonly key: string
  readonly id: string
  readonly revisionId: string
  readonly checksum: string
  readonly snapshot: CatalogSnapshot
}

export interface ImportRecord {
  readonly id: string
  readonly sourceDigest: string
  readonly profileId: ProfileId
  readonly importedAt: Timestamp
}

export interface MetaRecord {
  readonly key: string
  readonly value: string
}

export class CrystalCompanionDatabase extends Dexie {
  profiles!: EntityTable<ProfileRecord, 'id'>
  catalogs!: EntityTable<CatalogRecord, 'key'>
  evidence!: EntityTable<EvidenceRecord, 'id'>
  sources!: EntityTable<SourceArchiveRecord, 'id'>
  history!: EntityTable<PersistedHistoryEntry, 'id'>
  imports!: EntityTable<ImportRecord, 'id'>
  meta!: EntityTable<MetaRecord, 'key'>

  constructor(name = 'crystal-companion') {
    super(name)
    this.version(1).stores({
      profiles: 'id, revision, updatedAt',
      catalogs: 'key, id, revisionId, checksum',
      evidence: 'id, sourceDigest, group',
      sources: 'id, digest, format',
      history: 'id, profileId, [profileId+nextRevision]',
      imports: 'id, sourceDigest, profileId',
      meta: 'key',
    })
  }
}

let defaultDatabase: CrystalCompanionDatabase | undefined

export function getDatabase(): CrystalCompanionDatabase {
  defaultDatabase ??= new CrystalCompanionDatabase()
  return defaultDatabase
}

export function setDatabaseForTests(database: CrystalCompanionDatabase | undefined): void {
  defaultDatabase = database
}

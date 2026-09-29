import Dexie, { type EntityTable } from 'dexie'
import type { CatalogSnapshot, LocalData, LocalDataId, Timestamp } from '../domain/types'
import type {
  EvidenceRecord,
  PersistedHistoryEntry,
  LocalDataLineage,
  SourceArchiveRecord,
} from '../interchange/types'

export interface LocalDataRecord {
  readonly id: string
  readonly revision: number
  readonly updatedAt: Timestamp
  readonly localData: LocalData
  readonly lineage: LocalDataLineage
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
  readonly localDataId: LocalDataId
  readonly importedAt: Timestamp
}

export interface MetaRecord {
  readonly key: string
  readonly value: string
}

export class CrystalCompanionDatabase extends Dexie {
  localDatas!: EntityTable<LocalDataRecord, 'id'>
  catalogs!: EntityTable<CatalogRecord, 'key'>
  evidence!: EntityTable<EvidenceRecord, 'id'>
  sources!: EntityTable<SourceArchiveRecord, 'id'>
  history!: EntityTable<PersistedHistoryEntry, 'id'>
  imports!: EntityTable<ImportRecord, 'id'>
  meta!: EntityTable<MetaRecord, 'key'>

  constructor(name = 'crystal-companion-v2') {
    super(name)
    this.version(1).stores({
      localDatas: 'id, revision, updatedAt',
      catalogs: 'key, id, revisionId, checksum',
      evidence: 'id, sourceDigest, group',
      sources: 'id, digest, format',
      history: 'id, localDataId, [localDataId+nextRevision]',
      imports: 'id, sourceDigest, localDataId',
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

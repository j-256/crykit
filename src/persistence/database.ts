import Dexie, { type EntityTable } from 'dexie'
import { NativeHistorySchema, StoredNativeLocalDataSchema } from '../interchange/native-schema'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
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

export class CryKitDatabase extends Dexie {
  localDatas!: EntityTable<LocalDataRecord, 'id'>
  catalogs!: EntityTable<CatalogRecord, 'key'>
  evidence!: EntityTable<EvidenceRecord, 'id'>
  sources!: EntityTable<SourceArchiveRecord, 'id'>
  history!: EntityTable<PersistedHistoryEntry, 'id'>
  imports!: EntityTable<ImportRecord, 'id'>
  meta!: EntityTable<MetaRecord, 'key'>

  constructor(name = 'crykit') {
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
    const migrate = async (transaction: import('dexie').Transaction) => {
      const storedCatalogs = (await transaction.table<CatalogRecord>('catalogs').toArray()).map(record => record.snapshot)
      const catalogs = [...new Map([...BUNDLED_CATALOGS, ...storedCatalogs].map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog])).values()]
      const localDatas = transaction.table<LocalDataRecord>('localDatas')
      for (const record of await localDatas.toArray()) {
        const localData = StoredNativeLocalDataSchema.parse(record.localData) as unknown as LocalData
        validateNativeLocalDataGraph(localData, catalogs)
        await localDatas.put({ ...record, localData })
      }
      const history = transaction.table<PersistedHistoryEntry>('history')
      for (const entry of await history.toArray()) {
        const migrated = NativeHistorySchema.parse(entry) as unknown as PersistedHistoryEntry
        validateNativeLocalDataGraph(migrated.before, catalogs)
        validateNativeLocalDataGraph(migrated.after, catalogs)
        await history.put(migrated)
      }
    }
    this.version(2).stores({}).upgrade(migrate)
    this.version(3).stores({}).upgrade(migrate)
    this.version(4).stores({}).upgrade(migrate)
  }
}

let defaultDatabase: CryKitDatabase | undefined

export function getDatabase(): CryKitDatabase {
  defaultDatabase ??= new CryKitDatabase()
  return defaultDatabase
}

export function setDatabaseForTests(database: CryKitDatabase | undefined): void {
  defaultDatabase = database
}

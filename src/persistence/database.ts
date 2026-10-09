import Dexie, { type EntityTable } from 'dexie'
import { NativeHistorySchema, StoredNativeLocalDataSchema } from '../interchange/native-schema'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { BUNDLED_CATALOGS, BUNDLED_SOURCE_ENTITY_IDS } from '../catalog/bundled'
import { HISTORICAL_BUNDLED_CATALOG } from '../domain/withdrawn-catalogs'
import { upgradeBundledReferences } from '../domain/bundled-reference-upgrade'
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
    // Roots and undo snapshots must migrate in the same upgrade transaction
    // A bad history entry must roll back roots and the database version rather than leave undo incompatible
    const migrate = async (transaction: import('dexie').Transaction) => {
      const storedCatalogs = (await transaction.table<CatalogRecord>('catalogs').toArray()).map(record => record.snapshot)
      const catalogs = [...new Map([...storedCatalogs, ...BUNDLED_CATALOGS].map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog])).values()]
      const localDatas = transaction.table<LocalDataRecord>('localDatas')
      for (const record of await localDatas.toArray()) {
        const localData = upgradeBundledReferences(StoredNativeLocalDataSchema.parse(record.localData) as unknown as LocalData, HISTORICAL_BUNDLED_CATALOG, BUNDLED_SOURCE_ENTITY_IDS)
        validateNativeLocalDataGraph(localData, catalogs)
        await localDatas.put({ ...record, localData })
      }
      const history = transaction.table<PersistedHistoryEntry>('history')
      for (const entry of await history.toArray()) {
        const parsed = NativeHistorySchema.parse(entry) as unknown as PersistedHistoryEntry
        const migrated = { ...parsed, before: upgradeBundledReferences(parsed.before, HISTORICAL_BUNDLED_CATALOG, BUNDLED_SOURCE_ENTITY_IDS), after: upgradeBundledReferences(parsed.after, HISTORICAL_BUNDLED_CATALOG, BUNDLED_SOURCE_ENTITY_IDS) }
        validateNativeLocalDataGraph(migrated.before, catalogs)
        validateNativeLocalDataGraph(migrated.after, catalogs)
        await history.put(migrated)
      }
    }
    this.version(2).stores({}).upgrade(migrate)
    this.version(3).stores({}).upgrade(migrate)
    this.version(4).stores({}).upgrade(migrate)
    this.version(5).stores({}).upgrade(migrate)
    this.version(6).stores({}).upgrade(migrate)
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

import type {
  CatalogId,
  CatalogRevisionId,
  ChangeId,
  ImportReceiptId,
  InventoryEventId,
  InventoryPositionId,
  LocalData,
  LocalDataId,
  ProgressRecordId,
  Timestamp,
} from '../domain/types'
import { createBlankLocalData as createDomainBlankLocalData, createPlaythrough } from '../domain/local-data'
export { sha256 } from './sha256'

export function nowTimestamp(): Timestamp {
  return new Date().toISOString() as Timestamp
}

export function randomId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

export function createBlankLocalData(label = 'My playthrough', timestamp = nowTimestamp()): LocalData {
  return createPlaythrough(createDomainBlankLocalData({ now: timestamp }), { label, now: timestamp })
}

export const asLocalDataId = (value: string): LocalDataId => value as LocalDataId
export const asCatalogId = (value: string): CatalogId => value as CatalogId
export const asCatalogRevisionId = (value: string): CatalogRevisionId => value as CatalogRevisionId
export const asProgressRecordId = (value: string): ProgressRecordId => value as ProgressRecordId
export const asInventoryPositionId = (value: string): InventoryPositionId => value as InventoryPositionId
export const asInventoryEventId = (value: string): InventoryEventId => value as InventoryEventId
export const asImportReceiptId = (value: string): ImportReceiptId => value as ImportReceiptId
export const asChangeId = (value: string): ChangeId => value as ChangeId

export function stableSourceId(digest: string): string {
  return `source:sha256:${digest}`
}

export function cloneJson<Value>(value: Value): Value {
  return structuredClone(value)
}

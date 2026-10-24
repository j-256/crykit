import type { CatalogSnapshot, LocalData } from '../domain/types'
import type { PersistedHistoryEntry } from '../interchange/types'
import { isImmutableCatalogSnapshot } from '../interchange/native'
import { NativeHistorySchema, StoredNativeLocalDataSchema } from '../interchange/native-schema'
import { validateLocalDataForStorage } from '../persistence/local-data'

const histories = new WeakSet<object>()
const endpoints = new WeakSet<object>()
const frozen = new WeakSet<object>()
const domains = new WeakMap<LocalData, readonly CatalogSnapshot[]>()
const metadataSchema = NativeHistorySchema.omit({ before: true, after: true })

function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || frozen.has(value)) return
  for (const child of Object.values(value)) freeze(child)
  Object.freeze(value)
  frozen.add(value)
}
function remember(value: PersistedHistoryEntry): PersistedHistoryEntry {
  freeze(value)
  histories.add(value); endpoints.add(value.before); endpoints.add(value.after)
  return value
}

// Only this owner's successful complete schema admission proves immutable historical shape
// Caller freezing, IDs and physical refs cannot bypass validation or supply storage authority
export function immutableHistory(value: PersistedHistoryEntry): PersistedHistoryEntry {
  if (histories.has(value)) return value
  if (endpoints.has(value.before) && endpoints.has(value.after)) {
    const { before: _before, after: _after, ...metadata } = value
    metadataSchema.parse(metadata)
  } else NativeHistorySchema.parse(value)
  return remember(value)
}

// Old full frames retain the existing schema's normalization; compact reconstructed endpoints
// already have exact native shapes and must retain sharing instead of cloning every past root
export function parseImmutableHistory(value: unknown): PersistedHistoryEntry {
  if (value && typeof value === 'object' && histories.has(value)) return value as PersistedHistoryEntry
  return remember(NativeHistorySchema.parse(value) as unknown as PersistedHistoryEntry)
}
export function validateHistoryEndpointShape(value: LocalData): void {
  if (!endpoints.has(value)) StoredNativeLocalDataSchema.parse(value)
}
export function immutableHistoryEndpoint(value: LocalData): LocalData {
  if (!endpoints.has(value)) { validateHistoryEndpointShape(value); freeze(value); endpoints.add(value) }
  return value
}

// Shape admission is independent of catalog-sensitive semantics, and neither authenticates bytes
// The captured ordered catalog identities must still match; mutable inputs always run the full graph check
export function validateHistoryEndpoint(value: LocalData, catalogs: readonly CatalogSnapshot[]): void {
  const reusable = endpoints.has(value) && Object.isFrozen(catalogs) && catalogs.every(isImmutableCatalogSnapshot)
  const previous = reusable ? domains.get(value) : undefined
  if (previous && previous.length === catalogs.length && previous.every((catalog, at) => catalog === catalogs[at])) return
  validateLocalDataForStorage(value, catalogs)
  if (reusable) domains.set(value, Object.freeze([...catalogs]))
}
// This query proves pure shape ownership only, not catalog validity or durable storage health
export function isImmutableHistoryEndpoint(value: LocalData): boolean { return endpoints.has(value) }

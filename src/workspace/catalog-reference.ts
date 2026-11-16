import { maxDocumentBytes } from '../account/protocol'
import { encodeBackupJson } from '../interchange/workspace-backup-json'
import { immutableCatalogSnapshot } from '../interchange/native'
import { sourcePayloadValid } from '../domain/source-fulfillment'
import { parseCatalogSourceId, parseSourceRevision } from '../domain/source-identity'
import { blobIdentity, verifiedBlob } from './blobs'
import { decodeWorkspaceDocument } from './document-codec'
import { decodeCatalogPayload } from './catalog-codec'
import { privateRecordKey, type WorkspaceState } from './documents'

export * from './catalog-reference-schema'
import { CatalogBodyRefSchema, RetainedCatalogReferenceSchema } from './catalog-reference-schema'
type Body = WorkspaceState['blobs'][number]
export interface OwnedCatalogRegistry { readonly kind: 'owned-catalog-registry' }
interface Registration { readonly bodies: ReadonlyMap<string, Body>; readonly check: () => Promise<void> }
const registries = new WeakMap<OwnedCatalogRegistry, Registration>()
export const sameCatalogBodyRef = (a: Body['ref'], b: Body['ref']): boolean => a.documentId === b.documentId && a.revisionId === b.revisionId && a.byteLength === b.byteLength && a.sha256 === b.sha256 && a.encoding === b.encoding

// Registration retains a revocable read capability, never an admission assertion
// Every resolution still authenticates backing bytes through EOF even after a previous successful read
export function ownCatalogRegistry(entries: readonly Body[], check: () => Promise<void>): OwnedCatalogRegistry {
  const bodies = new Map<string, Body>()
  for (const entry of entries) {
    const ref = Object.freeze(CatalogBodyRefSchema.parse(entry.ref)), key = blobIdentity(ref)
    if (bodies.has(key) || entry.content.byteLength !== ref.byteLength) throw new Error('Duplicate or inconsistent catalog body')
    const open = entry.content.open.bind(entry.content)
    const authenticated = verifiedBlob({ byteLength: ref.byteLength, open }, ref.sha256)
    const content = Object.freeze({ byteLength: ref.byteLength, async *open() {
      await check()
      for await (const bytes of authenticated.open()) { await check(); yield bytes; await check() }
      await check()
    } })
    bodies.set(key, Object.freeze({ ref, content }))
  }
  const handle: OwnedCatalogRegistry = Object.freeze({ kind: 'owned-catalog-registry' })
  registries.set(handle, { bodies, check })
  return handle
}

export async function resolveRetainedCatalog(input: unknown, registry: OwnedCatalogRegistry, reserveExpanded?: (bytes: number) => void) {
  const owned = registries.get(registry)
  if (!owned) throw new Error('An owned catalog registry is required')
  const reference = RetainedCatalogReferenceSchema.parse(input)
  const identity = parseCatalogSourceId(reference.catalogId)
  if (!identity || !parseSourceRevision(identity.origin, reference.catalogRevisionId)) throw new Error('Invalid retained catalog identity')
  await owned.check()
  const body = owned.bodies.get(blobIdentity(reference.body))
  if (!body || !sameCatalogBodyRef(body.ref, reference.body)) throw new Error('Missing or inconsistent retained catalog body')
  const document = await decodeWorkspaceDocument(body.content)
  if (document.kind !== 'catalog' || document.key !== privateRecordKey('catalog', reference.catalogId, reference.catalogRevisionId)
    || !document.value || typeof document.value !== 'object' || !('kind' in document.value) || document.value.kind !== 'compressed-catalog-snapshot') throw new Error('Retained catalog frame association mismatch')
  // Decode only after the entire exact frame is authenticated; bundle equality cannot hide a bad saved tail
  const snapshot = immutableCatalogSnapshot(decodeCatalogPayload(document.value, reserveExpanded) as import('../domain/types').CatalogSnapshot)
  if (snapshot.id !== reference.catalogId || snapshot.revisionId !== reference.catalogRevisionId || snapshot.checksum !== reference.checksum || snapshot.schemaVersion !== reference.schemaVersion || !sourcePayloadValid(snapshot)) throw new Error('Retained catalog source mismatch')
  await owned.check()
  return Object.freeze({ snapshot, body })
}

// One hydrated snapshot owns this budget; historical members receive independent serial budgets
// Inline token bytes conservatively include structural overhead without allocating one giant JSON string
export const MAX_EXPANDED_SNAPSHOT_CATALOG_BYTES = maxDocumentBytes
export function catalogExpansionBudget() {
  let remaining = MAX_EXPANDED_SNAPSHOT_CATALOG_BYTES
  const reserve = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) throw new Error('Expanded snapshot catalog budget exceeded')
    remaining -= bytes
  }
  return { reserve, inline(snapshot: unknown) { for (const page of encodeBackupJson(snapshot)) reserve(page.byteLength) } }
}

import { SOURCE_REVISION_RECEIPTS, type BundledSourceRevisionReceipt } from '../catalog/source-revisions'
import { checkpointContentDigest } from './checkpoint-identity'
import { parseCatalogSourceId, parseSourceRevision } from './source-identity'
import { sourcePayloadContent } from './source-payload'
import { deeplyImmutable } from './immutable-value'
import { jsonRecord } from './crystal-edit'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from './catalog-schemas'
import type { CatalogSnapshot, ModCatalogPin } from './types'

const samePin = (left: ModCatalogPin, right: { readonly catalogId: string; readonly catalogRevisionId: string }) => left.catalogId === right.catalogId && left.catalogRevisionId === right.catalogRevisionId
const catalogPin = (catalog: CatalogSnapshot): ModCatalogPin => ({ catalogId: catalog.id, catalogRevisionId: catalog.revisionId })
const validatedPayloads = new WeakMap<CatalogSnapshot, boolean>()

function bundledReceipt(pin: ModCatalogPin, receipts: readonly BundledSourceRevisionReceipt[]) {
  return receipts.find(receipt => receipt.id === pin.catalogId && receipt.revisionId === pin.catalogRevisionId)
}

export function sourcePayloadValid(catalog: CatalogSnapshot, receipts: readonly BundledSourceRevisionReceipt[] = SOURCE_REVISION_RECEIPTS): boolean {
  const cached = receipts === SOURCE_REVISION_RECEIPTS ? validatedPayloads.get(catalog) : undefined
  if (cached !== undefined) return cached
  const valid = validatePayload(catalog, receipts)
  // Mutable previews and caller-supplied receipts must be rechecked after every change
  if (receipts === SOURCE_REVISION_RECEIPTS && deeplyImmutable(catalog)) validatedPayloads.set(catalog, valid)
  return valid
}

function validatePayload(catalog: CatalogSnapshot, receipts: readonly BundledSourceRevisionReceipt[]): boolean {
  const identity = parseCatalogSourceId(catalog.id)
  if (!identity || !parseSourceRevision(identity.origin, catalog.revisionId)) return false
  const receipt = identity.origin !== 'imported' ? bundledReceipt(catalogPin(catalog), receipts) : undefined
  if (identity.origin !== 'imported' && (!receipt || receipt.checksum !== catalog.checksum)) return false
  if (catalog.payloadSource) {
    if (identity.origin !== 'mod' || !receipt?.payloadSource || !samePin(catalog.payloadSource, receipt.payloadSource)) return false
    if (parseCatalogSourceId(catalog.payloadSource.catalogId)?.origin !== 'imported' || !parseSourceRevision('imported', catalog.payloadSource.catalogRevisionId)) return false
  } else if (receipt?.payloadSource) return false
  if (catalog.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA) {
    const payload = catalog.payloadSource ?? catalogPin(catalog)
    const revision = parseSourceRevision('imported', payload.catalogRevisionId)
    const metadata = jsonRecord(catalog.legacy) ? catalog.legacy : undefined
    if (typeof metadata?.projectId !== 'string' || revision?.kind !== 'imported' || revision.encoding !== 'j1' || metadata.interpretation !== revision.interpretation || metadata.contentFingerprint !== `json-content-v1:sha256:${revision.digest}`) return false
    const key = checkpointContentDigest(['crykit-source-key', 1, 'crystal-project', 'crystal-edit', metadata.projectId])
    if (payload.catalogId !== `crystal-project/imported/ce1-${key}`) return false
  }
  const { checksum, ...content } = catalog
  const prefix = identity.origin === 'imported' || catalog.payloadSource ? 'payload:sha256:' : 'builtin:sha256:'
  return checksum === `${prefix}${checkpointContentDigest(sourcePayloadContent(content))}`
}

export function fulfillSource(requested: ModCatalogPin, catalogs: readonly CatalogSnapshot[], receipts: readonly BundledSourceRevisionReceipt[] = SOURCE_REVISION_RECEIPTS): { readonly catalog: CatalogSnapshot; readonly suppliedBy: ModCatalogPin } | undefined {
  // Exact snapshots have already passed admission; avoid hashing large bodies on every entity lookup
  const exact = catalogs.find(catalog => samePin(requested, catalogPin(catalog)))
  if (exact) return { catalog: exact, suppliedBy: catalogPin(exact) }
  const identity = parseCatalogSourceId(requested.catalogId)
  if (!identity || !parseSourceRevision(identity.origin, requested.catalogRevisionId)) return undefined
  const requestedReceipt = identity.origin === 'mod' ? bundledReceipt(requested, receipts) : undefined
  const payloadPin = identity.origin === 'imported' ? requested : requestedReceipt?.payloadSource
  if (!payloadPin) return undefined
  for (const catalog of catalogs) {
    const actualPayload = catalog.payloadSource ?? catalogPin(catalog)
    if (actualPayload.catalogId !== payloadPin.catalogId || actualPayload.catalogRevisionId !== payloadPin.catalogRevisionId || !sourcePayloadValid(catalog, receipts)) continue
    if (requestedReceipt && requestedReceipt.checksum !== catalog.checksum) continue
    const { payloadSource: _descriptor, ...payload } = catalog
    const view = { ...payload, id: requested.catalogId, revisionId: requested.catalogRevisionId, ...(requestedReceipt ? { payloadSource: actualPayload } : {}) }
    return { catalog: view, suppliedBy: catalogPin(catalog) }
  }
  return undefined
}

import { SOURCE_REVISION_RECEIPTS, type BundledSourceRevisionReceipt } from '../catalog/source-revisions'
import { checkpointContentDigest, checkpointContentDigestAsync } from './checkpoint-identity'
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

function payloadValidation(catalog: CatalogSnapshot, receipts: readonly BundledSourceRevisionReceipt[]) {
  const identity = parseCatalogSourceId(catalog.id)
  if (!identity || !parseSourceRevision(identity.origin, catalog.revisionId)) return false
  const receipt = identity.origin !== 'imported' ? bundledReceipt(catalogPin(catalog), receipts) : undefined
  // Complete retained vanilla/guide bodies prove their own integrity without shipping old receipts
  // Packaged revisions still require their pinned checksum; mod aliases still need trusted payload bindings
  if (receipt && receipt.checksum !== catalog.checksum || identity.origin === 'mod' && !receipt) return false
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
  return { checksum, prefix, content: sourcePayloadContent(content) }
}
function validatePayload(catalog: CatalogSnapshot, receipts: readonly BundledSourceRevisionReceipt[]): boolean {
  const validation = payloadValidation(catalog, receipts)
  return !!validation && validation.checksum === `${validation.prefix}${checkpointContentDigest(validation.content)}`
}

// Decide immutability before the first await; freezing a changed caller input later cannot bless old bytes
// Only canonical bundled receipts and a complete real digest may populate the existing exact-object cache
export async function prepareSourcePayloadValidation(catalog: CatalogSnapshot, check: () => void): Promise<boolean> {
  check()
  if (!deeplyImmutable(catalog)) throw new Error('Source preparation requires an immutable catalog')
  const cached = validatedPayloads.get(catalog)
  if (cached !== undefined) return cached
  await new Promise<void>(resolve => setTimeout(resolve, 0)); check()
  const validation = payloadValidation(catalog, SOURCE_REVISION_RECEIPTS)
  if (!validation) return false
  const digest = await checkpointContentDigestAsync(validation.content, check)
  check()
  await new Promise<void>(resolve => setTimeout(resolve, 0)); check()
  const valid = validation.checksum === `${validation.prefix}${digest}`
  if (valid) validatedPayloads.set(catalog, true)
  return valid
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

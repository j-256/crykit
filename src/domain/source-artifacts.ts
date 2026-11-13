import type { CatalogSnapshot } from './types'
import { SOURCE_REVISION_RECEIPTS } from '../catalog/source-revisions'

export interface ArtifactCatalogPin { readonly id: string; readonly revisionId: string; readonly checksum: string }

export function artifactSuppliesCatalog(source: { readonly catalogs?: readonly ArtifactCatalogPin[] }, catalog: Pick<CatalogSnapshot, 'id' | 'revisionId' | 'checksum' | 'payloadSource'>): boolean {
  // One exact original can support multiple interpretation revisions without changing its bytes
  const payload = catalog.payloadSource
  const trusted = payload && SOURCE_REVISION_RECEIPTS.some(receipt => receipt.id === catalog.id && receipt.revisionId === catalog.revisionId && receipt.checksum === catalog.checksum && receipt.payloadSource?.catalogId === payload.catalogId && receipt.payloadSource.catalogRevisionId === payload.catalogRevisionId)
  return source.catalogs?.some(pin => pin.checksum === catalog.checksum && (pin.id === catalog.id && pin.revisionId === catalog.revisionId || trusted && pin.id === payload.catalogId && pin.revisionId === payload.catalogRevisionId)) ?? false
}

export function mergeArtifactCatalogs(before: readonly ArtifactCatalogPin[] = [], incoming: readonly ArtifactCatalogPin[] = []): readonly ArtifactCatalogPin[] {
  const pins = new Map(before.map(pin => [JSON.stringify([pin.id, pin.revisionId]), pin]))
  for (const pin of incoming) {
    const key = JSON.stringify([pin.id, pin.revisionId])
    if (pins.has(key) && pins.get(key)!.checksum !== pin.checksum) throw new Error('An original source has conflicting catalog bindings')
    pins.set(key, pin)
  }
  return [...pins.values()].sort((left, right) => left.id.localeCompare(right.id) || left.revisionId.localeCompare(right.revisionId))
}

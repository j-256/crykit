import type { CatalogSnapshot } from './types'

export interface ArtifactCatalogPin { readonly id: string; readonly revisionId: string; readonly checksum: string }

export function artifactSuppliesCatalog(source: { readonly catalogs?: readonly ArtifactCatalogPin[] }, catalog: Pick<CatalogSnapshot, 'id' | 'revisionId' | 'checksum'>): boolean {
  // One exact original can support multiple interpretation revisions without changing its bytes
  return source.catalogs?.some(pin => pin.id === catalog.id && pin.revisionId === catalog.revisionId && pin.checksum === catalog.checksum) ?? false
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

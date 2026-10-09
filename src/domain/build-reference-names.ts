import { buildModReferences } from './build-references'
import { entityDefinitionKey } from './core'
import { jsonRecord } from './crystal-edit'
import { catalogEntity } from './entity-identities'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from './mod-layers'
import type { BuildReferenceName, BuildRevisionContent, CatalogSnapshot, EntityRef, GameSetupRevision, ModSourceReceipt } from './types'

export function buildReferenceName(content: BuildRevisionContent, ref: EntityRef | null | undefined): string | undefined {
  if (!ref || ref.kind !== 'catalog') return undefined
  return content.referenceNames?.find(entry => entityDefinitionKey(entry.ref) === entityDefinitionKey(ref))?.name
}

export function withBuildReferenceNames<Content extends BuildRevisionContent>(content: Content, catalogs: readonly CatalogSnapshot[], previous: readonly BuildReferenceName[] = []): Content {
  const names = new Map<string, BuildReferenceName>()
  const savedNames = new Map([...previous, ...content.referenceNames ?? []].map(entry => [entityDefinitionKey(entry.ref), entry]))
  const sourceEntries = new Map<string, { source: CatalogSnapshot; modelKey: string }>()
  const sourceKey = (provenance: CatalogSnapshot['entities'][string]['sources'][number]) => JSON.stringify([provenance.sourceId, provenance.locator])
  for (const source of catalogs) {
    if (source.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA || !jsonRecord(source.legacy) || !jsonRecord(source.legacy.crystalEditIdentities)) continue
    const identities = new Map(Object.entries(source.legacy.crystalEditIdentities).map(([key, id]) => [id, key]))
    for (const record of Object.values(source.entities)) {
      const modelKey = identities.get(record.id)
      if (modelKey) for (const provenance of record.sources) sourceEntries.set(sourceKey(provenance), { source, modelKey })
    }
  }
  for (const ref of buildModReferences(content)) {
    if (ref.kind !== 'catalog') continue
    const key = entityDefinitionKey(ref)
    if (names.has(key)) continue
    const catalog = catalogs.find(value => value.id === ref.catalogId && value.revisionId === ref.catalogRevisionId)
    const entity = catalog && catalogEntity(catalog, ref.entityId)
    const saved = savedNames.get(key)
    if (!entity) { if (saved) names.set(key, saved); continue }
    // Source ID alone identifies the whole file; the locator selects this record within that file
    const origin = entity.sources.flatMap(provenance => sourceEntries.get(sourceKey(provenance)) ?? [])[0]
    names.set(key, { ref, name: entity.name, ...(origin ? { projectId: origin.source.id, modelKey: origin.modelKey } : {}) })
  }
  // Keep only selected entries; an old checkpoint's display receipts must not become a reusable catalog
  const { referenceNames: _names, ...rest } = content
  return { ...rest, ...(names.size ? { referenceNames: [...names.values()] } : {}) } as Content
}

export function modSourceReceipts(setup: GameSetupRevision, catalogs: readonly CatalogSnapshot[]): readonly ModSourceReceipt[] | undefined {
  const layers = setup.modComposition?.layers ?? []
  const receipts = layers.flatMap(pin => {
    const source = catalogs.find(value => value.id === pin.catalogId && value.revisionId === pin.catalogRevisionId)
    if (!source || source.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA) return setup.modSourceReceipts?.filter(value => value.catalogId === pin.catalogId && value.catalogRevisionId === pin.catalogRevisionId) ?? []
    const legacy = jsonRecord(source.legacy) ? source.legacy : {}
    return [{ catalogId: source.id, catalogRevisionId: source.revisionId, checksum: source.checksum, title: typeof legacy.projectTitle === 'string' ? legacy.projectTitle : source.id, ...(typeof legacy.contentFingerprint === 'string' ? { contentFingerprint: legacy.contentFingerprint } : {}) }]
  })
  return receipts.length ? receipts : undefined
}

export function assertModSourceReceipts(setup: Pick<GameSetupRevision, 'modComposition' | 'modSourceReceipts'>): void {
  const seen = new Set<string>()
  for (const receipt of setup.modSourceReceipts ?? []) {
    const key = JSON.stringify([receipt.catalogId, receipt.catalogRevisionId])
    if (seen.has(key) || !receipt.catalogId.startsWith('crystal-edit:') || !receipt.catalogRevisionId.startsWith(`${receipt.checksum}:`) || !/^sha256:[0-9a-f]{64}:rules-v\d+:library-v\d+$/.test(receipt.catalogRevisionId) || !setup.modComposition?.layers.some(pin => pin.catalogId === receipt.catalogId && pin.catalogRevisionId === receipt.catalogRevisionId)) throw new Error('A mod source receipt does not match a pinned source layer')
    seen.add(key)
  }
}

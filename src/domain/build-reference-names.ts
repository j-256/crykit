import { SOURCE_REVISION_RECEIPTS } from '../catalog/source-revisions'
import { definitionOrigins } from './definition-origins'
import { fulfillSource } from './source-fulfillment'
import { buildModReferences } from './build-references'
import { entityDefinitionKey } from './core'
import { jsonRecord } from './crystal-edit'
import { catalogEntity } from './entity-identities'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from './mod-layers'
import { parseCatalogSourceId, parseSourceRevision } from './source-identity'
import type { BuildReferenceName, BuildRevisionContent, CatalogSnapshot, EntityRef, GameSetupRevision, ModSourceReceipt } from './types'

export function buildReferenceName(content: BuildRevisionContent, ref: EntityRef | null | undefined): string | undefined {
  if (!ref || ref.kind !== 'catalog') return undefined
  return content.referenceNames?.find(entry => entityDefinitionKey(entry.ref) === entityDefinitionKey(ref))?.name
}

export function withBuildReferenceNames<Content extends BuildRevisionContent>(content: Content, catalogs: readonly CatalogSnapshot[], previous: readonly BuildReferenceName[] = []): Content {
  const names = new Map<string, BuildReferenceName>()
  const savedNames = new Map([...previous, ...content.referenceNames ?? []].map(entry => [entityDefinitionKey(entry.ref), entry]))
  for (const ref of buildModReferences(content)) {
    if (ref.kind !== 'catalog') continue
    const key = entityDefinitionKey(ref)
    if (names.has(key)) continue
    const catalog = fulfillSource(ref, catalogs)?.catalog
    const entity = catalog && catalogEntity(catalog, ref.entityId)
    const saved = savedNames.get(key)
    if (!entity) { if (saved) names.set(key, saved); continue }
    const mechanical = definitionOrigins(catalog!, entity)?.mechanical
    const source = mechanical && fulfillSource(mechanical, catalogs)?.catalog
    const identities = source && jsonRecord(source.legacy) && jsonRecord(source.legacy.crystalEditIdentities) ? source.legacy.crystalEditIdentities : {}
    const modelKey = Object.entries(identities).find(([, id]) => id === mechanical?.entityId)?.[0]
    names.set(key, { ref, name: entity.name, ...(mechanical && modelKey ? { projectId: mechanical.catalogId, modelKey } : {}) })
  }
  // Keep only selected entries; an old checkpoint's display receipts must not become a reusable catalog
  const { referenceNames: _names, ...rest } = content
  return { ...rest, ...(names.size ? { referenceNames: [...names.values()] } : {}) } as Content
}

export function modSourceReceipts(setup: GameSetupRevision, catalogs: readonly CatalogSnapshot[]): readonly ModSourceReceipt[] | undefined {
  const layers = setup.modComposition?.layers ?? []
  const receipts = layers.flatMap(pin => {
    const source = fulfillSource(pin, catalogs)?.catalog
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
    const source = parseCatalogSourceId(receipt.catalogId)
    const bundled = source?.origin === 'mod' && SOURCE_REVISION_RECEIPTS.find(value => value.id === receipt.catalogId && value.revisionId === receipt.catalogRevisionId && value.checksum === receipt.checksum)
    const payload = source?.origin === 'imported' ? receipt : bundled ? bundled.payloadSource : undefined
    const identity = payload && parseCatalogSourceId(payload.catalogId)
    const revision = payload && parseSourceRevision('imported', payload.catalogRevisionId)
    // Bundled distribution receipts must resolve to the same canonical imported payload
    // A display title or raw file digest cannot authorize a source or its interpretation
    const exact = identity?.origin === 'imported' && identity.key.startsWith('ce1-') && revision?.kind === 'imported' && revision.encoding === 'j1' && /^payload:sha256:[a-f0-9]{64}$/.test(receipt.checksum) && receipt.contentFingerprint === `json-content-v1:sha256:${revision.digest}`
    if (seen.has(key) || !exact || !setup.modComposition?.layers.some(pin => pin.catalogId === receipt.catalogId && pin.catalogRevisionId === receipt.catalogRevisionId)) throw new Error('A mod source receipt does not match a pinned source layer')
    seen.add(key)
  }
}

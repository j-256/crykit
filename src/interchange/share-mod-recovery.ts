import { CURRENT_CATALOG } from '../catalog/bundled'
import { createId, entityDefinitionKey } from '../domain/core'
import { catalogEntity } from '../domain/entity-identities'
import { modSourceReceipts, withBuildReferenceNames } from '../domain/build-reference-names'
import { composeModLayers, modCatalogForPin, modCatalogRevision, modCatalogTitle, modLinkKey, modModelEntity, nativeModModelKey, nativeModReplacementLinks, prepareModComposition } from '../domain/mod-layers'
import { modSourceMatch } from '../domain/mod-source-match'
import { withdrawnCatalog } from '../domain/withdrawn-catalogs'
import type { BuildReferenceName, CatalogRef, CatalogSnapshot, GameSetupRevision, GameSetupRevisionId } from '../domain/types'
import { shareWithMatchingSources, validateSharePayload, type SharePayload } from './share'

export interface SharedModRecovery {
  readonly payload?: SharePayload
  readonly changedInterpretation?: boolean
  readonly missingSources: readonly string[]
  readonly error?: string
}

function mapReferences<T>(value: T, map: (ref: CatalogRef) => CatalogRef): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(entry => mapReferences(entry, map)) as T
  const record = value as Record<string, unknown>
  if (record.kind === 'catalog') return map(value as unknown as CatalogRef) as T
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, mapReferences(entry, map)])) as T
}

// Recovery enriches a read-only preview without changing the original checkpoint's pins
// Exact project/model identities rebind selections; names never resolve missing definitions
export function prepareSharedModRecovery(payload: SharePayload, catalogs: readonly CatalogSnapshot[]): SharedModRecovery {
  const missingSources = new Set<string>()
  try {
    const compatible = shareWithMatchingSources(payload, catalogs)
    if (compatible) return { payload: compatible, missingSources: [] }
    const names = new Map<string, BuildReferenceName>()
    for (const revision of Object.values(payload.records.buildRevisions)) for (const entry of revision.content.referenceNames ?? []) {
      const key = entityDefinitionKey(entry.ref)
      const previous = names.get(key)
      if (previous && (previous.projectId !== entry.projectId || previous.modelKey !== entry.modelKey)) throw new Error('The shared checkpoints disagree about a selected mod identity.')
      names.set(key, entry)
    }
    const origins = new Map<string, { setup: GameSetupRevision; baseline: CatalogSnapshot; result: ReturnType<typeof composeModLayers> }>()
    const sourcePins = new Map<string, CatalogSnapshot>()
    for (const original of Object.values(payload.records.gameSetups)) {
      const composition = original.modComposition
      if (!composition) continue
      const sources = composition.layers.map(pin => {
        const receipt = original.modSourceReceipts?.find(entry => entry.catalogId === pin.catalogId && entry.catalogRevisionId === pin.catalogRevisionId)
        const source = modCatalogForPin(catalogs, pin) ?? (receipt && catalogs.find(catalog => modSourceMatch(receipt, catalog)))
        if (!source) missingSources.add(receipt?.title ?? pin.catalogId)
        else sourcePins.set(JSON.stringify([pin.catalogId, pin.catalogRevisionId]), source)
        return source
      })
      if (sources.some(source => !source)) continue
      const selected = sources as readonly CatalogSnapshot[]
      const exactBaseline = modCatalogForPin(catalogs, composition.baseline)
      // Only a recognized withdrawn application baseline qualifies for a recovered preview
      // An unrelated missing import must still be supplied rather than substituted
      const baseline = exactBaseline ?? (withdrawnCatalog(composition.baseline) && composition.baseline.catalogId === CURRENT_CATALOG.id ? modCatalogForPin(catalogs, { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }) : undefined)
      if (!baseline) throw new Error('The saved base catalog is unavailable and has no supported replacement. Import that catalog before applying the mod definitions.')
      const changed = baseline.revisionId !== composition.baseline.catalogRevisionId || selected.some((source, index) => source.revisionId !== composition.layers[index]!.catalogRevisionId)
      if (!changed) continue
      // Removed bundled mod targets rebind through selected project/model receipts instead
      const links = composition.links.filter(link => link.targetEntityId === null || Boolean(baseline.entities[link.targetEntityId]))
      for (const source of selected) for (const link of nativeModReplacementLinks(baseline, source)) if (!links.some(saved => modLinkKey(saved) === modLinkKey(link))) links.push(link)
      const next = prepareModComposition({ ...composition, baseline: { catalogId: baseline.id, catalogRevisionId: baseline.revisionId }, layers: composition.layers.map((pin, index) => ({ ...pin, catalogRevisionId: selected[index]!.revisionId })), links }, catalogs)
      const id = createId<GameSetupRevisionId>('gameSetupRevision')
      const setup: GameSetupRevision = { ...original, id, revision: original.revision + 1, modComposition: next, catalogLock: { ...original.catalogLock, [baseline.id]: modCatalogRevision(id) }, mods: { state: 'known', value: [...new Set(selected.filter((_source, index) => next.layers[index]!.enabled).map(modCatalogTitle))] } }
      origins.set(modCatalogRevision(original.id), { setup: { ...setup, modSourceReceipts: modSourceReceipts(setup, catalogs) }, baseline, result: composeModLayers(next, catalogs) })
    }
    if (missingSources.size) return { missingSources: [...missingSources] }
    if (!origins.size) return { missingSources: [] }
    const mapRef = (ref: CatalogRef): CatalogRef => {
      const origin = origins.get(ref.catalogRevisionId)
      const display = names.get(entityDefinitionKey(ref))
      if (origin && ref.catalogId === origin.setup.modComposition!.baseline.catalogId) {
        const modelKey = nativeModModelKey(catalogEntity(origin.baseline, ref.entityId))
        // A saved native selection may have a second reference alias used by the mod's replacement link
        // Follow only an explicit linked change of the same native identity; null links remain separate
        const replacement = modelKey && origin.result.changes.find(change => change.modelKey === modelKey && change.targetState === 'linked')
        const target = display?.projectId && display.modelKey ? origin.result.sourceIdentities[display.projectId]?.[display.modelKey] : replacement ? replacement.targetEntityId : ref.entityId
        if (!target || !origin.result.entities[target]) throw new Error(`The imported sources cannot resolve ${display?.name ?? ref.entityId}. The original checkpoint is preserved.`)
        return { ...ref, catalogRevisionId: modCatalogRevision(origin.setup.id), entityId: origin.result.entities[target]!.id }
      }
      const source = sourcePins.get(JSON.stringify([ref.catalogId, ref.catalogRevisionId]))
      if (!source || source.revisionId === ref.catalogRevisionId) return ref
      const entity = display?.projectId === source.id && display.modelKey ? modModelEntity(source, display.modelKey) : catalogEntity(source, ref.entityId)
      if (!entity) throw new Error(`The imported source cannot resolve ${display?.name ?? ref.entityId}. The original checkpoint is preserved.`)
      return { ...ref, catalogRevisionId: source.revisionId, entityId: entity.id }
    }
    const mapLock = (lock: GameSetupRevision['catalogLock']) => Object.fromEntries(Object.entries(lock).map(([id, revision]) => [id, origins.get(revision) ? modCatalogRevision(origins.get(revision)!.setup.id) : sourcePins.get(JSON.stringify([id, revision]))?.revisionId ?? revision])) as GameSetupRevision['catalogLock']
    const gameSetups = Object.fromEntries(Object.values(payload.records.gameSetups).map(original => {
      const setup = origins.get(modCatalogRevision(original.id))?.setup ?? original
      return [setup.id, { ...setup, catalogLock: mapLock(setup.catalogLock), ...(setup.definitionOverrides ? { definitionOverrides: mapReferences(setup.definitionOverrides, mapRef) } : {}) }]
    }))
    // Opaque personal fields retain their bytes; only typed lineage and requirements are references
    const personalDefinitions = Object.fromEntries(Object.entries(payload.records.personalDefinitions).map(([id, definition]) => [id, { ...definition, ...mapReferences({ baseRef: definition.baseRef, previousRevision: definition.previousRevision, requirements: definition.requirements }, mapRef) }]))
    const buildRevisions = Object.fromEntries(Object.entries(payload.records.buildRevisions).map(([id, revision]) => [id, { ...revision, gameSetupRevisionId: origins.get(modCatalogRevision(revision.gameSetupRevisionId))?.setup.id ?? revision.gameSetupRevisionId, catalogLock: mapLock(revision.catalogLock), content: withBuildReferenceNames(mapReferences(revision.content, mapRef), catalogs) }]))
    const teamGameSetupRevisionId = payload.teamGameSetupRevisionId && (origins.get(modCatalogRevision(payload.teamGameSetupRevisionId))?.setup.id ?? payload.teamGameSetupRevisionId)
    return { payload: validateSharePayload({ ...payload, version: 4, records: { ...payload.records, gameSetups, personalDefinitions, buildRevisions }, ...(teamGameSetupRevisionId ? { teamGameSetupRevisionId } : {}) }), changedInterpretation: true, missingSources: [] }
  } catch (reason) {
    return { missingSources: [...missingSources], error: reason instanceof Error ? reason.message : 'Matching imports could not be applied. The original checkpoint is preserved.' }
  }
}

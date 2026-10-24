import { buildModReferences } from '../domain/build-references'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import { publicKnowledge, type PublicCheckpointContext } from '../domain/public-source-context'
import { retainOutOfContextSelections } from '../domain/retained-selections'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createId, nowTimestamp, updateLocalData, entityDefinitionKey } from '../domain/core'
import { catalogEntity } from '../domain/entity-identities'
import { CRYSTAL_EDIT_CATALOG_SCHEMA, modModelEntity } from '../domain/mod-layers'
import { modSourceInterpretationMatches, modSourceMatch } from '../domain/mod-source-match'
import type { BuildCalculationPlan, BuildRevisionContent, BuildId, BuildRevisionId, TeamId, TeamRevisionId, TeamSlotCheckpointId, SlotId, CatalogRef, GameSetupRevision, CatalogEntity, CatalogSnapshot, EntityRef, ModSourceReceipt, PersonalDefinition } from '../domain/types'
import { blobIdentity } from '../workspace/blobs'
import { findPrivateArtwork } from '../workspace/artwork-repository'
import type { WorkspaceAsset, WorkspaceState } from '../workspace/documents'
import { publicPersonalDefinitionFingerprint } from './public-share'
import { publicRefKey, validatePublicSnapshot, type PublicEntityReceipt, type PublicLoadout, type PublicRef, type PublicSnapshot } from './public-share-schema'

export interface PublicEnrichedEntry {
  readonly receipt: PublicEntityReceipt
  readonly definition?: CatalogEntity | PersonalDefinition
  readonly viewerRef?: EntityRef
  readonly artwork?: WorkspaceAsset
  readonly adapted: boolean
}
export interface PublicEnrichment {
  readonly entries: readonly PublicEnrichedEntry[]
  readonly missingReceiptIds: readonly string[]
  readonly missingSources: readonly { readonly catalogId: string; readonly catalogRevisionId: string; readonly title: string }[]
  readonly adaptedProjections: readonly { readonly receiptId: string; readonly savedRevision: string; readonly viewerRevision: string }[]
  readonly resolved: boolean
  readonly unresolvedCalculations: boolean
}

function ownsSource(viewer: WorkspaceState, catalog: CatalogSnapshot): boolean {
  const digest = catalog.checksum.replace(/^sha256:/, '')
  return viewer.planner.sources.some(source => source.digest === digest && source.original.sha256 === digest && viewer.blobs.some(blob => blobIdentity(blob.ref) === blobIdentity(source.original)))
}
function sourceReceipt(snapshot: PublicSnapshot, receipt: PublicEntityReceipt): ModSourceReceipt | undefined {
  const layer = snapshot.setup.layers.find(layer => layer.catalogId === receipt.origin.projectId && layer.catalogRevisionId === receipt.origin.sourceRevisionId)
  return layer ? { ...layer, catalogId: layer.catalogId as ModSourceReceipt['catalogId'], catalogRevisionId: layer.catalogRevisionId as ModSourceReceipt['catalogRevisionId'], checksum: layer.checksum ?? '' } : undefined
}

// Only the viewer's selected repository supplies definitions and assets; public names are never resolution keys
// The returned projection is separate from the historical pins and cannot publish a changed interpretation
export function enrichPublicSnapshot(input: PublicSnapshot, viewer: WorkspaceState): PublicEnrichment {
  const snapshot = validatePublicSnapshot(input)
  const adaptedProjections: { receiptId: string; savedRevision: string; viewerRevision: string }[] = []
  const entries = snapshot.receipts.map((receipt): PublicEnrichedEntry => {
    if (receipt.ref.kind === 'personal') {
      const fingerprint = receipt.ref.fingerprint.value
      const matches = Object.values(viewer.planner.localData.personalDefinitions).filter(definition => {
        if (definition.kind !== receipt.kind) return false
        try { return publicPersonalDefinitionFingerprint(viewer.planner.localData, definition.id) === fingerprint } catch { return false }
      })
      const definition = matches[0]
      return definition ? { receipt, definition, viewerRef: { kind: 'personal', definitionId: definition.id }, adapted: false } : { receipt, adapted: false }
    }
    const origin = receipt.origin
    const requirement = sourceReceipt(snapshot, receipt)
    const candidates = viewer.planner.catalogs.filter(catalog => {
      if (catalog.id !== origin.projectId) return false
      if (catalog.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA) {
        if (!ownsSource(viewer, catalog)) return false
        return requirement ? Boolean(modSourceMatch(requirement, catalog)) : catalog.revisionId === origin.sourceRevisionId
      }
      // Bundled native definitions require an explicit exact baseline receipt, never a same-numeric-ID fallback
      const baseline = snapshot.setup.baseline
      return Boolean(baseline && baseline.catalogId === catalog.id && baseline.catalogRevisionId === catalog.revisionId && origin.sourceRevisionId === catalog.revisionId && BUNDLED_CATALOGS.some(native => native.id === catalog.id && native.revisionId === catalog.revisionId))
    })
    const exact = candidates.filter(catalog => catalog.revisionId === origin.sourceRevisionId)
    const eligible = exact.length ? exact : candidates
    // Conflicting parser projections cannot be selected by array order
    if (eligible.length !== 1) return { receipt, adapted: false }
    const source = eligible[0]!
    const definition = origin.modelKey ? modModelEntity(source, origin.modelKey) : catalogEntity(source, receipt.ref.entityId)
    if (!definition || definition.kind !== receipt.kind) return { receipt, adapted: false }
    const adapted = source.revisionId !== origin.sourceRevisionId && (!requirement || !modSourceInterpretationMatches(requirement, source))
    if (adapted) adaptedProjections.push({ receiptId: publicRefKey(receipt.ref), savedRevision: origin.sourceRevisionId, viewerRevision: source.revisionId })
    const viewerRef = { kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId: definition.id }
    // Artwork bindings compare the exact source pin; entity-reference fields are not part of that identity
    const artwork = findPrivateArtwork(viewer, { catalogId: source.id, catalogRevisionId: source.revisionId }, definition)
    return { receipt, definition, viewerRef, ...(artwork ? { artwork } : {}), adapted }
  })
  const missingReceiptIds = entries.filter(entry => !entry.definition).map(entry => publicRefKey(entry.receipt.ref))
  const missingSources = snapshot.setup.layers.filter(layer => !viewer.planner.catalogs.some(catalog => ownsSource(viewer, catalog) && modSourceMatch({ ...layer, catalogId: layer.catalogId as ModSourceReceipt['catalogId'], catalogRevisionId: layer.catalogRevisionId as ModSourceReceipt['catalogRevisionId'], checksum: layer.checksum ?? '' }, catalog)))
  const baseline = snapshot.setup.baseline
  const ownsBaseline = baseline && viewer.planner.catalogs.some(catalog => catalog.id === baseline.catalogId && catalog.revisionId === baseline.catalogRevisionId && BUNDLED_CATALOGS.some(native => native.id === catalog.id && native.revisionId === catalog.revisionId))
  return { entries, missingReceiptIds, missingSources, adaptedProjections, resolved: missingReceiptIds.length === 0 && missingSources.length === 0, unresolvedCalculations: !ownsBaseline || !snapshot.setup.catalogLock || missingReceiptIds.length > 0 || missingSources.length > 0 }
}


// The public payload carries equality among selected slots, never an allocation identity or inventory ownership
export function publicLoadoutContent(loadout: PublicLoadout, mapRef: (ref: PublicRef) => EntityRef): BuildRevisionContent {
  const groups = new Map<string, string>()
  for (const group of loadout.equipmentGroups) {
    const identity = createId('sharedEquipment')
    for (const slot of group) groups.set(slot, identity)
  }
  const calculationRefs = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(calculationRefs)
    if ('kind' in value && (value.kind === 'catalog' || value.kind === 'personal')) return mapRef(value as PublicRef)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, calculationRefs(entry)]))
  }
  return {
    primaryClass: loadout.primaryClass ? mapRef(loadout.primaryClass) : null,
    secondaryClass: loadout.secondaryClass ? mapRef(loadout.secondaryClass) : null,
    equipment: Object.fromEntries(loadout.equipment.map(entry => [entry.slotId, entry.ref ? { ref: mapRef(entry.ref), ...(groups.has(entry.slotId) ? { allocationId: groups.get(entry.slotId)! } : {}) } : null])),
    passives: loadout.passives.map(ref => ({ ref: mapRef(ref) })), contextAssumptions: [],
    ...(loadout.calculation ? { calculation: calculationRefs(loadout.calculation) as BuildCalculationPlan } : {}),
  }
}

export async function copyPublicSnapshot(repository: import('../workspace/repository').WorkspaceRepository, input: PublicSnapshot): Promise<{ buildId?: import('../domain/types').BuildId; teamId?: import('../domain/types').TeamId; loaded: import('./types').LoadedLocalData }> {
  const snapshot = validatePublicSnapshot(input)
  if (!snapshot.setup.catalogLock) throw new Error('This older link does not include its exact saved setup lock. Ask its owner to update the link before saving a copy.')
  const before = await repository.readWorkspace()
  const prepared = preparePublicSnapshotCopy(before, snapshot)
  // Setup, selected receipts and all Team-owned slots publish as one repository command
  const loaded = await repository.commitWorkspace(prepared.state, before.planner.localData.revision)
  return { ...prepared.result, loaded }
}

export function preparePublicSnapshotCopy(before: WorkspaceState, input: PublicSnapshot): { state: WorkspaceState; result: { buildId?: import('../domain/types').BuildId; teamId?: import('../domain/types').TeamId } } {
  const snapshot = validatePublicSnapshot(input)
  if (!snapshot.setup.catalogLock) throw new Error('This older link does not include its exact saved setup lock. Ask its owner to update the link before saving a copy.')
  if (snapshot.kind === 'build' && snapshot.notes?.checkpoint !== undefined) throw new Error('This Build has an unsupported shared header note. Ask its owner to put the note in the Build checkpoint before saving a copy.')
  const data = before.planner.localData, at = nowTimestamp()
  const setup: GameSetupRevision = { id: createId('gameSetupRevision'), gameSetupId: createId('gameSetup'), revision: 0, label: snapshot.title, platform: { state: 'unknown' }, gameVersion: { state: 'unknown' }, mode: publicKnowledge(snapshot.setup.mode), mods: { state: 'known', value: snapshot.setup.layers.map(layer => layer.title) }, ppCostsNonNegative: publicKnowledge(snapshot.setup.ppCostsNonNegative), ...(snapshot.setup.ppLimit ? { ppLimit: publicKnowledge(snapshot.setup.ppLimit) } : {}), ...(snapshot.setup.difficulty ? { difficulty: { version: 1, selection: publicKnowledge(snapshot.setup.difficulty) } } : {}), slots: snapshot.setup.slots.map((slot, order) => ({ ...slot, id: slot.id as SlotId, kind: 'equipment', order, provenance: 'imported', sources: [] })), catalogLock: snapshot.setup.catalogLock as GameSetupRevision['catalogLock'], publicSourceContext: { version: 1, setup: snapshot.setup }, createdAt: at }
  const refs = new Map<string, EntityRef>()
  const bindings: PublicCheckpointContext['personalBindings'] = []
  for (const receipt of snapshot.receipts) {
    const ref: EntityRef = receipt.ref.kind === 'catalog' ? receipt.ref as EntityRef : { kind: 'personal', definitionId: createId('personalDefinition') }
    refs.set(publicRefKey(receipt.ref), ref)
    if (receipt.ref.kind === 'personal' && ref.kind === 'personal') bindings.push({ fingerprint: receipt.ref.fingerprint.value, ref })
  }
  const unavailable = snapshot.receipts.map(receipt => ({ ref: refs.get(publicRefKey(receipt.ref))!, kind: receipt.kind, name: receipt.name, ...(receipt.fingerprint ? { fingerprint: receipt.fingerprint } : {}) }))
  const context: PublicCheckpointContext = { version: 1, setupDigest: checkpointContentDigest(setup.publicSourceContext), receipts: snapshot.receipts, personalBindings: bindings }
  const contents = snapshot.slots.map((slot, index) => {
    if (!slot) return null
    const notes = snapshot.notes?.slots[index]
    const raw = publicLoadoutContent(slot, ref => refs.get(publicRefKey(ref))!)
    const content = retainOutOfContextSelections(data, { ...raw, referenceNames: snapshot.receipts.flatMap(receipt => receipt.ref.kind === 'catalog' && buildModReferences(raw).some(ref => entityDefinitionKey(ref) === entityDefinitionKey(receipt.ref as EntityRef)) ? [{ ref: receipt.ref as CatalogRef, name: receipt.name, projectId: receipt.origin.projectId as CatalogRef['catalogId'], ...(receipt.origin.modelKey ? { modelKey: receipt.origin.modelKey } : {}) }] : []), contextAssumptions: notes?.contextAssumptions ?? [], ...(notes?.rotationNotes !== undefined ? { rotationNotes: notes.rotationNotes } : {}) }, setup, setup.catalogLock)
    return { id: createId<TeamSlotCheckpointId>('teamSlot'), ...(snapshot.kind === 'team' && slot.name !== undefined ? { name: slot.name } : {}), content, createdAt: at, ...(notes?.checkpoint !== undefined ? { note: notes.checkpoint } : {}) }
  })
  let next = { ...data, gameSetups: { ...data.gameSetups, [setup.id]: setup }, unavailableDefinitions: [...data.unavailableDefinitions ?? [], ...unavailable.filter(receipt => !data.unavailableDefinitions?.some(old => entityDefinitionKey(old.ref) === entityDefinitionKey(receipt.ref)))] }
  let result: { buildId?: BuildId; teamId?: TeamId }
  if (snapshot.kind === 'team') {
    const id = createId<TeamId>('team'), revisionId = createId<TeamRevisionId>('teamRevision')
    next = { ...next, teams: { ...next.teams, [id]: { id, kind: 'shared', revision: 0, title: snapshot.title, latestRevisionId: revisionId, createdAt: at, updatedAt: at } }, teamRevisions: { ...next.teamRevisions, [revisionId]: { id: revisionId, teamId: id, revision: 0, gameSetupRevisionId: setup.id, catalogLock: setup.catalogLock, slots: contents, createdAt: at, publicSourceContext: context, ...(snapshot.notes?.checkpoint !== undefined ? { note: snapshot.notes.checkpoint } : {}) } } }
    result = { teamId: id }
  } else {
    const id = createId<BuildId>('build'), revisionId = createId<BuildRevisionId>('buildRevision')
    next = { ...next, builds: { ...next.builds, [id]: { id, gameSetupId: setup.gameSetupId, revision: 0, title: snapshot.title, latestRevisionId: revisionId, archived: false, favorite: false, tags: [], createdAt: at, updatedAt: at } }, buildRevisions: { ...next.buildRevisions, [revisionId]: { id: revisionId, buildId: id, revision: 0, gameSetupRevisionId: setup.id, catalogLock: setup.catalogLock, content: contents[0]!.content, createdAt: at, publicSourceContext: context, ...(snapshot.notes?.slots[0]?.checkpoint !== undefined ? { note: snapshot.notes.slots[0].checkpoint } : {}) } } }
    result = { buildId: id }
  }
  const localData = updateLocalData(data, next, 'share.copy', ['gameSetups', 'builds', 'buildRevisions', 'teams', 'teamRevisions', 'unavailableDefinitions'], at)
  return { state: { ...before, planner: { ...before.planner, localData } }, result }
}

// This transient calculation view never enters repository persistence or changes the captured source context
export function publicReadOnlyPreview(snapshot: PublicSnapshot, viewer: WorkspaceState, enrichment = enrichPublicSnapshot(snapshot, viewer)) {
  const prepared = preparePublicSnapshotCopy(viewer, { ...snapshot, ...(snapshot.kind === 'build' && snapshot.notes ? { notes: { slots: snapshot.notes.slots } } : {}), setup: { ...snapshot.setup, catalogLock: snapshot.setup.catalogLock ?? {} } })
  const copied = prepared.state.planner.localData
  const copiedCheckpoint = prepared.result.buildId ? copied.buildRevisions[copied.builds[prepared.result.buildId]!.latestRevisionId!]! : copied.teamRevisions[(copied.teams[prepared.result.teamId!]! as import('../domain/types').SharedTeam).latestRevisionId]!
  const copiedSetup = copied.gameSetups[copiedCheckpoint.gameSetupRevisionId]!
  const sourcePins = snapshot.setup.layers.flatMap(layer => {
    const receipt: ModSourceReceipt = { ...layer, catalogId: layer.catalogId as ModSourceReceipt['catalogId'], catalogRevisionId: layer.catalogRevisionId as ModSourceReceipt['catalogRevisionId'], checksum: layer.checksum ?? '' }
    const matches = viewer.planner.catalogs.filter(catalog => ownsSource(viewer, catalog) && modSourceMatch(receipt, catalog))
    const exact = matches.filter(catalog => catalog.revisionId === layer.catalogRevisionId)
    const candidates = exact.length ? exact : matches
    return candidates.length === 1 ? [{ catalogId: candidates[0]!.id, catalogRevisionId: candidates[0]!.revisionId, enabled: true }] : [{ catalogId: receipt.catalogId, catalogRevisionId: receipt.catalogRevisionId, enabled: true }]
  })
  const baseline = snapshot.setup.baseline
  const catalogs = viewer.planner.catalogs.filter(catalog => sourcePins.some(pin => pin.catalogId === catalog.id && pin.catalogRevisionId === catalog.revisionId) || baseline?.catalogId === catalog.id && baseline.catalogRevisionId === catalog.revisionId)
  const { publicSourceContext: _sourceContext, ...plainSetup } = copiedSetup
  const setup: GameSetupRevision = { ...plainSetup, catalogLock: Object.fromEntries(catalogs.map(catalog => [catalog.id, catalog.revisionId])), ...(baseline ? { modComposition: { baseline: baseline as import('../domain/types').ModCatalogPin, layers: sourcePins, links: [] } } : {}) }
  const domainRef = (ref: PublicRef): EntityRef => {
    const resolved = enrichment.entries.find(entry => publicRefKey(entry.receipt.ref) === publicRefKey(ref))?.viewerRef
    if (resolved) return resolved
    if (ref.kind === 'catalog') return ref as EntityRef
    const binding = copiedCheckpoint.publicSourceContext!.personalBindings.find(binding => binding.fingerprint === ref.fingerprint.value)!
    return binding.ref as EntityRef
  }
  const localData = { ...copied, gameSetups: { ...copied.gameSetups, [setup.id]: setup }, personalDefinitions: viewer.planner.localData.personalDefinitions }
  const revisions = snapshot.slots.map((slot, index): import('../domain/types').BuildRevision | null => {
    if (!slot) return null
    const content = publicLoadoutContent(slot, domainRef)
    const selected = new Set(buildModReferences(content).map(entityDefinitionKey))
    const inactive = snapshot.receipts.filter(receipt => selected.has(entityDefinitionKey(domainRef(receipt.ref))) && receipt.ref.kind === 'catalog' && snapshot.setup.catalogLock?.[receipt.ref.catalogId] !== receipt.ref.catalogRevisionId).map(receipt => domainRef(receipt.ref))
    const removed = slot.equipment.filter(entry => entry.ref && !snapshot.setup.slots.some(slot => slot.id === entry.slotId)).map(entry => entry.slotId as SlotId)
    const notes = snapshot.notes?.slots[index]
    return { id: createId('buildRevision'), buildId: createId('build'), revision: 0, gameSetupRevisionId: setup.id, catalogLock: setup.catalogLock, content: { ...content, ...(inactive.length || removed.length ? { retainedSelections: { refs: inactive, slotIds: removed } } : {}), referenceNames: snapshot.receipts.flatMap(receipt => { const ref = domainRef(receipt.ref); return ref.kind === 'catalog' && selected.has(entityDefinitionKey(ref)) ? [{ ref, name: receipt.name }] : [] }), contextAssumptions: notes?.contextAssumptions ?? [], ...(notes?.rotationNotes !== undefined ? { rotationNotes: notes.rotationNotes } : {}) }, createdAt: copiedSetup.createdAt, ...(notes?.checkpoint ? { note: notes.checkpoint } : {}) }
  })
  return { localData, catalogs, revisions }
}

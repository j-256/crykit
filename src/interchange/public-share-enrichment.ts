import { PUBLIC_SETUP_CONTEXT_VERSION, PUBLIC_CHECKPOINT_CONTEXT_VERSION } from './public-source-context-schema'
import { definitionOrigins } from '../domain/definition-origins'
import { fulfillSource, sourcePayloadValid } from '../domain/source-fulfillment'
import { sourceCompositionDigest } from '../domain/source-composition'
import { buildModReferences } from '../domain/build-references'
import { buildContentForModSetup } from '../domain/build-mods'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import { publicKnowledge, PublicCheckpointContextSchema, type PublicCheckpointContext } from '../domain/public-source-context'
import { retainOutOfContextSelections } from '../domain/retained-selections'
import { createId, nowTimestamp, updateLocalData, entityDefinitionKey } from '../domain/core'
import { catalogEntity } from '../domain/entity-identities'
import { composeModCatalog, expandModCatalogs, modCatalogRevision, modModelEntity } from '../domain/mod-layers'
import { modSourceMatch } from '../domain/mod-source-match'
import type { BuildCalculationPlan, BuildRevisionContent, BuildId, BuildRevisionId, TeamId, TeamRevisionId, TeamSlotCheckpointId, SlotId, CatalogRef, GameSetupRevision, CatalogEntity, CatalogSnapshot, EntityRef, ModCatalogPin, ModSourceReceipt, PersonalDefinition } from '../domain/types'
import { findPrivateArtwork } from '../workspace/artwork-repository'
import type { WorkspaceAsset, WorkspaceState } from '../workspace/documents'
import { publicPersonalDefinitionFingerprint } from './public-share'
import { PUBLIC_COMPOSITION_REVISION_PREFIX, publicRefKey, validatePublicSnapshot, type PublicEntityReceipt, type PublicLoadout, type PublicRef, type PublicSnapshot } from './public-share-schema'

export interface PublicEnrichedEntry {
  readonly receipt: PublicEntityReceipt
  readonly definition?: CatalogEntity | PersonalDefinition
  readonly viewerRef?: EntityRef
  readonly artwork?: WorkspaceAsset
  readonly artworkSource?: { readonly catalogId: string; readonly catalogRevisionId: string; readonly entity: CatalogEntity }
}
export interface PublicEnrichment {
  readonly entries: readonly PublicEnrichedEntry[]
  readonly missingReceiptIds: readonly string[]
  readonly missingSources: readonly { readonly catalogId: string; readonly catalogRevisionId: string; readonly title: string }[]
  readonly resolved: boolean
  readonly unresolvedCalculations: boolean
}

function availableSource(viewer: WorkspaceState, pin: { catalogId: string; catalogRevisionId: string }): CatalogSnapshot | undefined {
  // Complete validated bodies are sufficient offline; original upload bytes are independent private artifacts
  const candidates = viewer.planner.catalogs.filter(catalog => sourcePayloadValid(catalog))
  const fulfilled = candidates.flatMap(catalog => {
    const match = fulfillSource(pin as ModCatalogPin, [catalog])?.catalog
    return match ? [match] : []
  })
  return new Set(fulfilled.map(catalog => catalog.checksum)).size === 1 ? fulfilled[0] : undefined
}
function layerSource(snapshot: PublicSnapshot, viewer: WorkspaceState, pin: { catalogId: string; catalogRevisionId: string }): CatalogSnapshot | undefined {
  const catalog = availableSource(viewer, pin)
  const receipt = snapshot.setup.layers.find(layer => layer.catalogId === pin.catalogId && layer.catalogRevisionId === pin.catalogRevisionId)
  if (!catalog || receipt?.checksum && receipt.checksum !== catalog.checksum) return undefined
  if (receipt?.contentFingerprint && !modSourceMatch({ ...receipt, catalogId: receipt.catalogId as ModSourceReceipt['catalogId'], catalogRevisionId: receipt.catalogRevisionId as ModSourceReceipt['catalogRevisionId'], checksum: receipt.checksum ?? '' }, catalog)) return undefined
  return catalog
}

// Public digests certify all private links and allocations without publishing their indexes
function viewerCapturedComposition(snapshot: PublicSnapshot, viewer: WorkspaceState) {
  const baseline = snapshot.setup.baseline
  if (!baseline || !availableSource(viewer, baseline)) return undefined
  return Object.values(viewer.planner.localData.gameSetups).map(candidate => candidate.modComposition).find(composition => {
    if (!composition || composition.baseline.catalogId !== baseline.catalogId || composition.baseline.catalogRevisionId !== baseline.catalogRevisionId || composition.layers.length !== snapshot.setup.layers.length) return false
    if (!composition.layers.every((layer, index) => {
      const receipt = snapshot.setup.layers[index]!
      return layer.catalogId === receipt.catalogId && layer.catalogRevisionId === receipt.catalogRevisionId && layer.enabled === (receipt.enabled !== false) && Boolean(layerSource(snapshot, viewer, layer))
    })) return false
    try { return snapshot.setup.catalogLock?.[baseline.catalogId] === `${PUBLIC_COMPOSITION_REVISION_PREFIX}${sourceCompositionDigest(composition, [composition.baseline, ...composition.layers].flatMap(pin => { const source = layerSource(snapshot, viewer, pin); return source ? [source] : [] }))}` } catch { return false }
  })
}

function requiresCapturedComposition(snapshot: PublicSnapshot): boolean {
  const baseline = snapshot.setup.baseline
  return Boolean(baseline && snapshot.setup.catalogLock?.[baseline.catalogId]?.startsWith(PUBLIC_COMPOSITION_REVISION_PREFIX))
}

// Only the viewer's selected repository supplies definitions and assets; public names are never resolution keys
// The returned projection is separate from the historical pins and cannot publish a changed interpretation
export function enrichPublicSnapshot(input: PublicSnapshot, viewer: WorkspaceState): PublicEnrichment {
  const snapshot = validatePublicSnapshot(input)
  let capturedCatalog: CatalogSnapshot | undefined
  let checkedComposition = false
  const exactCatalog = (ref: Extract<PublicRef, { kind: 'catalog' }>): CatalogSnapshot | undefined => {
    if (!ref.catalogRevisionId.startsWith(PUBLIC_COMPOSITION_REVISION_PREFIX)) return layerSource(snapshot, viewer, ref)
    const baseline = snapshot.setup.baseline
    if (!baseline || ref.catalogId !== baseline.catalogId) return undefined
    // A matching setup cannot lend definitions to a retained selection from another revision
    if (snapshot.setup.catalogLock?.[ref.catalogId] !== ref.catalogRevisionId) return undefined
    if (!checkedComposition) {
      checkedComposition = true
      const composition = viewerCapturedComposition(snapshot, viewer)
      const owner = composition && Object.values(viewer.planner.localData.gameSetups).find(setup => setup.modComposition === composition)
      const composed = owner && composition && composeModCatalog(owner, [composition.baseline, ...composition.layers].flatMap(pin => { const source = layerSource(snapshot, viewer, pin); return source ? [source] : [] }))
      const native = availableSource(viewer, baseline)
      // Composition storage contains only replacements; unchanged selections still belong to its exact baseline
      capturedCatalog = composed && native ? expandModCatalogs([native, composed])[1] : undefined
    }
    return capturedCatalog
  }
  const entries = snapshot.receipts.map((receipt): PublicEnrichedEntry => {
    if (receipt.ref.kind === 'personal') {
      const fingerprint = receipt.ref.fingerprint.value
      const matches = Object.values(viewer.planner.localData.personalDefinitions).filter(definition => {
        if (definition.kind !== receipt.kind) return false
        try { return publicPersonalDefinitionFingerprint(viewer.planner.localData, definition.id, viewer.planner.catalogs) === fingerprint } catch { return false }
      })
      const definition = matches[0]
      return definition ? { receipt, definition, viewerRef: { kind: 'personal', definitionId: definition.id } } : { receipt }
    }
    const origin = receipt.origin
    if (!origin) {
      // An absent source receipt is not permission to guess from a name, model family, or numeric ID
      const catalog = exactCatalog(receipt.ref)
      const definition = catalog && catalogEntity(catalog, receipt.ref.entityId)
      if (!catalog || !definition || receipt.kind !== null && definition.kind !== receipt.kind) return { receipt }
      return { receipt, definition, viewerRef: { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: definition.id } }
    }
    const mechanical = receipt.origins?.mechanical
    const pin = { catalogId: origin.projectId, catalogRevisionId: origin.sourceRevisionId }
    const source = layerSource(snapshot, viewer, pin)
    const definition = source && (mechanical ? catalogEntity(source, mechanical.entityId) : origin.kind === 'catalog' && origin.modelKey ? modModelEntity(source, origin.modelKey) : catalogEntity(source, receipt.ref.entityId))
    if (!source || !definition || receipt.kind !== null && definition.kind !== receipt.kind) return { receipt }
    const text = receipt.origins?.text
    const composed = exactCatalog(receipt.ref)
    const effective = composed && catalogEntity(composed, receipt.ref.entityId)
    const actualOrigins = effective && definitionOrigins(composed!, effective)
    const claimedMechanical = mechanical ?? { kind: 'catalog', ...pin, entityId: definition.id }
    if (actualOrigins && (checkpointContentDigest(actualOrigins.mechanical) !== checkpointContentDigest(claimedMechanical) || receipt.origins && checkpointContentDigest(actualOrigins.text) !== checkpointContentDigest(receipt.origins.text))) return { receipt }
    // Differing contributors need the captured composition to certify remapping and localization together
    if (text && publicRefKey(text) !== publicRefKey(mechanical!) && !effective) return { receipt }
    const selected = effective ?? definition
    const viewerRef = { kind: 'catalog' as const, catalogId: effective ? composed!.id : source.id, catalogRevisionId: effective ? composed!.revisionId : source.revisionId, entityId: selected.id }
    const artwork = findPrivateArtwork(viewer, { catalogId: source.id, catalogRevisionId: source.revisionId }, definition)
    return { receipt, definition: selected, viewerRef, ...(artwork ? { artwork, artworkSource: { catalogId: source.id, catalogRevisionId: source.revisionId, entity: definition } } : {}) }
  })
  const missingReceiptIds = entries.filter(entry => !entry.definition).map(entry => publicRefKey(entry.receipt.ref))
  const missingSources = snapshot.setup.layers.filter(layer => !layerSource(snapshot, viewer, layer))
  const baseline = snapshot.setup.baseline
  const ownsBaseline = baseline && availableSource(viewer, baseline)
  if (baseline && !ownsBaseline) missingSources.unshift({ ...baseline, title: baseline.catalogId })
  return { entries, missingReceiptIds, missingSources, resolved: missingReceiptIds.length === 0 && missingSources.length === 0, unresolvedCalculations: !ownsBaseline || !snapshot.setup.catalogLock || missingReceiptIds.length > 0 || missingSources.length > 0 || (requiresCapturedComposition(snapshot) && !viewerCapturedComposition(snapshot, viewer)) }
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
  const setup: GameSetupRevision = { id: createId('gameSetupRevision'), gameSetupId: createId('gameSetup'), revision: 0, label: snapshot.title, platform: { state: 'unknown' }, gameVersion: { state: 'unknown' }, mode: publicKnowledge(snapshot.setup.mode), mods: { state: 'known', value: snapshot.setup.layers.filter(layer => layer.enabled !== false).map(layer => layer.title) }, ppCostsNonNegative: publicKnowledge(snapshot.setup.ppCostsNonNegative), ...(snapshot.setup.ppLimit ? { ppLimit: publicKnowledge(snapshot.setup.ppLimit) } : {}), ...(snapshot.setup.difficulty ? { difficulty: { version: 1, selection: publicKnowledge(snapshot.setup.difficulty) } } : {}), slots: snapshot.setup.slots.map((slot, order) => ({ ...slot, id: slot.id as SlotId, kind: 'equipment', order, provenance: 'imported', sources: [] })), catalogLock: snapshot.setup.catalogLock as GameSetupRevision['catalogLock'], publicSourceContext: { version: PUBLIC_SETUP_CONTEXT_VERSION, setup: snapshot.setup }, createdAt: at }
  const refs = new Map<string, EntityRef>()
  const bindings: PublicCheckpointContext['personalBindings'] = []
  for (const receipt of snapshot.receipts) {
    const ref: EntityRef = receipt.ref.kind === 'catalog' ? receipt.ref as EntityRef : { kind: 'personal', definitionId: createId('personalDefinition') }
    refs.set(publicRefKey(receipt.ref), ref)
    if (receipt.ref.kind === 'personal' && ref.kind === 'personal') bindings.push({ fingerprint: receipt.ref.fingerprint.value, ref })
  }
  // Unknown types stay in the versioned context and display names, never in typed definition receipts
  const unavailable = snapshot.receipts.flatMap(receipt => receipt.kind === null ? [] : [{ ref: refs.get(publicRefKey(receipt.ref))!, kind: receipt.kind, name: receipt.name, ...(receipt.fingerprint ? { fingerprint: receipt.fingerprint } : {}) }])
  const version = PUBLIC_CHECKPOINT_CONTEXT_VERSION
  const context = PublicCheckpointContextSchema.parse({ version, setupDigest: checkpointContentDigest(setup.publicSourceContext), receipts: snapshot.receipts, personalBindings: bindings })
  const contents = snapshot.slots.map((slot, index) => {
    if (!slot) return null
    const notes = snapshot.notes?.slots[index]
    const raw = publicLoadoutContent(slot, ref => refs.get(publicRefKey(ref))!)
    const content = retainOutOfContextSelections(data, { ...raw, referenceNames: snapshot.receipts.flatMap(receipt => receipt.ref.kind === 'catalog' && buildModReferences(raw).some(ref => entityDefinitionKey(ref) === entityDefinitionKey(receipt.ref as EntityRef)) ? [{ ref: receipt.ref as CatalogRef, name: receipt.name, ...(receipt.origins ? { origins: receipt.origins as import('../domain/types').DefinitionOrigins } : {}), ...(receipt.origin?.kind === 'catalog' ? { projectId: receipt.origin.projectId as CatalogRef['catalogId'], ...(receipt.origin.modelKey ? { modelKey: receipt.origin.modelKey } : {}) } : {}) }] : []), contextAssumptions: notes?.contextAssumptions ?? [], ...(notes?.rotationNotes !== undefined ? { rotationNotes: notes.rotationNotes } : {}) }, setup, setup.catalogLock)
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
  const baseline = snapshot.setup.baseline
  // Never infer default links: explicit nulls and scoped allocations are part of the captured private composition
  const capturedComposition = viewerCapturedComposition(snapshot, viewer)
  const ownedCatalogs = [...(baseline ? [baseline] : []), ...snapshot.setup.layers].flatMap(pin => {
    const catalog = layerSource(snapshot, viewer, pin)
    return catalog ? [catalog] : []
  })
  const { publicSourceContext: _sourceContext, ...plainSetup } = copiedSetup
  const setup: GameSetupRevision = { ...plainSetup, catalogLock: { ...Object.fromEntries(ownedCatalogs.map(catalog => [catalog.id, catalog.revisionId])), ...(capturedComposition ? { [capturedComposition.baseline.catalogId]: modCatalogRevision(copiedSetup.id) } : {}) }, ...(capturedComposition ? { modComposition: capturedComposition } : {}) }
  // Recompose the full owned source graph so class innates, automatic statuses, and ability IDs share one identity scope
  // This projection is transient; copied checkpoints and public receipts retain their original inert context
  const composed = capturedComposition ? composeModCatalog(setup, ownedCatalogs) : undefined
  const catalogs = composed ? expandModCatalogs([...ownedCatalogs, composed]) : ownedCatalogs
  const domainRef = (ref: PublicRef): EntityRef => {
    const entry = enrichment.entries.find(entry => publicRefKey(entry.receipt.ref) === publicRefKey(ref))
    // Resolved effective selections belong to this transient composition, including those without origin receipts
    if (entry?.definition && composed && ref.kind === 'catalog' && ref.catalogId === composed.id && ref.catalogRevisionId === snapshot.setup.catalogLock?.[ref.catalogId]) return { kind: 'catalog', catalogId: composed.id, catalogRevisionId: composed.revisionId, entityId: entry.definition.id as CatalogRef['entityId'] }
    const resolved = entry?.viewerRef
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
    const retained = { ...content, ...(inactive.length || removed.length ? { retainedSelections: { refs: inactive, slotIds: removed } } : {}) }
    const mapped = capturedComposition ? buildContentForModSetup(retained, setup, catalogs) : retained
    return { id: createId('buildRevision'), buildId: createId('build'), revision: 0, gameSetupRevisionId: setup.id, catalogLock: setup.catalogLock, content: { ...mapped, referenceNames: snapshot.receipts.flatMap(receipt => { const ref = domainRef(receipt.ref); return ref.kind === 'catalog' && selected.has(entityDefinitionKey(ref)) ? [{ ref, name: receipt.name }] : [] }), contextAssumptions: notes?.contextAssumptions ?? [], ...(notes?.rotationNotes !== undefined ? { rotationNotes: notes.rotationNotes } : {}) }, createdAt: copiedSetup.createdAt, ...(notes?.checkpoint ? { note: notes.checkpoint } : {}) }
  })
  return { localData, catalogs, revisions }
}

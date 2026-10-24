import { publicSnapshotFromCheckpoint } from '../domain/public-source-context'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import type { WorkspaceState } from '../workspace/documents'
import type { BuildCalculationPlan, BuildRevisionContent, EntityRef, GameSetupRevision, Knowledge, LocalData, TeamRevisionId } from '../domain/types'
import { entityDefinitionKey, requirePlaythrough } from '../domain/core'
import { catalogEntity } from '../domain/entity-identities'
import { effectiveScenarioAssignments } from '../domain/scenarios'
import { modSourceReceipts } from '../domain/build-reference-names'
import { jsonRecord } from '../domain/crystal-edit'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import type { ShareTarget } from './share'
import { PUBLIC_SHARE_LIMITS, PUBLIC_SHARE_ROUTE_PREFIX, publicRefKey, validatePublicSnapshot, type PublicEntityReceipt, type PublicLoadout, type PublicRef, type PublicSetup, type PublicSnapshot } from './public-share-schema'
export { validatePublicSnapshot } from './public-share-schema'
export type { PublicSnapshot, PublicSetup, PublicLoadout, PublicEntityReceipt, PublicNotes } from './public-share-schema'

export type PublicShareTarget = ShareTarget | { readonly kind: 'team'; readonly teamId: import('../domain/types').TeamId; readonly teamRevisionId: TeamRevisionId }
function fingerprint(value: unknown): string { return checkpointContentDigest(value) }
function knowledge<T>(value: Knowledge<T>): { state: 'known'; value: T } | { state: 'unknown' | 'conflicting' | 'notApplicable' } { return value.state === 'known' ? { state: 'known', value: value.value } : { state: value.state } }

export function publicCatalogPin(localData: LocalData, catalogId: string, catalogRevisionId: string) {
    if (!catalogRevisionId.startsWith('mod-setup:')) return { catalogId, catalogRevisionId }
    const owner = Object.values(localData.gameSetups).find(candidate => `mod-setup:${candidate.id}` === catalogRevisionId)
    if (!owner?.modComposition) throw new Error('A selected entry needs an unavailable exact mod composition')
    return { catalogId, catalogRevisionId: `composition-v1:sha256:${fingerprint(owner.modComposition)}` }
  }

export function publicPersonalDefinitionFingerprint(localData: LocalData, definitionId: string): string {
  const publicPin = (catalogId: string, catalogRevisionId: string) => publicCatalogPin(localData, catalogId, catalogRevisionId)
  const personalFingerprints = new Map<string, string>()
  const personalIdentity = (definitionId: string, visiting = new Set<string>()): string => {
    const cached = personalFingerprints.get(definitionId)
    if (cached) return cached
    if (visiting.has(definitionId)) throw new Error('A selected personal definition has cyclic identity dependencies')
    const definition = localData.personalDefinitions[definitionId]
    if (!definition) {
      const receipt = localData.unavailableDefinitions?.find(entry => entry.ref.kind === 'personal' && entry.ref.definitionId === definitionId)
      if (receipt?.fingerprint?.kind === 'personal-definition-v1') return receipt.fingerprint.value
      throw new Error('A selected personal definition needs its exact fingerprint before sharing')
    }
    const next = new Set(visiting).add(definitionId)
    const identityRef = (ref: EntityRef): unknown => ref.kind === 'personal' ? { kind: 'personal', fingerprint: personalIdentity(ref.definitionId, next) } : { kind: 'catalog', ...publicPin(ref.catalogId, ref.catalogRevisionId), entityId: ref.entityId }
    // Normalize typed provenance only; opaque field values remain exact, even when a field is named sources
    const semanticKnowledge = <T,>(value: Knowledge<T> | undefined, map: (input: T) => unknown = input => input): unknown => {
      if (!value) return undefined
      if (value.state === 'known') return { state: value.state, value: map(value.value) }
      if (value.state === 'conflicting') return { state: value.state, claims: value.claims.map(claim => ({ value: map(claim.value) })) }
      return { state: value.state }
    }
    const digest = fingerprint({ kind: definition.kind, name: definition.name, aliases: definition.aliases, rawDescription: definition.rawDescription,
      fields: Object.fromEntries(Object.entries(definition.fields).map(([key, value]) => [key, semanticKnowledge(value)])),
      slotKinds: semanticKnowledge(definition.slotKinds), ppCost: semanticKnowledge(definition.ppCost),
      listedContributions: definition.listedContributions && Object.fromEntries(Object.entries(definition.listedContributions).map(([key, value]) => [key, semanticKnowledge(value)])),
      requirements: semanticKnowledge(definition.requirements, requirements => requirements.map(requirement => requirement.kind === 'selected' ? { kind: requirement.kind, ref: identityRef(requirement.ref) } : { kind: requirement.kind, permission: requirement.permission })),
      grants: semanticKnowledge(definition.grants), baseRef: definition.baseRef && identityRef(definition.baseRef),
    })
    personalFingerprints.set(definitionId, digest)
    return digest
  }
  return personalIdentity(definitionId)
}

export function createPublicSnapshot(state: { readonly planner: Pick<WorkspaceState['planner'], 'localData' | 'catalogs'> }, target: PublicShareTarget, options: { readonly includeNotes: boolean }): PublicSnapshot {
  const { localData, catalogs } = state.planner
  let setup: GameSetupRevision | undefined
  let lock: GameSetupRevision['catalogLock']
  let title: string
  let checkpointNote: string | undefined
  let contents: readonly ({ content: BuildRevisionContent; note?: string; name?: string } | null)[]
  if (target.kind === 'build') {
    const revision = localData.buildRevisions[target.revisionId]
    const build = revision && localData.builds[revision.buildId]
    if (!revision || !build) throw new Error('Choose an available saved Build checkpoint before sharing')
    if (revision.publicSourceContext) { const shared = publicSnapshotFromCheckpoint(localData.gameSetups[revision.gameSetupRevisionId]!, revision, build.title); if (!options.includeNotes) delete shared.notes; return shared }
    setup = localData.gameSetups[revision.gameSetupRevisionId]; lock = revision.catalogLock; title = build.title; contents = [revision]
  } else if ('teamId' in target) {
    const team = localData.teams[target.teamId]
    if (!team || team.kind !== 'shared') throw new Error('Choose a shared Game Setup before creating a new Team link; historical links remain readable')
    const checkpoint = localData.teamRevisions['teamRevisionId' in target ? target.teamRevisionId : team.latestRevisionId]
    if (!checkpoint || checkpoint.teamId !== team.id) throw new Error('The selected Team checkpoint is unavailable')
    if (checkpoint.publicSourceContext) { const shared = publicSnapshotFromCheckpoint(localData.gameSetups[checkpoint.gameSetupRevisionId]!, checkpoint, team.title); if (!options.includeNotes) delete shared.notes; return shared }
    setup = localData.gameSetups[checkpoint.gameSetupRevisionId]; lock = checkpoint.catalogLock; title = team.title; contents = checkpoint.slots; checkpointNote = checkpoint.note
  } else {
    const scenario = requirePlaythrough(localData).scenarios[target.scenarioId]
    if (!scenario || scenario.memberIds.length !== 4 || new Set(scenario.memberIds).size !== 4) throw new Error('Sharing a Team needs exactly four ordered member slots')
    setup = localData.gameSetups[scenario.gameSetupRevisionId]; lock = scenario.catalogLock; title = scenario.label
    const assignments = effectiveScenarioAssignments(scenario)
    contents = scenario.memberIds.map(id => {
      const ref = assignments[id]
      if (!ref) return null
      const checkpoint = ref.kind === 'team-slot' ? localData.teamRevisions[ref.teamRevisionId] : localData.buildRevisions[ref.revisionId]
      if (!checkpoint || checkpoint.gameSetupRevisionId !== scenario.gameSetupRevisionId || fingerprint(checkpoint.catalogLock) !== fingerprint(lock)) throw new Error('Choose one shared Team setup before sharing mixed checkpoint contexts')
      const value = ref.kind === 'team-slot' && 'slots' in checkpoint ? checkpoint.slots[ref.slot] : 'content' in checkpoint ? checkpoint : undefined
      if (!value) throw new Error('A selected Team member checkpoint is unavailable')
      return value
    })
  }
  if (!setup) throw new Error('The saved Game Setup is unavailable; restore it before sharing')
  // A checkpoint may deliberately pin an older composition than its setup record
  const compositionOwners = Object.values(lock).filter(pin => pin.startsWith('mod-setup:')).map(pin => {
    const owner = Object.values(localData.gameSetups).find(candidate => `mod-setup:${candidate.id}` === pin)
    if (!owner?.modComposition) throw new Error('The exact saved mod composition is unavailable; restore its source before sharing')
    return owner
  })
  if (compositionOwners.length > 1) throw new Error('This saved context has multiple mod compositions and cannot be represented by one public setup')
  const compositionOwner = compositionOwners[0]
  const composition = compositionOwner?.modComposition
  const publicPin = (catalogId: string, catalogRevisionId: string) => publicCatalogPin(localData, catalogId, catalogRevisionId)
  const pins = Object.entries(lock).map(([catalogId, catalogRevisionId]) => ({ catalogId, catalogRevisionId }))
  const baseline = composition?.baseline ?? (pins.length === 1 ? pins[0]! : null)
  const layers = composition?.layers.filter(layer => layer.enabled) ?? (pins.length > 1 ? pins : [])
  const savedSources = compositionOwner ? modSourceReceipts(compositionOwner, catalogs) : setup.modSourceReceipts
  const publicSetup: PublicSetup = {
    catalogLock: Object.fromEntries(Object.entries(lock).map(([id, revision]) => [id, publicPin(id, revision).catalogRevisionId])),
    baseline: baseline ? publicPin(baseline.catalogId, baseline.catalogRevisionId) : null,
    layers: layers.map(pin => {
      const catalog = catalogs.find(candidate => candidate.id === pin.catalogId && candidate.revisionId === pin.catalogRevisionId)
      const receipt = savedSources?.find(candidate => candidate.catalogId === pin.catalogId && candidate.catalogRevisionId === pin.catalogRevisionId)
      if (!catalog && !receipt) throw new Error('A required source receipt is unavailable; restore the exact source before sharing')
      const legacy = catalog?.legacy
      const projectTitle = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? (legacy as Record<string, unknown>).projectTitle : undefined
      return { ...publicPin(pin.catalogId, pin.catalogRevisionId), title: receipt?.title ?? (typeof projectTitle === 'string' ? projectTitle : pin.catalogId), ...(receipt?.checksum || catalog?.checksum?.startsWith('sha256:') ? { checksum: receipt?.checksum ?? catalog!.checksum } : {}), ...(receipt?.contentFingerprint ? { contentFingerprint: receipt.contentFingerprint } : {}) }
    }),
    mode: knowledge(setup.mode), ...(setup.difficulty ? { difficulty: knowledge(setup.difficulty.selection) } : {}), ...(setup.ppLimit ? { ppLimit: knowledge(setup.ppLimit) } : {}), ppCostsNonNegative: knowledge(setup.ppCostsNonNegative),
    slots: setup.slots.map(slot => ({ id: slot.id, label: slot.label, ...(slot.equipmentRole !== undefined ? { equipmentRole: slot.equipmentRole } : {}) })),
  }
  type SourceOrigin = Pick<PublicEntityReceipt['origin'], 'projectId' | 'sourceRevisionId' | 'modelKey'>
  const sourceOrigins = new Map<string, SourceOrigin[]>()
  const provenanceKey = (value: { readonly sourceId: string; readonly locator?: string }) => JSON.stringify([value.sourceId, value.locator])
  for (const source of catalogs) {
    if (source.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA || !jsonRecord(source.legacy) || !jsonRecord(source.legacy.crystalEditIdentities)) continue
    const identities = new Map(Object.entries(source.legacy.crystalEditIdentities).map(([modelKey, id]) => [id, modelKey]))
    for (const entity of Object.values(source.entities)) {
      const modelKey = identities.get(entity.id)
      if (modelKey) for (const provenance of entity.sources) {
        const key = provenanceKey(provenance)
        sourceOrigins.set(key, [...sourceOrigins.get(key) ?? [], { projectId: source.id, sourceRevisionId: source.revisionId, modelKey }])
      }
    }
  }
  const receipts = new Map<string, PublicEntityReceipt>()
  const addRef = (input: EntityRef, content: BuildRevisionContent): PublicRef => {
    // A selected catalog reference can be overridden by personal content; publish only that selected identity
    const override = input.kind === 'catalog' ? setup!.definitionOverrides?.map(ref => localData.personalDefinitions[ref.definitionId]).find(definition => definition?.baseRef && entityDefinitionKey(definition.baseRef) === entityDefinitionKey(input)) : undefined
    const ref: EntityRef = override ? { kind: 'personal', definitionId: override.id } : input
    const unavailable = localData.unavailableDefinitions?.find(receipt => entityDefinitionKey(receipt.ref) === entityDefinitionKey(ref))
    if (ref.kind === 'personal') {
      const definition = localData.personalDefinitions[ref.definitionId]
      if (!definition && (!unavailable || unavailable.fingerprint?.kind !== 'personal-definition-v1')) throw new Error('A selected personal definition needs its exact display fingerprint before sharing')
      // Hash the exact private content, never publish the private object ID or its mechanical body
      const identity = definition ? { kind: 'personal-definition-v1' as const, value: publicPersonalDefinitionFingerprint(localData, definition.id) } : unavailable!.fingerprint! as { kind: 'personal-definition-v1'; value: string }
      const result: PublicRef = { kind: 'personal', fingerprint: identity }
      receipts.set(publicRefKey(result), { ref: result, kind: definition?.kind ?? unavailable!.kind, name: definition?.name ?? unavailable!.name, fingerprint: identity, origin: { kind: 'personal', projectId: 'personal-definition-v1', sourceRevisionId: identity.value, catalogId: 'personal-definition-v1', catalogRevisionId: identity.value } })
      return result
    }
    const catalog = catalogs.find(candidate => candidate.id === ref.catalogId && candidate.revisionId === ref.catalogRevisionId)
    const entity = catalog && catalogEntity(catalog, ref.entityId)
    const savedNames = content.referenceNames?.filter(entry => entityDefinitionKey(entry.ref) === entityDefinitionKey(ref)) ?? []
    const savedName = savedNames[0]
    const name = entity?.name ?? unavailable?.name ?? savedName?.name
    if (!name || (!entity && !unavailable)) throw new Error('A selected entry needs its exact display and kind receipt; restore the matching source before sharing')
    const result: PublicRef = { kind: 'catalog', ...publicPin(ref.catalogId, ref.catalogRevisionId), entityId: ref.entityId }
    const owner = ref.catalogRevisionId.startsWith('mod-setup:') ? Object.values(localData.gameSetups).find(candidate => `mod-setup:${candidate.id}` === ref.catalogRevisionId) : undefined
    let origin: SourceOrigin = { projectId: ref.catalogId, sourceRevisionId: ref.catalogRevisionId, ...(savedName?.modelKey ? { modelKey: savedName.modelKey } : {}) }
    if (!owner) {
      const exact = entity?.sources.flatMap(provenance => sourceOrigins.get(provenanceKey(provenance)) ?? []).filter(candidate => candidate.projectId === ref.catalogId && candidate.sourceRevisionId === ref.catalogRevisionId) ?? []
      const candidates = new Map(exact.map(candidate => [JSON.stringify(candidate), candidate]))
      if (candidates.size > 1) throw new Error('A selected entry has an ambiguous source origin; restore the exact source before sharing')
      origin = candidates.values().next().value ?? origin
    }
    if (owner?.modComposition) {
      const pins = owner.modComposition.layers.filter(layer => layer.enabled)
      const fresh = entity?.sources.flatMap(provenance => sourceOrigins.get(provenanceKey(provenance)) ?? []).filter(candidate => pins.some(pin => pin.catalogId === candidate.projectId && pin.catalogRevisionId === candidate.sourceRevisionId)) ?? []
      const saved = savedNames.flatMap(receipt => {
        if (!receipt.projectId || !receipt.modelKey) return []
        const matching = pins.filter(pin => pin.catalogId === receipt.projectId)
        if (matching.length !== 1) throw new Error('A selected entry has an unavailable or ambiguous source origin; restore the exact source before sharing')
        return [{ projectId: receipt.projectId, sourceRevisionId: matching[0]!.catalogRevisionId, modelKey: receipt.modelKey }]
      })
      // Display refresh cannot erase saved exact origin, and conflicting evidence must never pick a source by order
      const candidates = new Map([...fresh, ...saved].map(candidate => [JSON.stringify(candidate), candidate]))
      if (candidates.size > 1) throw new Error('A selected entry has an ambiguous source origin; restore the exact source before sharing')
      const selected = candidates.values().next().value
      if (selected) origin = selected
      else {
        // The composition catalog ID is also the baseline ID; it proves native origin only for an unchanged exact baseline entity
        const baseline = owner.modComposition.baseline
        const baselineCatalog = catalogs.find(candidate => candidate.id === baseline.catalogId && candidate.revisionId === baseline.catalogRevisionId)
        const baselineEntity = baselineCatalog && catalogEntity(baselineCatalog, ref.entityId)
        if (!entity || !baselineEntity || fingerprint(entity) !== fingerprint(baselineEntity)) throw new Error('A selected entry needs its exact source origin; restore the matching source before sharing')
        origin = { projectId: baseline.catalogId, sourceRevisionId: baseline.catalogRevisionId }
      }
    }
    const receipt: PublicEntityReceipt = { ref: result, kind: entity?.kind ?? unavailable!.kind, name, ...(unavailable?.fingerprint ? { fingerprint: unavailable.fingerprint } : {}), origin: { kind: 'catalog', ...origin, ...publicPin(ref.catalogId, ref.catalogRevisionId) } }
    const previous = receipts.get(publicRefKey(result))
    if (previous && fingerprint(previous.origin) !== fingerprint(receipt.origin)) throw new Error('A selected entry has an ambiguous source origin across Team slots; restore the exact source before sharing')
    receipts.set(publicRefKey(result), receipt)
    return result
  }
  const slots = contents.map(saved => {
    if (!saved) return null
    const content = saved.content
    const mapRef = (ref: EntityRef) => addRef(ref, content)
    const nullableRef = (ref: EntityRef | null) => ref ? mapRef(ref) : null
    const equipment = Object.entries(content.equipment).map(([slotId, selection]) => ({ slotId, ref: selection ? mapRef(selection.ref) : null }))
    const groups = new Map<string, string[]>()
    for (const [slotId, selection] of Object.entries(content.equipment)) if (selection?.allocationId) groups.set(selection.allocationId, [...groups.get(selection.allocationId) ?? [], slotId])
    return { ...(target.kind === 'team' && saved.name !== undefined ? { name: saved.name } : {}), primaryClass: nullableRef(content.primaryClass), secondaryClass: nullableRef(content.secondaryClass), equipment, equipmentGroups: [...groups.values()].filter(group => group.length > 1), passives: content.passives.map(selection => mapRef(selection.ref)), ...(content.calculation ? { calculation: projectCalculation(content.calculation, mapRef) } : {}) }
  })
  return validatePublicSnapshot({ version: 5, kind: target.kind, title, setup: publicSetup, slots, receipts: [...receipts.values()], ...(options.includeNotes ? { notes: { ...(checkpointNote !== undefined ? { checkpoint: checkpointNote } : {}), slots: contents.map(saved => saved ? { contextAssumptions: [...saved.content.contextAssumptions], ...(saved.content.rotationNotes !== undefined ? { rotationNotes: saved.content.rotationNotes } : {}), ...(saved.note !== undefined ? { checkpoint: saved.note } : {}) } : null) } } : {}) })
}

function projectCalculation(plan: BuildCalculationPlan, ref: (value: EntityRef) => PublicRef): PublicLoadout['calculation'] {
  const battle = plan.battle
  const resources = (value: NonNullable<typeof battle>['user']) => ({ hp: value.hp, mp: value.mp, ap: value.ap })
  return {
    ...(plan.model !== undefined ? { model: plan.model } : {}), ...(plan.growthMode !== undefined ? { growthMode: plan.growthMode } : {}), ...(plan.pcMode !== undefined ? { pcMode: plan.pcMode } : {}), ...(plan.gender !== undefined ? { gender: plan.gender } : {}), ...(plan.genderSelection ? { genderSelection: { version: plan.genderSelection.version, id: plan.genderSelection.id } } : {}),
    level: plan.level, growth: plan.growth.map(row => ({ classRef: row.classRef ? ref(row.classRef) : null, levels: row.levels })), bonuses: [...plan.bonuses], statuses: plan.statuses.map(ref), ...(plan.ability !== undefined ? { ability: plan.ability ? ref(plan.ability) : null } : {}), ...(plan.targetEvasion !== undefined ? { targetEvasion: plan.targetEvasion } : {}),
    ...(battle ? { battle: { version: battle.version, turnCount: battle.turnCount, targetTurnCount: battle.targetTurnCount, automaticStatuses: battle.automaticStatuses, statuses: battle.statuses.map(row => ({ ref: ref(row.ref), count: row.count })), user: resources(battle.user), target: battle.target === 'self' || battle.target === null ? battle.target : ref(battle.target), targetResources: resources(battle.targetResources), targetStatuses: battle.targetStatuses.map(row => ({ ref: ref(row.ref), count: row.count })), repeatCount: battle.repeatCount, bottomThreat: battle.bottomThreat, topThreat: battle.topThreat, targetIsThreatTarget: battle.targetIsThreatTarget, targetCharging: battle.targetCharging, previouslyAppliedStatuses: battle.previouslyAppliedStatuses.map(ref), userPreviouslyAppliedStatuses: battle.userPreviouslyAppliedStatuses.map(ref) } } : {}),
  }
}

export function encodePublicSnapshot(snapshot: PublicSnapshot): string {
  const bytes = new TextEncoder().encode(JSON.stringify(validatePublicSnapshot(snapshot)))
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  if (encoded.length + PUBLIC_SHARE_ROUTE_PREFIX.length > PUBLIC_SHARE_LIMITS.url) throw new Error('This snapshot is too large for a portable link; shorten optional notes or share a smaller selection')
  return encoded
}
export function decodePublicSnapshot(encoded: string): PublicSnapshot {
  if (!encoded || encoded.length + PUBLIC_SHARE_ROUTE_PREFIX.length > PUBLIC_SHARE_LIMITS.url || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('This public link is malformed or exceeds the URL limit')
  try {
    // v5 uses raw UTF-8, so input bounds also bound allocation and work before parsing; no decompression occurs
    const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0))
    if (bytes.length > PUBLIC_SHARE_LIMITS.bytes) throw new Error('Public snapshot exceeds 256 KiB')
    return validatePublicSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (error) { throw new Error(`This public link could not be opened: ${error instanceof Error ? error.message : 'invalid JSON'}`) }
}
export function createPublicShareUrl(snapshot: PublicSnapshot, baseUrl: string): string {
  const url = new URL(baseUrl); url.search = ''; url.hash = `${PUBLIC_SHARE_ROUTE_PREFIX}${encodePublicSnapshot(snapshot)}`
  if (url.href.length > PUBLIC_SHARE_LIMITS.url) throw new Error('This snapshot is too large for a portable link at this address')
  return url.href
}

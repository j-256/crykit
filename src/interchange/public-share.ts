import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { definitionOrigins } from '../domain/definition-origins'
import { sourceCompositionDigest } from '../domain/source-composition'
import { fulfillSource } from '../domain/source-fulfillment'
import { publicSnapshotFromCheckpoint } from '../domain/public-source-context'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import type { WorkspaceState } from '../workspace/documents'
import type { BuildCalculationPlan, BuildRevisionContent, EntityRef, GameSetupRevision, Knowledge, LocalData, CatalogSnapshot, DefinitionOrigins, BuildRevisionId, ScenarioId, TeamId, TeamRevisionId } from '../domain/types'
import { entityDefinitionKey, requirePlaythrough } from '../domain/core'
import { catalogEntity } from '../domain/entity-identities'
import { effectiveScenarioAssignments } from '../domain/scenarios'
import { modSourceReceipts } from '../domain/build-reference-names'
import { jsonRecord } from '../domain/crystal-edit'
import { PUBLIC_SHARE_LIMITS, PUBLIC_SHARE_ROUTE_PREFIX, PUBLIC_SHARE_VERSION, PUBLIC_COMPOSITION_REVISION_PREFIX, publicRefKey, validatePublicSnapshot, type PublicEntityReceipt, type PublicLoadout, type PublicRef, type PublicSetup, type PublicSnapshot } from './public-share-schema'
export { validatePublicSnapshot } from './public-share-schema'
export type { PublicSnapshot, PublicSetup, PublicLoadout, PublicEntityReceipt, PublicNotes } from './public-share-schema'

export type PublicShareTarget = { readonly kind: 'build'; readonly revisionId: BuildRevisionId } | { readonly kind: 'team'; readonly scenarioId: ScenarioId } | { readonly kind: 'team'; readonly teamId: TeamId } | { readonly kind: 'team'; readonly teamId: TeamId; readonly teamRevisionId: TeamRevisionId }
function fingerprint(value: unknown): string { return checkpointContentDigest(value) }
function knowledge<T>(value: Knowledge<T>): { state: 'known'; value: T } | { state: 'unknown' | 'conflicting' | 'notApplicable' } { return value.state === 'known' ? { state: 'known', value: value.value } : { state: value.state } }

export function publicCatalogPin(localData: LocalData, catalogId: string, catalogRevisionId: string, catalogs: readonly CatalogSnapshot[] = []) {
    if (!catalogRevisionId.startsWith('mod-setup:')) return { catalogId, catalogRevisionId }
    const owner = Object.values(localData.gameSetups).find(candidate => `mod-setup:${candidate.id}` === catalogRevisionId)
    if (!owner?.modComposition) throw new Error('A selected entry needs an unavailable exact mod composition')
    return { catalogId, catalogRevisionId: `${PUBLIC_COMPOSITION_REVISION_PREFIX}${sourceCompositionDigest(owner.modComposition, catalogs)}` }
  }

export function publicPersonalDefinitionFingerprint(localData: LocalData, definitionId: string, catalogs: readonly CatalogSnapshot[] = []): string {
  const publicPin = (catalogId: string, catalogRevisionId: string) => publicCatalogPin(localData, catalogId, catalogRevisionId, catalogs)
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
    if (!team || team.kind !== 'shared') throw new Error('Choose a shared Game Setup before creating a new Team link')
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
  const publicPin = (catalogId: string, catalogRevisionId: string) => publicCatalogPin(localData, catalogId, catalogRevisionId, catalogs)
  const pins = Object.entries(lock).map(([catalogId, catalogRevisionId]) => ({ catalogId, catalogRevisionId }))
  const baseline = composition?.baseline ?? (pins.length === 1 ? pins[0]! : null)
  const layers = composition?.layers ?? (pins.length > 1 ? pins : [])
  const savedSources = compositionOwner ? modSourceReceipts(compositionOwner, catalogs) : setup.modSourceReceipts
  const publicSetup: PublicSetup = {
    catalogLock: Object.fromEntries(Object.entries(lock).map(([id, revision]) => [id, publicPin(id, revision).catalogRevisionId])),
    baseline: baseline ? publicPin(baseline.catalogId, baseline.catalogRevisionId) : null,
    layers: layers.map(pin => {
      const catalog = fulfillSource(pin as import('../domain/types').ModCatalogPin, catalogs)?.catalog
      const receipt = savedSources?.find(candidate => candidate.catalogId === pin.catalogId && candidate.catalogRevisionId === pin.catalogRevisionId)
      if (!catalog && !receipt) throw new Error('A required source receipt is unavailable; restore the exact source before sharing')
      const legacy = catalog?.legacy
      const projectTitle = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? (legacy as Record<string, unknown>).projectTitle : undefined
      return { ...publicPin(pin.catalogId, pin.catalogRevisionId), ...('enabled' in pin ? { enabled: pin.enabled as boolean } : {}), title: receipt?.title ?? (typeof projectTitle === 'string' ? projectTitle : pin.catalogId), ...(receipt?.checksum || catalog?.checksum ? { checksum: receipt?.checksum ?? catalog!.checksum } : {}), ...(receipt?.contentFingerprint ? { contentFingerprint: receipt.contentFingerprint } : {}) }
    }),
    mode: knowledge(setup.mode), ...(setup.difficulty ? { difficulty: knowledge(setup.difficulty.selection) } : {}), ...(setup.ppLimit ? { ppLimit: knowledge(setup.ppLimit) } : {}), ppCostsNonNegative: knowledge(setup.ppCostsNonNegative),
    slots: setup.slots.map(slot => ({ id: slot.id, label: slot.label, ...(slot.equipmentRole !== undefined ? { equipmentRole: slot.equipmentRole } : {}) })),
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
      const identity = definition ? { kind: 'personal-definition-v1' as const, value: publicPersonalDefinitionFingerprint(localData, definition.id, catalogs) } : unavailable!.fingerprint! as { kind: 'personal-definition-v1'; value: string }
      const result: PublicRef = { kind: 'personal', fingerprint: identity }
      receipts.set(publicRefKey(result), { ref: result, kind: definition?.kind ?? unavailable!.kind, name: definition?.name ?? unavailable!.name, fingerprint: identity, origin: { kind: 'personal', projectId: 'personal-definition-v1', sourceRevisionId: identity.value, catalogId: 'personal-definition-v1', catalogRevisionId: identity.value } })
      return result
    }
    const catalog = fulfillSource(ref, catalogs)?.catalog
    const entity = catalog && catalogEntity(catalog, ref.entityId)
    const savedNames = content.referenceNames?.filter(entry => entityDefinitionKey(entry.ref) === entityDefinitionKey(ref)) ?? []
    const savedName = savedNames[0]
    const name = entity?.name ?? unavailable?.name ?? savedName?.name
    if (!name) throw new Error('A selected entry needs its exact saved display receipt before sharing')
    if (new Set([entity?.name, unavailable?.name, ...savedNames.map(receipt => receipt.name)].filter(value => value !== undefined)).size > 1) throw new Error('A selected entry has ambiguous saved display names; restore the exact source before sharing')
    if (entity && unavailable && entity.kind !== unavailable.kind) throw new Error('A selected entry has an ambiguous kind; restore the exact source before sharing')
    const result: PublicRef = { kind: 'catalog', ...publicPin(ref.catalogId, ref.catalogRevisionId), entityId: ref.entityId }
    if (savedNames.some(value => value.origins && value.projectId && value.projectId !== value.origins.mechanical.catalogId)) throw new Error('A selected entry has an ambiguous source origin; restore the exact source before sharing')
    const candidates = [catalog && entity ? definitionOrigins(catalog, entity) : undefined, ...savedNames.map(value => value.origins)].filter((value): value is DefinitionOrigins => Boolean(value))
    const distinct = new Map(candidates.map(value => [fingerprint(value), value]))
    if (distinct.size > 1) throw new Error('A selected entry has an ambiguous source origin; restore the exact source before sharing')
    const origins = distinct.values().next().value
    const mechanical = origins?.mechanical
    const source = mechanical && fulfillSource(mechanical, catalogs)?.catalog
    const identities = source && jsonRecord(source.legacy) && jsonRecord(source.legacy.crystalEditIdentities) ? source.legacy.crystalEditIdentities : {}
    const modelKey = Object.entries(identities).find(([, id]) => id === mechanical?.entityId)?.[0]
    // Saved explicit origins survive missing bodies; names and citation similarity never create contributor claims
    const receipt: PublicEntityReceipt = { ref: result, kind: entity?.kind ?? unavailable?.kind ?? null, name, ...(unavailable?.fingerprint ? { fingerprint: unavailable.fingerprint } : {}), ...(origins ? { origins } : {}), origin: mechanical ? { kind: 'catalog', projectId: mechanical.catalogId, sourceRevisionId: mechanical.catalogRevisionId, ...(modelKey ? { modelKey } : {}), ...publicPin(ref.catalogId, ref.catalogRevisionId) } : null }
    const previous = receipts.get(publicRefKey(result))
    if (previous) {
      if (previous.name !== receipt.name) throw new Error('A selected entry has ambiguous saved display names across Team slots; restore the exact source before sharing')
      if (previous.kind !== null && receipt.kind !== null && previous.kind !== receipt.kind) throw new Error('A selected entry has an ambiguous kind across Team slots; restore the exact source before sharing')
      if (previous.origins && receipt.origins && fingerprint(previous.origins) !== fingerprint(receipt.origins)) throw new Error('A selected entry has an ambiguous source origin across Team slots; restore the exact source before sharing')
    }
    // Unknown metadata supplies no conflicting claim; preserve richer exact evidence from another selected slot
    receipts.set(publicRefKey(result), { ...receipt, kind: receipt.kind ?? previous?.kind ?? null, origin: receipt.origin ?? previous?.origin ?? null, ...(receipt.origins ?? previous?.origins ? { origins: receipt.origins ?? previous?.origins } : {}) })
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
  return validatePublicSnapshot({ version: PUBLIC_SHARE_VERSION, dataGeneration: LAUNCH_DATA_GENERATION, kind: target.kind, title, setup: publicSetup, slots, receipts: [...receipts.values()], ...(options.includeNotes ? { notes: { ...(checkpointNote !== undefined ? { checkpoint: checkpointNote } : {}), slots: contents.map(saved => saved ? { contextAssumptions: [...saved.content.contextAssumptions], ...(saved.content.rotationNotes !== undefined ? { rotationNotes: saved.content.rotationNotes } : {}), ...(saved.note !== undefined ? { checkpoint: saved.note } : {}) } : null) } } : {}) })
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
    // The launch format uses raw UTF-8, so input bounds also bound allocation and work before parsing; no decompression occurs
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

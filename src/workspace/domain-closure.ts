import { immutableHistory } from './history-admission'
import { assertPublicPersonalBindings, assertPublicSetupContext, publicSnapshotFromCheckpoint, publicUnavailableCatalogKeys } from '../domain/public-source-context'
import { z } from 'zod'
import type { EntityRef, Knowledge, BuildCalculationPlan, BuildRevisionContent, LocalData, Playthrough } from '../domain/types'
import { buildModReferences } from '../domain/build-references'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { battleCalculationReferences } from '../domain/battle-plan'
import { NativeLocalDataSchema, NativeLocalData240Schema, NativeCatalogSnapshotSchema, NativeEvidenceSchema, NativeHistorySchema, NativeSourceManifestSchema } from '../interchange/native-schema'
import { privateRecordKey, type WorkspaceDocumentKind, type WorkspaceDocument } from './documents'
import { immutableCatalogSnapshot, unavailableSetupCatalogKeys, validateNativeLocalDataGraph, validatePresentCatalogReferences } from '../interchange/native'
import { modCatalogRevision } from '../domain/mod-layers'
import { catalogSnapshotKey } from '../interchange/identity'
import { assertModSourceReceipts } from '../domain/build-reference-names'
import { WorkspaceBlobRefSchema, SaveWorkspaceDocumentSchema, LibraryDefaultsSchema } from './file-schemas'

const local = NativeLocalDataSchema.shape
const play = local.playthroughs.valueType.shape
const rootSchemas = { 'library-defaults': LibraryDefaultsSchema, 'workspace-preferences': z.object({ modSetup: local.modSetup, unavailableDefinitions: local.unavailableDefinitions, optional: z.object({ skillTreeLayouts: z.boolean() }).strict() }).strict(), build: local.builds.valueType, 'build-checkpoint': local.buildRevisions.valueType, team: z.union([local.teams.valueType, NativeLocalData240Schema.shape.teams.valueType]), 'team-checkpoint': local.teamRevisions.valueType, 'personal-definition': local.personalDefinitions.valueType, setup: local.gameSetups.valueType, 'import-receipt': local.importReceipts.valueType, 'skill-layout': local.skillTreeLayouts.unwrap().valueType, character: play.characters.valueType, progress: play.progress.valueType, goal: play.goals.valueType, scenario: z.union([play.scenarios.valueType, NativeLocalData240Schema.shape.playthroughs.valueType.shape.scenarios.valueType]), 'skill-capture': play.skillTreeCaptures.unwrap().valueType, 'quintar-breeding': play.quintarBreeding.unwrap(), 'reference-preferences': local.referenceLibrary.unwrap(), change: local.changes.element, catalog: NativeCatalogSnapshotSchema, evidence: NativeEvidenceSchema, history: NativeHistorySchema, source: NativeSourceManifestSchema.omit({ path: true, size: true }).extend({ original: WorkspaceBlobRefSchema }).strict(), inventory: z.object({ inventory: play.inventory, inventoryEvents: play.inventoryEvents }).strict(), playthrough: z.object({ metadata: local.playthroughs.valueType.omit({ activeScenarioId: true, characters: true, progress: true, goals: true, scenarios: true, inventory: true, inventoryEvents: true, quintarBreeding: true, skillTreeCaptures: true }), optional: z.object({ skillTreeCaptures: z.boolean(), quintarBreeding: z.boolean() }).strict() }).strict(), tombstone: z.object({ version: z.literal(1), kind: z.literal('tombstone'), privateKey: z.string() }).strict() } as const
const immutableHistoryEdges = new WeakMap<object, readonly string[]>()
const immutableCatalogEdges = new WeakMap<object, readonly string[]>()
export function validateArchiveDomainValue(kind: WorkspaceDocumentKind, value: unknown): void {
  if (kind === 'history') { immutableHistory(value as import('../interchange/types').PersistedHistoryEntry); return }
  if (kind === 'catalog') { immutableCatalogSnapshot(value as import('../domain/types').CatalogSnapshot); return }
  const schema = rootSchemas[kind as keyof typeof rootSchemas]
  if (schema) { schema.parse(value); return }
  // Structural file/index schemas are owned by archiveTypedReferences; control kinds are not archive-allowlisted
  if (['editor', 'save', 'asset', 'blob', 'directory', 'directory-page', 'unit-index', 'directory-mapping-unit', 'conflict', 'retained-content', 'workspace-identity', 'blob-reference', 'workspace-control', 'baseline-page', 'recovery-page'].includes(kind)) return
  throw new Error('Unsupported archival payload kind')
}
function values<T>(knowledge: Knowledge<T> | undefined): readonly T[] { return knowledge?.state === 'known' ? [knowledge.value] : knowledge?.state === 'conflicting' ? knowledge.claims.map(claim => claim.value) : [] }

// Only schema-declared reference positions retain domain records; inert imported fields never become graph edges
export function domainClosureKeys(kind: WorkspaceDocumentKind, value: unknown, scenarioDependencies: 'complete-v1' | 'legacy-s02' = 'complete-v1'): readonly string[] {
  validateArchiveDomainValue(kind, value)
  // Catalog structure and edge inputs are deeply frozen by the same native admission helper
  // Only their own typed keys are reusable; contextual missing-source checks still run per closure
  if (kind === 'catalog') { const known = immutableCatalogEdges.get(value as object); if (known) return known }
  // Only intrinsic typed keys are shared; resolvedDomainClosureKeys still checks the actual document map
  if (kind === 'history') { const known = immutableHistoryEdges.get(value as object); if (known) return known }
  const keys = new Set<string>()
  const add = (kind: WorkspaceDocumentKind, id: string | undefined) => { if (id) keys.add(privateRecordKey(kind, id)) }
  const catalog = (id: string, revision: string) => keys.add(privateRecordKey('catalog', id, revision))
  const entity = (ref: EntityRef | null | undefined) => { if (ref?.kind === 'catalog') catalog(ref.catalogId, ref.catalogRevisionId); else if (ref?.kind === 'personal') add('personal-definition', ref.definitionId) }
  const lock = (pins: Readonly<Record<string, string>>) => { for (const [id, revision] of Object.entries(pins)) catalog(id, revision) }
  const calculation = (plan: BuildCalculationPlan | undefined) => { if (plan) { for (const row of plan.growth) entity(row.classRef); for (const ref of plan.statuses) entity(ref); entity(plan.ability); for (const { ref } of battleCalculationReferences(plan.battle)) entity(ref) } }
  const source = (ref: import('../domain/types').SourceRef) => { if (ref.sourceId.startsWith('source:sha256:')) add('source', ref.sourceId) }
  const knowledge = (value: Knowledge<unknown> | undefined) => { if (!value) return; if (value.state === 'conflicting') for (const claim of value.claims) claim.sources.forEach(source); else if ('sources' in value) value.sources?.forEach(source) }
  const definition = (value: import('../domain/types').CatalogEntity | import('../domain/types').PersonalDefinition) => { value.sources.forEach(source); Object.values(value.fields).forEach(knowledge); Object.values(value.listedContributions ?? {}).forEach(knowledge); [value.slotKinds, value.ppCost, value.requirements, value.grants].forEach(knowledge) }
  if (kind === 'catalog') { const record = value as import('../domain/types').CatalogSnapshot; Object.values(record.entities).forEach(definition); for (const claim of record.claims) { claim.sources.forEach(source); knowledge(claim.value) }; knowledge(record.applicability); knowledge(record.rights); if (record.schemaVersion === 'crystal-edit-json-1' && /^sha256:[a-f0-9]{64}$/.test(record.checksum)) add('source', `source:${record.checksum}`) }
  if (kind === 'personal-definition') definition(value as import('../domain/types').PersonalDefinition)
  if (kind === 'evidence') (value as import('../interchange/types').EvidenceRecord).sources.forEach(source)
  if (kind === 'library-defaults') for (const layer of LibraryDefaultsSchema.parse(value).layers) catalog(layer.catalogId, layer.catalogRevisionId)
  if (kind === 'save') for (const receipt of SaveWorkspaceDocumentSchema.parse(value).requirements) catalog(receipt.catalogId, receipt.catalogRevisionId)
  if (kind === 'build') add('build-checkpoint', (value as LocalData['builds'][string]).latestRevisionId)
  if (kind === 'build-checkpoint') { const record = value as LocalData['buildRevisions'][string]; add('setup', record.gameSetupRevisionId); add('build-checkpoint', record.parentRevisionId); lock(record.catalogLock); for (const ref of buildModReferences(record.content as BuildRevisionContent)) entity(ref) }
  if (kind === 'team') { const team = value as LocalData['teams'][string]; if (team.kind === 'shared') add('team-checkpoint', team.latestRevisionId); else for (const id of team.slots) if (id) add('build-checkpoint', id) }
  if (kind === 'team-checkpoint') { const revision = value as LocalData['teamRevisions'][string]; add('setup', revision.gameSetupRevisionId); add('team-checkpoint', revision.parentRevisionId); lock(revision.catalogLock); for (const slot of revision.slots) if (slot) { add('build-checkpoint', slot.sourceBuildRevisionId); for (const ref of buildModReferences(slot.content)) entity(ref) } }
  if (kind === 'setup') { const record = value as LocalData['gameSetups'][string]; [record.platform, record.gameVersion, record.mode, record.mods, record.disabledMods, record.ppLimit, record.ppCostsNonNegative, record.difficulty?.selection].forEach(knowledge); for (const slot of record.slots) { slot.sources.forEach(source); knowledge(slot.acceptedEntityKinds) }; lock(record.catalogLock); for (const ref of record.definitionOverrides ?? []) entity(ref); if (record.modComposition) { catalog(record.modComposition.baseline.catalogId, record.modComposition.baseline.catalogRevisionId); for (const layer of record.modComposition.layers) catalog(layer.catalogId, layer.catalogRevisionId) } }
  if (kind === 'personal-definition') { const record = value as LocalData['personalDefinitions'][string]; entity(record.baseRef); entity(record.previousRevision); for (const list of values(record.requirements)) for (const requirement of list) if (requirement.kind === 'selected') entity(requirement.ref) }
  if (kind === 'scenario') { const record = value as Playthrough['scenarios'][string]; add('setup', record.gameSetupRevisionId); lock(record.catalogLock); for (const id of [...Object.values(record.assignments), ...(scenarioDependencies === 'complete-v1' && record.baseline.kind === 'recordedParty' ? Object.values(record.baseline.assignments) : [])]) if (id) { if (typeof id === 'string') add('build-checkpoint', id); else if (id.kind === 'build') add('build-checkpoint', id.revisionId); else add('team-checkpoint', id.teamRevisionId) } }
  if (kind === 'playthrough') add('setup', (value as { metadata: Playthrough }).metadata.currentGameSetupRevisionId)
  if (kind === 'progress') { const record = value as Playthrough['progress'][string]; entity(record.subject); record.sources.forEach(source); [record.stage, record.unlocked, record.partyMastery, record.collection, record.masterLocation].forEach(knowledge) }
  if (kind === 'goal') for (const requirement of (value as Playthrough['goals'][string]).requirements) entity(requirement.target)
  if (kind === 'inventory') { const record = value as Pick<Playthrough, 'inventory' | 'inventoryEvents'>; for (const row of [...Object.values(record.inventory), ...Object.values(record.inventoryEvents)]) { entity(row.ref); row.sources.forEach(source); if ('kind' in row) knowledge(row.quantity) } }
  if (kind === 'skill-layout' || kind === 'skill-capture') { const record = value as NonNullable<LocalData['skillTreeLayouts']>[string]; entity(record.classRef); add('setup', record.gameSetupRevisionId); for (const row of record.mappings) entity(row.ref) }
  if (kind === 'character') {
    const record = value as Playthrough['characters'][string]
    for (const snapshot of Object.values(record.snapshots)) { snapshot.sources.forEach(source); [snapshot.level, snapshot.primaryClass, snapshot.secondaryClass, snapshot.passives, ...Object.values(snapshot.displayedStats).map(stat => stat.value)].forEach(knowledge); add('setup', snapshot.gameSetupRevisionId); for (const ref of [...values(snapshot.primaryClass), ...values(snapshot.secondaryClass), ...values(snapshot.passives).flat(), ...Object.values(snapshot.equipment)]) entity(ref); calculation(snapshot.calculation) }
    for (const row of Object.values(record.classProgress)) { entity(row.classRef); row.sources.forEach(source); [row.unlocked, row.coreTreeComplete, row.mastered, row.observedLp].forEach(knowledge) }
    for (const row of Object.values(record.learnedNodes)) { entity(row.ref); row.sources.forEach(source); [row.learned, row.actualPaidLp].forEach(knowledge) }
  }
  if (kind === 'history') {
    const history = value as import('../interchange/types').PersistedHistoryEntry
    const retainExternal = (kind: WorkspaceDocumentKind, value: unknown) => { for (const key of domainClosureKeys(kind, value)) if (['catalog', 'source'].includes(JSON.parse(key)[0])) keys.add(key) }
    // Historical roots embed their original domain records; only their external originals need separate bodies
    for (const root of [history.before, history.after]) {
      for (const [field, kind] of Object.entries({ gameSetups: 'setup', personalDefinitions: 'personal-definition', buildRevisions: 'build-checkpoint', teamRevisions: 'team-checkpoint', skillTreeLayouts: 'skill-layout' } as const)) for (const record of Object.values(root[field as keyof typeof root] ?? {})) retainExternal(kind, record)
      for (const playthrough of Object.values(root.playthroughs)) {
        for (const [field, kind] of Object.entries({ characters: 'character', progress: 'progress', goals: 'goal', scenarios: 'scenario', skillTreeCaptures: 'skill-capture' } as const)) for (const record of Object.values(playthrough[field as keyof typeof playthrough] ?? {})) retainExternal(kind, record)
        retainExternal('inventory', { inventory: playthrough.inventory, inventoryEvents: playthrough.inventoryEvents })
      }
    }
  }
  const result = Object.freeze([...keys])
  if (kind === 'catalog') immutableCatalogEdges.set(value as object, result)
  if (kind === 'history') immutableHistoryEdges.set(value as object, result)
  return result
}

// Unavailable pins require their owning setup evidence inside this unit, never a workspace-wide receipt
export function resolvedDomainClosureKeys(document: Pick<WorkspaceDocument, 'key' | 'kind' | 'value'>, documents: ReadonlyMap<string, WorkspaceDocument>, scenarioDependencies: 'complete-v1' | 'legacy-s02' = 'complete-v1'): readonly string[] {
  const parts = JSON.parse(document.key) as string[]
  if (!Array.isArray(parts) || parts.some(part => typeof part !== 'string') || !['tombstone', 'directory-mapping-unit'].includes(document.kind) && parts[0] !== document.kind) throw new Error('Private archive identity mismatch')
  const record = document.value as unknown as { id?: string; revisionId?: string; metadata?: { id: string }; privateKey?: string }
  const child = ['character', 'progress', 'goal', 'scenario', 'skill-capture'].includes(document.kind)
  if (document.kind === 'tombstone' ? record.privateKey !== document.key : record.id !== undefined && (record.id !== parts[child ? 2 : 1] || parts.length !== (child || document.kind === 'catalog' ? 3 : 2) || document.kind === 'catalog' && record.revisionId !== parts[2])) throw new Error('Private archive identity mismatch')
  if (document.kind === 'playthrough' && record.metadata?.id !== parts[1]) throw new Error('Private archive identity mismatch')
  const keys = new Set(domainClosureKeys(document.kind, document.value, scenarioDependencies))
  const digests = new Set<string>()
  if (document.kind === 'evidence' || document.kind === 'skill-capture') digests.add((document.value as unknown as { sourceDigest: string }).sourceDigest)
  if (document.kind === 'history') { const history = document.value as unknown as import('../interchange/types').PersistedHistoryEntry; for (const root of [history.before, history.after]) for (const playthrough of Object.values(root.playthroughs)) for (const capture of Object.values(playthrough.skillTreeCaptures ?? {})) digests.add(capture.sourceDigest) }
  // Digest-owned records resolve the actual source identities, which older native bundles may name differently
  for (const digest of digests) {
    const sources = [...documents.values()].filter(value => value.kind === 'source' && (value.value as unknown as { digest: string }).digest === digest)
    if (!sources.length) throw new Error('Missing exact source original')
    for (const source of sources) keys.add(source.key)
  }
  const setups = new Map<string, import('../domain/types').GameSetupRevision>()
  const includeSetup = (value: import('../domain/types').GameSetupRevision) => { rootSchemas.setup.parse(value); setups.set(value.id, value) }
  if (document.kind === 'setup') includeSetup(document.value as unknown as import('../domain/types').GameSetupRevision)
  if (document.kind === 'history') { const history = document.value as unknown as import('../interchange/types').PersistedHistoryEntry; for (const root of [history.before, history.after]) for (const setup of Object.values(root.gameSetups)) includeSetup(setup) }
  for (const key of keys) { const value = documents.get(key); if (value?.kind === 'setup') includeSetup(value.value as unknown as import('../domain/types').GameSetupRevision) }
  if (['character', 'progress', 'goal', 'inventory', 'quintar-breeding', 'skill-capture'].includes(document.kind)) {
    const ownerKey = privateRecordKey('playthrough', parts[1])
    const owner = documents.get(ownerKey)?.value as unknown as { metadata: Playthrough } | undefined
    if (!owner) throw new Error('Missing owning playthrough evidence')
    keys.add(ownerKey)
    const setupKey = owner?.metadata.currentGameSetupRevisionId ? privateRecordKey('setup', owner.metadata.currentGameSetupRevisionId) : undefined
    const setup = setupKey ? documents.get(setupKey) : undefined
    if (setup) { keys.add(setupKey!); includeSetup(setup.value as unknown as import('../domain/types').GameSetupRevision) }
  }
  for (const setup of [...setups.values()]) if (setup.modComposition) {
    const revision = setup.catalogLock[setup.modComposition.baseline.catalogId]
    if ([...setups.values()].some(value => modCatalogRevision(value.id) === revision)) continue
    const origin = [...documents.values()].find(value => value.kind === 'setup' && modCatalogRevision((value.value as unknown as import('../domain/types').GameSetupRevision).id) === revision)
    if (!origin) throw new Error('Unavailable composition has no originating setup evidence')
    const value = origin.value as unknown as import('../domain/types').GameSetupRevision
    includeSetup(value)
    if (origin.key !== document.key) keys.add(origin.key)
  }
  const catalogKeys = new Set([...keys].filter(key => JSON.parse(key)[0] === 'catalog'))
  for (const setup of setups.values()) for (const key of domainClosureKeys('setup', setup)) if (JSON.parse(key)[0] === 'catalog') catalogKeys.add(key)
  const catalogs = [...catalogKeys].flatMap(key => { const value = documents.get(key); return value?.kind === 'catalog' ? [value.value as unknown as import('../domain/types').CatalogSnapshot] : [] })
  // A dependent record retains its setup, not every imported catalog in that setup's checked closure
  // Only missing direct pins need unavailable-source authority; setup/history owners always verify their receipts
  const needsUnavailableSources = document.kind === 'setup' || document.kind === 'history' || [...keys].some(key => JSON.parse(key)[0] === 'catalog' && !documents.has(key))
  const unavailable = new Set(needsUnavailableSources ? unavailableSetupCatalogKeys([...setups.values()], [...BUNDLED_CATALOGS, ...catalogs]) : [])
  if (document.kind === 'setup') {
    const setup = document.value as unknown as import('../domain/types').GameSetupRevision
    if (setup.publicSourceContext) { assertPublicSetupContext(setup); for (const [id, revision] of Object.entries(setup.catalogLock)) unavailable.add(catalogSnapshotKey(id as never, revision)) }
  }
  if (document.kind === 'build-checkpoint' || document.kind === 'team-checkpoint') {
    const checkpoint = document.value as unknown as import('../domain/types').BuildRevision | import('../domain/types').TeamRevision
    if (checkpoint.publicSourceContext || setups.get(checkpoint.gameSetupRevisionId)?.publicSourceContext) {
      const setup = setups.get(checkpoint.gameSetupRevisionId)
      if (!setup) throw new Error('Copied checkpoint has no owning source context')
      const snapshot = publicSnapshotFromCheckpoint(setup, checkpoint, 'Copied selections')
      const selected = 'slots' in checkpoint ? checkpoint.slots.flatMap(slot => slot ? buildModReferences(slot.content) : []) : buildModReferences(checkpoint.content)
      validatePresentCatalogReferences(selected, catalogs)
      const preferences = documents.get(privateRecordKey('workspace-preferences'))
      assertPublicPersonalBindings(checkpoint.publicSourceContext!, snapshot, preferences ? rootSchemas['workspace-preferences'].parse(preferences.value).unavailableDefinitions as LocalData['unavailableDefinitions'] : undefined, id => documents.has(privateRecordKey('personal-definition', id)))
      for (const [id, revision] of Object.entries(checkpoint.catalogLock)) unavailable.add(catalogSnapshotKey(id as never, revision))
      for (const receipt of snapshot.receipts) if (receipt.ref.kind === 'catalog') unavailable.add(catalogSnapshotKey(receipt.ref.catalogId as never, receipt.ref.catalogRevisionId as never))
    }
  }
  if (document.kind === 'history') {
    const history = document.value as unknown as import('../interchange/types').PersistedHistoryEntry
    for (const root of [history.before, history.after]) {
      const publicKeys = publicUnavailableCatalogKeys(root)
      // Embedded records must own their individual missing pins before the history unit unions edges
      // Otherwise an ordinary setup could borrow a copied sibling's receipt in an isolated archive
      if (publicKeys.size) validateNativeLocalDataGraph(root, catalogs)
      for (const key of publicKeys) unavailable.add(key)
    }
  }
  if (document.kind === 'save') {
    const receipts = SaveWorkspaceDocumentSchema.parse(document.value).requirements as unknown as readonly import('../domain/types').ModSourceReceipt[]
    // File requirements own their receipts; their scope cannot authorize a different domain unit
    assertModSourceReceipts({ modSourceReceipts: receipts, modComposition: { baseline: { catalogId: '' as never, catalogRevisionId: '' as never }, layers: receipts.map(value => ({ ...value, enabled: true })), links: [] } })
    for (const receipt of receipts) {
      const body = documents.get(privateRecordKey('catalog', receipt.catalogId, receipt.catalogRevisionId))?.value as unknown as import('../domain/types').CatalogSnapshot | undefined
      if (body && body.checksum !== receipt.checksum) throw new Error('File requirement catalog checksum mismatch')
      if (!body) unavailable.add(catalogSnapshotKey(receipt.catalogId, receipt.catalogRevisionId))
    }
  }
  for (const key of keys) {
    const [kind, id, revision] = JSON.parse(key) as string[]
    if (kind === 'personal-definition' && !documents.has(key)) {
      const preferencesKey = privateRecordKey('workspace-preferences')
      const preferences = documents.get(preferencesKey)
      const receipts = preferences ? rootSchemas['workspace-preferences'].parse(preferences.value).unavailableDefinitions : undefined
      if (receipts?.some(receipt => receipt.ref.kind === 'personal' && receipt.ref.definitionId === id)) {
        // The dependent closure carries its exact receipt document; a missing definition never gains mechanics
        keys.delete(key); keys.add(preferencesKey)
      }
    }
    if (kind === 'catalog' && !documents.has(key) && unavailable.has(catalogSnapshotKey(id as never, revision as never))) keys.delete(key)
  }
  return [...keys]
}

import { publicRefKey, validatePublicSnapshot, type PublicRef, type PublicSnapshot } from '../interchange/public-share-schema'
import { checkpointContentDigest } from './checkpoint-identity'
import { buildModReferences } from './build-references'
import type { BuildRevision, BuildRevisionContent, EntityRef, GameSetupRevision, Knowledge, LocalData, TeamRevision } from './types'

export { PublicSetupContextSchema, PublicCheckpointContextSchema } from '../interchange/public-source-context-schema'
export type { PublicSetupContext, PublicCheckpointContext } from '../interchange/public-source-context-schema'
import { PublicSetupContextSchema, PublicCheckpointContextSchema, type PublicCheckpointContext } from '../interchange/public-source-context-schema'
type Checkpoint = BuildRevision | TeamRevision
const equal = (left: unknown, right: unknown) => checkpointContentDigest(left) === checkpointContentDigest(right)

export function publicKnowledge<T>(value: { state: 'known'; value: T } | { state: 'unknown' | 'conflicting' | 'notApplicable' }): Knowledge<T> {
  // Public conflicting claims intentionally omit private claim bodies; preserve that state in the inert receipt
  if (value.state === 'known') return value
  return value.state === 'conflicting' ? { state: 'unknown', reason: 'The shared source reports conflicting claims.' } : { state: value.state }
}
export function assertPublicSetupContext(setup: GameSetupRevision): void {
  if (!setup.publicSourceContext) return
  const { setup: original } = PublicSetupContextSchema.parse(setup.publicSourceContext)
  const slots = original.slots.map((slot, order) => ({ ...slot, kind: 'equipment', order, provenance: 'imported', sources: [] }))
  if (!equal(original.catalogLock, setup.catalogLock) || !equal(slots, setup.slots) || !equal(setup.mode, publicKnowledge(original.mode)) || !equal(setup.ppCostsNonNegative, publicKnowledge(original.ppCostsNonNegative)) || !equal(setup.ppLimit, original.ppLimit && publicKnowledge(original.ppLimit)) || !equal(setup.difficulty?.selection, original.difficulty && publicKnowledge(original.difficulty)) || !equal(setup.platform, { state: 'unknown' }) || !equal(setup.gameVersion, { state: 'unknown' }) || !equal(setup.mods, { state: 'known', value: original.layers.map(layer => layer.title) }) || setup.disabledMods || setup.customMods?.length || setup.modSourceReceipts?.length || setup.modComposition || setup.definitionOverrides?.length) throw new Error('Copied public setup differs from its exact source receipt')
}
export function publicSetupAllowsPin(setup: GameSetupRevision | undefined, catalogId: string, revisionId: string): boolean {
  if (!setup?.publicSourceContext) return false
  assertPublicSetupContext(setup)
  return setup.publicSourceContext.setup.catalogLock?.[catalogId] === revisionId
}
function toPublicRef(context: PublicCheckpointContext, ref: EntityRef): PublicRef {
  if (ref.kind === 'catalog') return { ...ref }
  const binding = context.personalBindings.find(binding => binding.ref.definitionId === ref.definitionId)
  if (!binding) throw new Error('Copied personal selection has no exact fingerprint binding')
  return { kind: 'personal', fingerprint: { kind: 'personal-definition-v1', value: binding.fingerprint } }
}
function publicContent(content: BuildRevisionContent, context: PublicCheckpointContext): PublicSnapshot['slots'][number] {
  const map = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(map)
    if ('kind' in value && (value.kind === 'catalog' || value.kind === 'personal')) return toPublicRef(context, value as EntityRef)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, map(entry)]))
  }
  const groups = new Map<string, string[]>()
  for (const [id, selection] of Object.entries(content.equipment)) if (selection?.allocationId) groups.set(selection.allocationId, [...groups.get(selection.allocationId) ?? [], id])
  return { primaryClass: content.primaryClass && toPublicRef(context, content.primaryClass), secondaryClass: content.secondaryClass && toPublicRef(context, content.secondaryClass), equipment: Object.entries(content.equipment).map(([slotId, selection]) => ({ slotId, ref: selection ? toPublicRef(context, selection.ref) : null })), equipmentGroups: [...groups.values()].filter(group => group.length > 1), passives: content.passives.map(selection => toPublicRef(context, selection.ref)), ...(content.calculation ? { calculation: map(content.calculation) as NonNullable<PublicSnapshot['slots'][number]>['calculation'] } : {}) }
}
export function publicSnapshotFromCheckpoint(setup: GameSetupRevision, checkpoint: Checkpoint, title: string): PublicSnapshot {
  assertPublicSetupContext(setup)
  const context = PublicCheckpointContextSchema.parse(checkpoint.publicSourceContext)
  if (!setup.publicSourceContext || context.setupDigest !== checkpointContentDigest(setup.publicSourceContext) || !equal(checkpoint.catalogLock, setup.catalogLock)) throw new Error('Copied checkpoint differs from its exact setup receipt')
  const contents = 'slots' in checkpoint ? checkpoint.slots.map(slot => slot?.content ?? null) : [checkpoint.content]
  if (new Set(context.personalBindings.map(value => value.fingerprint)).size !== context.personalBindings.length || new Set(context.personalBindings.map(value => value.ref.definitionId)).size !== context.personalBindings.length) throw new Error('Copied personal bindings must be one-to-one')
  const selected = contents.flatMap(content => content ? buildModReferences(content).filter(ref => ref.kind === 'personal').map(ref => ref.definitionId as string) : [])
  if (context.personalBindings.some(binding => !selected.includes(binding.ref.definitionId))) throw new Error('Copied personal bindings contain an unselected definition')
  const notes = 'slots' in checkpoint ? checkpoint.slots.map(slot => slot?.note) : [checkpoint.note]
  const names = 'slots' in checkpoint ? checkpoint.slots.map(slot => slot?.name) : []
  // Build notes belong to their only slot; the Team checkpoint has a separate shared note
  return validatePublicSnapshot({ version: 5, kind: 'slots' in checkpoint ? 'team' : 'build', title, setup: setup.publicSourceContext.setup, slots: contents.map((content, index) => content ? { ...publicContent(content, context), ...(names[index] !== undefined ? { name: names[index] } : {}) } : null), receipts: context.receipts, notes: { ...('slots' in checkpoint && checkpoint.note !== undefined ? { checkpoint: checkpoint.note } : {}), slots: contents.map((content, index) => content ? { contextAssumptions: [...content.contextAssumptions], ...(content.rotationNotes !== undefined ? { rotationNotes: content.rotationNotes } : {}), ...(notes[index] !== undefined ? { checkpoint: notes[index] } : {}) } : null) } })
}
export function assertPublicCheckpointContext(localData: LocalData, checkpoint: Checkpoint): void {
  const setup = localData.gameSetups[checkpoint.gameSetupRevisionId]
  if (!checkpoint.publicSourceContext && !setup?.publicSourceContext) return
  if (!setup) throw new Error('Copied checkpoint setup is unavailable')
  const snapshot = publicSnapshotFromCheckpoint(setup, checkpoint, 'Copied selections')
  assertPublicPersonalBindings(checkpoint.publicSourceContext!, snapshot, localData.unavailableDefinitions, id => Boolean(localData.personalDefinitions[id]))
}

// The isolated archive and full graph must enforce the same receipt-only personal identity
export function assertPublicPersonalBindings(context: PublicCheckpointContext, snapshot: PublicSnapshot, unavailable: LocalData['unavailableDefinitions'], hasDefinition: (id: string) => boolean): void {
  for (const binding of context.personalBindings) {
    const receipt = snapshot.receipts.find(value => value.ref.kind === 'personal' && value.ref.fingerprint.value === binding.fingerprint)
    const local = unavailable?.find(value => value.ref.kind === 'personal' && value.ref.definitionId === binding.ref.definitionId)
    if (!receipt || !local || local.name !== receipt.name || local.kind !== receipt.kind || local.fingerprint?.kind !== 'personal-definition-v1' || local.fingerprint.value !== binding.fingerprint || hasDefinition(binding.ref.definitionId)) throw new Error('Copied personal receipt differs from its selected fingerprint')
  }
}
export function publicCheckpointAllowsRef(localData: LocalData, checkpoint: Checkpoint, ref: EntityRef): boolean {
  if (!checkpoint.publicSourceContext) return false
  assertPublicCheckpointContext(localData, checkpoint)
  const selected = toPublicRef(checkpoint.publicSourceContext, ref)
  return checkpoint.publicSourceContext.receipts.some(receipt => publicRefKey(receipt.ref) === publicRefKey(selected))
}
export function assertPublicSourceContexts(localData: LocalData): void {
  for (const setup of Object.values(localData.gameSetups)) {
    if (!setup.publicSourceContext) continue
    assertPublicSetupContext(setup)
    if (localData.planningGameSetupRevisionId === setup.id || Object.values(localData.playthroughs).some(playthrough => playthrough.currentGameSetupRevisionId === setup.id || Object.values(playthrough.scenarios).some(scenario => scenario.gameSetupRevisionId === setup.id))) throw new Error('Choose an available local setup before using copied public context in a Playthrough')
  }
  for (const checkpoint of [...Object.values(localData.buildRevisions), ...Object.values(localData.teamRevisions ?? {})]) assertPublicCheckpointContext(localData, checkpoint)
}

// Scope inert metadata to actual typed root records, not lookalike objects inside imported fields
export function publicContextContainers(...roots: readonly LocalData[]): ReadonlySet<object> {
  return new Set(roots.flatMap(root => [...Object.values(root.gameSetups), ...Object.values(root.buildRevisions), ...Object.values(root.teamRevisions ?? {})]).filter(record => record.publicSourceContext))
}
export function publicUnavailableCatalogKeys(data: LocalData): ReadonlySet<string> {
  assertPublicSourceContexts(data)
  const keys = new Set<string>()
  for (const setup of Object.values(data.gameSetups)) if (setup.publicSourceContext) for (const [id, revision] of Object.entries(setup.catalogLock)) keys.add(JSON.stringify([id, revision]))
  for (const checkpoint of [...Object.values(data.buildRevisions), ...Object.values(data.teamRevisions ?? {})]) if (checkpoint.publicSourceContext) for (const receipt of checkpoint.publicSourceContext.receipts) if (receipt.ref.kind === 'catalog') keys.add(JSON.stringify([receipt.ref.catalogId, receipt.ref.catalogRevisionId]))
  return keys
}

export function publicContextForNoteEdit(previous: Checkpoint | undefined, setup: GameSetupRevision, contents: readonly (BuildRevisionContent | null)[]): PublicCheckpointContext | undefined {
  if (!setup.publicSourceContext) return undefined
  const original = previous && ('slots' in previous ? previous.slots.map(slot => slot?.content ?? null) : [previous.content])
  const selections = (content: BuildRevisionContent | null) => {
    if (!content) return null
    const { rotationNotes: _notes, contextAssumptions: _assumptions, ...selected } = content
    return selected
  }
  if (!previous?.publicSourceContext || previous.gameSetupRevisionId !== setup.id || !equal(original?.map(selections), contents.map(selections))) throw new Error('Choose an available local setup to adapt these copied selections before editing them')
  return previous.publicSourceContext
}

export function publicContextForContent(context: PublicCheckpointContext, content: BuildRevisionContent): PublicCheckpointContext {
  const refs = buildModReferences(content)
  const selected = new Set(refs.map(ref => publicRefKey(toPublicRef(context, ref))))
  return { ...context, receipts: context.receipts.filter(receipt => selected.has(publicRefKey(receipt.ref))), personalBindings: context.personalBindings.filter(binding => refs.some(ref => ref.kind === 'personal' && ref.definitionId === binding.ref.definitionId)) }
}

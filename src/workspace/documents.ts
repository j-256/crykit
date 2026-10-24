import type { JsonValue, LocalData, Playthrough } from '../domain/types'
import type { ImportCandidate, SourceArchiveRecord } from '../interchange/types'
import type { BlobSource, EditorWorkspaceDocument, LibraryDefaults, SaveWorkspaceDocument, WorkspaceAsset, WorkspaceBlobRef } from './file-types'
import type { WorkspaceConflict } from './conflict-types'
import type { WorkspaceRetainedContent } from './retained-content-types'
import { z } from 'zod'
import { NativeLocalDataSchema, NativeLocalData240Schema, NativeLineageSchema } from '../interchange/native-schema'
import { blobIdentity } from './blobs'
import { immutableCatalogSnapshot } from '../interchange/native'
import { validateWorkspace } from './validation'

export type * from './file-types'
export type * from './conflict-types'
export type * from './retained-content-types'
export type WorkspaceSourceRecord = Omit<SourceArchiveRecord, 'bytes'> & { readonly original: WorkspaceBlobRef }
export type WorkspacePlannerState = Omit<ImportCandidate, 'sources'> & { readonly sources: readonly WorkspaceSourceRecord[]; readonly savedChanges?: readonly import('../domain/types').ChangeEntry[]; readonly journal?: import('./planner-journal').PlannerJournal }
export interface WorkspaceState {
  readonly planner: WorkspacePlannerState
  readonly editorDocuments: readonly EditorWorkspaceDocument[]
  readonly saveDocuments: readonly SaveWorkspaceDocument[]
  readonly assets: readonly WorkspaceAsset[]
  readonly libraryDefaults: LibraryDefaults
  readonly conflicts: readonly WorkspaceConflict[]
  readonly retainedContent: readonly WorkspaceRetainedContent[]
  readonly blobs: readonly { readonly ref: WorkspaceBlobRef; readonly content: BlobSource }[]
}
export const WORKSPACE_DOCUMENT_KINDS = [
  'workspace-identity', 'workspace-preferences', 'build', 'build-checkpoint', 'team', 'team-checkpoint', 'playthrough', 'character', 'progress', 'goal', 'scenario', 'inventory', 'quintar-breeding', 'personal-definition', 'setup', 'catalog', 'source', 'evidence', 'import-receipt', 'history', 'change', 'skill-layout', 'skill-capture', 'reference-preferences', 'library-defaults', 'editor', 'save', 'asset', 'conflict', 'retained-content', 'blob', 'blob-reference', 'directory', 'directory-page', 'tombstone', 'unit-index', 'directory-mapping-unit', 'workspace-control', 'baseline-page', 'recovery-page',
] as const
export type WorkspaceDocumentKind = typeof WORKSPACE_DOCUMENT_KINDS[number]
export interface WorkspaceDocument { readonly version: 1; readonly kind: WorkspaceDocumentKind; readonly key: string; readonly value: JsonValue | BlobSource }

const identitySchema = z.object({ localData: z.union([NativeLocalDataSchema.pick({ schemaVersion: true, id: true, createdAt: true, updatedAt: true }).partial({ updatedAt: true }).strict(), NativeLocalData240Schema.pick({ schemaVersion: true, id: true, createdAt: true, updatedAt: true }).partial({ updatedAt: true }).strict()]), lineage: NativeLineageSchema }).strict()
const preferencesSchema = z.object({ modSetup: NativeLocalDataSchema.shape.modSetup, unavailableDefinitions: NativeLocalDataSchema.shape.unavailableDefinitions, optional: z.object({ skillTreeLayouts: z.boolean() }).strict() }).strict()
const playthroughSchema = z.object({ metadata: NativeLocalDataSchema.shape.playthroughs.valueType.omit({ activeScenarioId: true, characters: true, progress: true, goals: true, scenarios: true, inventory: true, inventoryEvents: true, quintarBreeding: true, skillTreeCaptures: true }).strict(), optional: z.object({ skillTreeCaptures: z.boolean(), quintarBreeding: z.boolean() }).strict() }).strict()
const rootMaps = { personalDefinitions: 'personal-definition', gameSetups: 'setup', builds: 'build', buildRevisions: 'build-checkpoint', teams: 'team', teamRevisions: 'team-checkpoint', importReceipts: 'import-receipt', skillTreeLayouts: 'skill-layout' } as const
const playthroughMaps = { characters: 'character', progress: 'progress', goals: 'goal', scenarios: 'scenario', skillTreeCaptures: 'skill-capture' } as const
const plannerArrays = { catalogs: 'catalog', sources: 'source', evidence: 'evidence', history: 'history' } as const
const fileArrays = { editorDocuments: 'editor', saveDocuments: 'save', assets: 'asset', conflicts: 'conflict', retainedContent: 'retained-content' } as const
export function privateRecordKey(kind: WorkspaceDocumentKind, ...ids: string[]): string { return JSON.stringify([kind, ...ids]) }
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }

export function splitWorkspace(state: WorkspaceState): readonly WorkspaceDocument[] {
  validateWorkspace(state)
  return captureWorkspaceDocuments(state, captureWorkspaceDocument)
}

// Capturing a value supplies no validation or storage authority
export function captureWorkspaceDocument(kind: WorkspaceDocumentKind, key: string, value: unknown): WorkspaceDocument {
  return { version: 1, kind, key, value: kind === 'blob' ? value as BlobSource : kind === 'catalog' ? immutableCatalogSnapshot(value as import('../domain/types').CatalogSnapshot) as unknown as JsonValue : json(value) }
}

// Enumeration alone supplies no validation or storage authority
// Managed local captures can reuse exact immutable values without cloning old checkpoint bodies
export function captureWorkspaceDocuments(state: WorkspaceState, capture: (kind: WorkspaceDocumentKind, key: string, value: unknown) => WorkspaceDocument): readonly WorkspaceDocument[] {
  const result: WorkspaceDocument[] = []
  const add = (kind: WorkspaceDocumentKind, value: unknown, ...ids: string[]) => result.push(capture(kind, privateRecordKey(kind, ...ids), value))
  const local = state.planner.localData
  const identity = { ...local } as Record<string, unknown>
  for (const field of [...Object.keys(rootMaps), 'playthroughs', 'changes', 'referenceLibrary', 'revision', 'modSetup', 'unavailableDefinitions', 'selectedPlaythroughId', 'planningGameSetupRevisionId']) delete identity[field]
  // Live selections are device state; historical before/after records below remain exact inert evidence
  add('workspace-identity', { localData: identity, lineage: state.planner.lineage })
  add('workspace-preferences', { ...(local.unavailableDefinitions ? { unavailableDefinitions: local.unavailableDefinitions } : {}), ...(local.modSetup ? { modSetup: local.modSetup } : {}), optional: { skillTreeLayouts: local.skillTreeLayouts !== undefined } })
  for (const [field, kind] of Object.entries(rootMaps)) for (const [id, value] of Object.entries(local[field as keyof typeof rootMaps] ?? {})) add(kind, value, id)
  for (const [id, playthrough] of Object.entries(local.playthroughs)) {
    const metadata = { ...playthrough } as Record<string, unknown>
    for (const field of [...Object.keys(playthroughMaps), 'inventory', 'inventoryEvents', 'quintarBreeding', 'activeScenarioId']) delete metadata[field]
    add('playthrough', { metadata, optional: { skillTreeCaptures: playthrough.skillTreeCaptures !== undefined, quintarBreeding: playthrough.quintarBreeding !== undefined } }, id)
    // Inventory positions and events form one conflict unit; independent merges would invent stock
    add('inventory', { inventory: playthrough.inventory, inventoryEvents: playthrough.inventoryEvents }, id)
    if (playthrough.quintarBreeding) add('quintar-breeding', playthrough.quintarBreeding, id)
    for (const [field, kind] of Object.entries(playthroughMaps)) for (const [recordId, value] of Object.entries(playthrough[field as keyof typeof playthroughMaps] ?? {})) add(kind, value, id, recordId)
  }
  for (const change of state.planner.savedChanges ?? local.changes) add('change', change, change.id)
  if (local.referenceLibrary) add('reference-preferences', local.referenceLibrary)
  for (const [field, kind] of Object.entries(plannerArrays)) for (const value of state.planner[field as keyof typeof plannerArrays]) {
    if (kind === 'catalog') add(kind, value, value.id, (value as import('../domain/types').CatalogSnapshot).revisionId)
    else add(kind, value, value.id, ...('revisionId' in value ? [value.revisionId] : []))
  }
  for (const [field, kind] of Object.entries(fileArrays)) for (const value of state[field as keyof typeof fileArrays]) add(kind, value, value.id)
  add('library-defaults', state.libraryDefaults)
  for (const { ref, content } of state.blobs) {
    add('blob-reference', ref, blobIdentity(ref))
    add('blob', content, blobIdentity(ref))
  }
  return result
}

export function assembleWorkspace(documents: readonly WorkspaceDocument[], localRevision: number, journal?: import('./planner-journal').PlannerJournal, bookkeeping?: ReadonlyMap<string, { revision: number; updatedAt: string }>): WorkspaceState {
  if (!Number.isSafeInteger(localRevision) || localRevision < 0) throw new Error('Invalid local projection fence')
  const byKey = new Map<string, WorkspaceDocument>()
  for (const document of documents) {
    if (document.version !== 1 || !WORKSPACE_DOCUMENT_KINDS.includes(document.kind) || byKey.has(document.key)) throw new Error('Unsupported or duplicate workspace document')
    byKey.set(document.key, document)
  }
  const take = (kind: WorkspaceDocumentKind, ...ids: string[]): JsonValue => {
    const key = privateRecordKey(kind, ...ids), document = byKey.get(key)
    if (!document || document.kind !== kind || isBlobSource(document.value)) throw new Error(`Missing ${kind} document`)
    byKey.delete(key)
    return document.value
  }
  const identity = identitySchema.parse(take('workspace-identity')) as unknown as { localData: LocalData; lineage: WorkspacePlannerState['lineage'] }
  const preferences = preferencesSchema.parse(take('workspace-preferences')) as unknown as { modSetup?: LocalData['modSetup']; unavailableDefinitions?: LocalData['unavailableDefinitions']; optional: { skillTreeLayouts: boolean } }
  const local = { ...identity.localData, ...(preferences.unavailableDefinitions ? { unavailableDefinitions: preferences.unavailableDefinitions } : {}), ...(String(identity.localData.schemaVersion) === '2.5.0' ? { teamRevisions: {} } : {}), ...(preferences.modSetup ? { modSetup: preferences.modSetup } : {}), updatedAt: identity.localData.updatedAt ?? identity.localData.createdAt, revision: localRevision, personalDefinitions: {}, gameSetups: {}, builds: {}, buildRevisions: {}, teams: {}, importReceipts: {}, playthroughs: {}, changes: [], ...(preferences.optional.skillTreeLayouts ? { skillTreeLayouts: {} } : {}) } as unknown as Record<string, unknown>
  const planner = { localData: local, lineage: identity.lineage, catalogs: [], sources: [], evidence: [], history: [] } as unknown as Record<string, unknown>
  const state = { planner, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: take('library-defaults') } as unknown as Record<string, unknown>
  const playthroughs = local.playthroughs as Record<string, Record<string, unknown>>
  for (const document of documents.filter(value => value.kind === 'playthrough')) {
    const ids = JSON.parse(document.key) as string[]
    const value = playthroughSchema.parse(take('playthrough', ids[1])) as unknown as { metadata: Playthrough; optional: { skillTreeCaptures: boolean; quintarBreeding: boolean } }
    if (value.metadata.id !== ids[1]) throw new Error('Playthrough key mismatch')
    playthroughs[ids[1]] = { ...value.metadata, characters: {}, progress: {}, goals: {}, scenarios: {}, ...(value.optional.skillTreeCaptures ? { skillTreeCaptures: {} } : {}), ...(value.optional.quintarBreeding ? { quintarBreeding: {} } : {}), ...take('inventory', ids[1]) as object }
  }
  for (const document of [...byKey.values()]) {
    const ids = JSON.parse(document.key) as string[]
    if (!Array.isArray(ids) || ids[0] !== document.kind || ids.some(id => typeof id !== 'string')) throw new Error('Private key mismatch')
    // A well-formed body under another private key must never install a second semantic identity
    if (document.kind !== 'blob' && document.kind !== 'blob-reference' && document.value && typeof document.value === 'object' && 'id' in document.value) {
      const value = document.value as { id: unknown; revisionId?: unknown }
      const child = Object.values(playthroughMaps).some(kind => kind === document.kind)
      if (value.id !== ids[child ? 2 : 1] || ids.length !== (document.kind === 'catalog' || child ? 3 : 2) || document.kind === 'catalog' && value.revisionId !== ids[2]) throw new Error('Private record identity mismatch')
    }
    const rootField = Object.entries(rootMaps).find(([, kind]) => kind === document.kind)?.[0]
    const playthroughField = Object.entries(playthroughMaps).find(([, kind]) => kind === document.kind)?.[0]
    const plannerField = Object.entries(plannerArrays).find(([, kind]) => kind === document.kind)?.[0]
    const fileField = Object.entries(fileArrays).find(([, kind]) => kind === document.kind)?.[0]
    if (rootField) { (local[rootField] ??= {} as object); (local[rootField] as Record<string, unknown>)[ids[1]] = take(document.kind, ids[1]) }
    else if (playthroughField || document.kind === 'quintar-breeding') {
      const playthrough = playthroughs[ids[1]]
      if (!playthrough) throw new Error('Foreign playthrough reference')
      if (playthroughField) (playthrough[playthroughField] as Record<string, unknown>)[ids[2]] = take(document.kind, ids[1], ids[2])
      else playthrough.quintarBreeding = take(document.kind, ids[1])
    } else if (plannerField || fileField) {
      const target = plannerField ? planner[plannerField] : state[fileField!]
      ;(target as unknown[]).push(take(document.kind, ...ids.slice(1)))
    } else if (document.kind === 'change') (local.changes as unknown[]).push(take('change', ids[1]))
    else if (document.kind === 'reference-preferences') local.referenceLibrary = take('reference-preferences')
    else if (document.kind === 'blob-reference') {
      const ref = take('blob-reference', ids[1]) as unknown as WorkspaceBlobRef
      if (blobIdentity(ref) !== ids[1]) throw new Error('Blob key mismatch')
      const key = privateRecordKey('blob', ids[1]), blob = byKey.get(key)
      if (!blob || !isBlobSource(blob.value)) throw new Error('Missing blob body')
      ;(state.blobs as unknown[]).push({ ref, content: blob.value }); byKey.delete(key)
    }
  }
  if (byKey.size) throw new Error('Unexpected or unconsumed workspace document')
  // Immutable entries merge by identity and time, never by generic concatenation or current fence
  ;(local.changes as { id: string; recordedAt: string; nextRevision: number }[]).sort((a, b) => a.nextRevision - b.nextRevision || a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))
  ;(planner.history as { id: string; recordedAt: string; nextRevision: number }[]).sort((a, b) => a.nextRevision - b.nextRevision || a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))
  if (!identity.localData.updatedAt) local.updatedAt = (local.changes as { recordedAt: string }[]).reduce((latest, entry) => entry.recordedAt > latest ? entry.recordedAt : latest, local.createdAt as string)
  if (journal) { planner.savedChanges = local.changes; planner.journal = journal; local.changes = journal.changes }
  for (const [id, value] of bookkeeping ?? []) { if (!playthroughs[id]) throw new Error('Foreign playthrough bookkeeping'); Object.assign(playthroughs[id], value) }
  const result = state as unknown as WorkspaceState
  // This array belongs to assembly; exact admitted catalog identities can share native graph lookups
  for (const catalog of result.planner.catalogs) immutableCatalogSnapshot(catalog)
  Object.freeze(result.planner.catalogs)
  validateWorkspace(result)
  return result
}
export function isBlobSource(value: JsonValue | BlobSource): value is BlobSource { return value !== null && typeof value === 'object' && 'open' in value && typeof value.open === 'function' }

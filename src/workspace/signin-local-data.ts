import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import { createSampleLocalData } from '../domain/sample-data'
import type { CatalogSnapshot, LocalData } from '../domain/types'
import { captureWorkspaceDocuments, privateRecordKey, type WorkspaceDocument, type WorkspaceDocumentKind, type WorkspaceRetainedContent, type WorkspaceState } from './documents'

export interface SigninLocalReason { readonly category: 'builds' | 'progress' | 'other'; readonly code: WorkspaceDocumentKind; readonly rootKey: string }
export interface SigninLocalSummary {
  readonly meaningful: boolean
  readonly builds: number
  readonly progress: number
  readonly other: number
  readonly rootKeys: readonly string[]
  readonly reasons: readonly SigninLocalReason[]
}
const STARTER_REFERENCE_TIMESTAMP = '2000-01-01T00:00:00.000Z'
const IDENTITY_CHILDREN = new Set(['snapshots', 'characters', 'progress', 'goals', 'scenarios', 'inventory', 'inventoryEvents', 'quintarBreeding', 'skillTreeCaptures'])
const PLAYTHROUGH_CHILDREN = new Set(['character', 'progress', 'goal', 'scenario', 'inventory', 'quintar-breeding', 'skill-capture'])
const GENERATED_ID = /^([A-Za-z]+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BOOKKEEPING = new Set(['revision', 'createdAt', 'updatedAt'])
const NO_OMITTED_FIELDS: ReadonlySet<string> = new Set()
const DEVICE_SELECTIONS = new Set(['selectedPlaythroughId', 'planningGameSetupRevisionId', 'activeScenarioId'])

function semantic(value: unknown, identity: (value: string) => string, constructorRecordings: WeakSet<object>, omittedFields = NO_OMITTED_FIELDS): unknown {
  if (typeof value === 'string') return identity(value)
  if (Array.isArray(value)) return value.map(child => semantic(child, identity, constructorRecordings))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !BOOKKEEPING.has(key) && !DEVICE_SELECTIONS.has(key) && !omittedFields.has(key) && !(key === 'recordedAt' && constructorRecordings.has(value))).map(([key, child]) => [identity(key), semantic(child, identity, constructorRecordings)]).sort(([left], [right]) => String(left).localeCompare(String(right))))
}
function starterConstructorRecordings(local: LocalData): WeakSet<object> {
  const recordings = new WeakSet<object>()
  // The sample constructor records Character snapshots at workspace creation and supplies no observedAt
  // Preserve explicit observations and any recording time that differs from that exact constructor value
  for (const playthrough of Object.values(local.playthroughs)) for (const character of Object.values(playthrough.characters)) for (const snapshot of Object.values(character.snapshots)) {
    if (snapshot.recordedAt === local.createdAt) recordings.add(snapshot)
  }
  return recordings
}

function encoded(value: unknown): string { return JSON.stringify(value) }

// Identity anchors omit independently owned children so adding Progress cannot rename its parent Playthrough
// Complete document comparisons below still retain every child and reference, never trusting a sample tag
// Preserve distinct references and fail closed on ambiguous twins instead of erasing their associations
function localIdentities(local: LocalData, constructorRecordings: WeakSet<object>): ReadonlyMap<string, string> | undefined {
  const identities = new Map<string, string>(), owners = new Map<string, string>()
  let ambiguous = false
  const add = (id: string, token: string) => {
    if (identities.has(id)) return
    if (owners.has(token) && owners.get(token) !== id) ambiguous = true
    identities.set(id, token); owners.set(token, id)
  }
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string' && GENERATED_ID.test(record.id)) {
      const prefix = GENERATED_ID.exec(record.id)![1]
      const shape = semantic(record, text => GENERATED_ID.exec(text)?.[1] ?? text, constructorRecordings, IDENTITY_CHILDREN)
      add(record.id, encoded([prefix, shape]))
      if (typeof record.gameSetupId === 'string' && GENERATED_ID.test(record.gameSetupId)) add(record.gameSetupId, encoded(['gameSetup', shape]))
    }
    for (const [key, child] of Object.entries(record)) if (key !== 'changes') visit(child)
  }
  // The workspace identity includes every descendant, so it cannot serve as a semantic starter anchor
  for (const field of ['gameSetups', 'builds', 'buildRevisions', 'teams', 'teamRevisions', 'playthroughs'] as const) visit(local[field])
  return ambiguous ? undefined : identities
}
function documents(state: WorkspaceState): readonly WorkspaceDocument[] {
  return captureWorkspaceDocuments(state, (kind, key, value) => ({ version: 1, kind, key, value: value as WorkspaceDocument['value'] }))
}
function comparable(document: WorkspaceDocument, ids: ReadonlyMap<string, string>, constructorRecordings: WeakSet<object>): string {
  const identity = (value: string) => ids.get(value) ?? value
  return encoded([JSON.parse(document.key).map(identity), semantic(document.value, identity, constructorRecordings)])
}
function starterDocuments(state: WorkspaceState): ReadonlySet<string> {
  const candidates = new Set<string>()
  // Use the retained exact pin: packaged names or source revisions can change between app versions
  const pins = Object.values(state.planner.localData.gameSetups).flatMap(setup => Object.entries(setup.catalogLock))
  for (const catalog of state.planner.catalogs.filter(value => pins.some(([id, revision]) => value.id === id && value.revisionId === revision))) {
    try {
      // Reference construction allocates temporary IDs only; normalized tokens never persist or become user identity
      const localData = createSampleLocalData(catalog, STARTER_REFERENCE_TIMESTAMP), recordings = starterConstructorRecordings(localData), ids = localIdentities(localData, recordings)
      if (!ids) continue
      const starter: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
      for (const document of documents(starter)) candidates.add(comparable(document, ids, recordings))
    } catch {
      // An incomplete retained source cannot prove that any personal record is an untouched starter
    }
  }
  return candidates
}

function selectionRoot(document: WorkspaceDocument, current: ReadonlyMap<string, WorkspaceDocument>): string {
  const { kind, key, value } = document
  const ids = JSON.parse(key) as string[]
  // The copy service accepts owning records and computes their dependency closure itself
  // Keep exact changed child keys in reasons while selecting the owner's existing public preview root
  if (PLAYTHROUGH_CHILDREN.has(kind)) return privateRecordKey('playthrough', ids[1])
  if (kind === 'build-checkpoint') return privateRecordKey('build', (value as unknown as { buildId: string }).buildId)
  if (kind === 'team-checkpoint') return privateRecordKey('team', (value as unknown as { teamId: string }).teamId)
  if (kind === 'retained-content') {
    const retained = value as unknown as WorkspaceRetainedContent
    const ownerKey = retained.kind === 'file-history' ? privateRecordKey(retained.fileKind, retained.documentId) : retained.unit.privateKey
    const owner = current.get(ownerKey)
    if (owner && owner.kind !== 'retained-content') return selectionRoot(owner, current)
  }
  // Missing owners and workspace preferences stay explicit so the consumer must preserve or block them
  return key
}

export function classifySigninLocalData(state: WorkspaceState): SigninLocalSummary {
  const local = state.planner.localData, recordings = starterConstructorRecordings(local), ids = localIdentities(local, recordings), starters = starterDocuments(state)
  const reasons: SigninLocalReason[] = [], buildIds = new Set<string>()
  const current = new Map(documents(state).map(document => [document.key, document]))
  let progress = 0, other = 0
  for (const document of current.values()) {
    const { kind, key, value } = document
    if (kind === 'workspace-identity' || kind === 'change' || kind === 'blob' || kind === 'blob-reference') continue
    if (kind === 'catalog') {
      const candidate = value as unknown as CatalogSnapshot
      if (BUNDLED_CATALOGS.some(catalog => catalog.id === candidate.id && catalog.revisionId === candidate.revisionId && catalog.checksum === candidate.checksum)) continue
      if (Object.values(local.gameSetups).some(setup => setup.catalogLock[candidate.id] === candidate.revisionId)) continue
    }
    if (kind === 'library-defaults' && state.libraryDefaults.layers.length === 0) continue
    if (kind === 'reference-preferences' && encoded(local.referenceLibrary) === encoded({ version: 1, excludedMods: BUNDLED_MOD_LIBRARY.map(mod => mod.id) })) continue
    if (kind === 'workspace-preferences' && (!local.modSetup || local.modSetup.state === (BUNDLED_MOD_LIBRARY.length ? 'pending' : 'skipped')) && !local.unavailableDefinitions?.length && !Object.keys(local.skillTreeLayouts ?? {}).length) continue
    if (ids && starters.has(comparable(document, ids, recordings))) continue
    const category = kind === 'build' || kind === 'build-checkpoint' ? 'builds' : kind === 'progress' ? 'progress' : 'other'
    if (category === 'builds') buildIds.add(kind === 'build' ? JSON.parse(key)[1] as string : (value as unknown as { buildId: string }).buildId)
    else if (category === 'progress') progress++
    else other++
    // Reason text is an allowlisted kind, never an imported title, note, description, or filename
    reasons.push({ category, code: kind, rootKey: key })
  }
  return { meaningful: reasons.length > 0, builds: buildIds.size, progress, other, rootKeys: [...new Set(reasons.map(reason => selectionRoot(current.get(reason.rootKey)!, current)))], reasons }
}

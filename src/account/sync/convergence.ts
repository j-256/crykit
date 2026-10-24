import type { ProfileToken } from '../profile'
import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import { cipherRef } from '../../workspace/account-cache'
import { prepareAccountWorkspace, type OpenAccountWorkspace, type AccountWorkspaceEntry } from '../../workspace/account-graph'
import { mappedChanges, type MappedWorkspaceChange } from '../../workspace/account-intents'
import { assembleWorkspace, splitWorkspace, type WorkspaceDocument } from '../../workspace/documents'
import { publicationDocuments } from '../../workspace/closure'
import { mergeDocument } from '../../workspace/merge'
import { createWorkspaceConflict } from '../../workspace/conflicts'
import type { ConflictAuthority } from '../../workspace/conflict-authority'
import { blobIdentity } from '../../workspace/blobs'
import { stagePublicationRecord } from './publication'
import { readOriginalPublication } from './conflict-authority'
import type { RemoteProjection } from './projection'
import { SyncError } from './client'
import { projectionBookkeeping } from './projection-bookkeeping'
import { nowTimestamp } from '../../interchange/util'
import type { CapturedWorkspaceRecord } from '../../workspace/account-evidence'

export interface ConvergenceResult {
  readonly initialTombstones?: ReadonlyMap<string, CipherRef>
  readonly target: OpenAccountWorkspace
  readonly changes: readonly MappedWorkspaceChange[]
  readonly authorities: ReadonlyMap<string, ConflictAuthority>
  readonly archivedBindings: readonly { body: CipherRef; publication: CipherRef }[]
}
export async function prepareConvergence(database: AccountDatabase, token: ProfileToken, base: OpenAccountWorkspace, target: OpenAccountWorkspace, remote: RemoteProjection, changes: readonly MappedWorkspaceChange[], parents: ReadonlyMap<string, CipherRef>, anchorParents: ReadonlyMap<string, CipherRef> = new Map(), anchorCandidates: ReadonlyMap<string, CipherRef> = new Map(), mappingBase?: RemoteProjection, resolvedMappings: ReadonlySet<string> = new Set(), mappingCandidates: ReadonlyMap<string, CipherRef> = new Map()): Promise<ConvergenceResult> {
  const lineage = await (await import('./lineage-convergence')).comparePersonalLineages(database, token, base, target, remote, anchorParents, parents, anchorCandidates)
  const eligible = new Set((await publicationDocuments(target.state)).map(document => document.key))
  const originals = new Map(base.entries.map(entry => [entry.key, entry])), local = new Map(target.entries.map(entry => [entry.key, entry]))
  const selected = new Map(remote.workspace.entries.map(entry => [entry.key, entry]))
  const collisions = new Set<string>(), foreignAllocations = new Set<string>()
  const changed = changes.filter(change => change.kind !== 'workspace-identity' && (eligible.has(change.key) || change.kind === 'tombstone'))
  for (const change of changed) {
    if (lineage.blocked.has(change.key)) continue
    const other = remote.units.get(change.key)?.body, mine = local.get(change.key)!
    if (!mine) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    if (resolvedMappings.has(change.key)) { selected.set(change.key, mine); continue }
    // Identical immutable payload bytes may be encrypted under independent local allocations
    if (['blob', 'blob-reference'].includes(change.kind) && other?.digest === mine.digest) continue
    if (other && other.ref.documentId !== mine.ref.documentId) { foreignAllocations.add(change.key); collisions.add(change.key); continue }
    if (!other || other.ref.revisionId === change.before?.revisionId) { selected.set(change.key, mine); continue }
    if (other.digest === mine.digest) continue
    const ancestor = originals.get(change.key)
    if (!ancestor) { collisions.add(change.key); continue }
    const mineDocument = (await target.readCaptured(mine.ref)).document
    const decision = mergeDocument((await base.readCaptured(ancestor.ref)).document, mineDocument, (await remote.workspace.readCaptured(other.ref)).document)
    if (decision.kind === 'conflict') collisions.add(change.key)
    else if (decision.document === mineDocument) selected.set(change.key, mine)
  }
  // A Build's head and checkpoint set are one choice; a new checkpoint ID cannot bypass a head conflict
  const blocked = new Set([...collisions, ...lineage.blocked])
  for (const change of changed) if (change.kind === 'build-checkpoint') {
    const value = (await target.readCaptured(local.get(change.key)!.ref)).document.value as unknown as { buildId: string }
    const owner = JSON.stringify(['build', value.buildId])
    if (collisions.has(owner)) { blocked.add(change.key); collisions.delete(change.key) }
  }
  const authorities = new Map<string, ConflictAuthority>(lineage.authorities), archivedBindings: { body: CipherRef; publication: CipherRef }[] = []
  let retained = lineage.retained
  for (const key of collisions) {
    if (foreignAllocations.has(key)) {
      const result = await (await import('./mapping-convergence')).createMappingConflict(database, token, mappingBase, target, remote, local.get(key)!, retained, mappingCandidates.get(local.get(key)!.ref.revisionId))
      retained = result.state; authorities.set(JSON.stringify(['conflict', result.conflict.id]), result.authority); archivedBindings.push(result.binding)
      continue
    }
    const mine = local.get(key)!, other = remote.units.get(key), ancestor = originals.get(key)
    if (!other || !ancestor || !parents.has(ancestor.ref.revisionId)) throw new SyncError('HEAD_CONFLICT')
    const originalParent = parents.get(ancestor.ref.revisionId)!
    const localEnvelope = cipherRef(await stagePublicationRecord(database, token, mine, remote.lineageId, originalParent))
    const authority: ConflictAuthority = { version: 1, unit: { kind: 'record', privateKey: key }, lineageId: remote.lineageId, commonAncestor: { kind: 'present', publication: await readOriginalPublication(database, token, originalParent) }, branches: [{ role: 'local-pending', publication: await readOriginalPublication(database, token, localEnvelope) }, { role: 'accepted-cloud', publication: await readOriginalPublication(database, token, other.ref) }] }
    const captured = await createWorkspaceConflict({ base, local: target, remote: { ...remote.workspace, state: retained }, privateKey: key, authority })
    retained = { ...retained, conflicts: [...retained.conflicts, captured.conflict], blobs: captured.blobs }
    authorities.set(JSON.stringify(['conflict', captured.conflict.id]), authority)
    archivedBindings.push({ body: mine.ref, publication: localEnvelope })
  }
  for (const key of blocked) {
    const accepted = remote.units.get(key)?.body
    if (accepted) selected.set(key, accepted); else selected.delete(key)
  }
  const documents = new Map(splitWorkspace(retained).map(document => [document.key, document]))
  const readCaptured: OpenAccountWorkspace['readCaptured'] = ref => {
    const exactRemote = remote.workspace.entries.some(entry => blobIdentity(entry.ref) === blobIdentity(ref))
    return (exactRemote ? remote.workspace : target).readCaptured(ref)
  }
  const scenarios: CapturedWorkspaceRecord[] = []
  for (const [key, entry] of selected) {
    if (entry.kind === 'tombstone') documents.delete(key)
    else {
      const original = await readCaptured(entry.ref)
      documents.set(key, original.document)
      // A raw historical reader cannot recover the selected envelope's source association
      if (entry.kind === 'scenario') scenarios.push({ ...original, sourceBookkeeping: entry.sourceBookkeeping })
    }
  }
  const bookkeeping = await projectionBookkeeping(scenarios, readCaptured, nowTimestamp())
  const state = assembleWorkspace([...documents.values()] as WorkspaceDocument[], target.state.planner.localData.revision, { version: 1, changes: [], checkpoints: [], undoable: false }, bookkeeping)
  const allocations = new Map([...remote.workspace.allocations, ...target.allocations].map(value => [value.key, value]))
  for (const [key, entry] of selected) allocations.set(key, { key, documentId: entry.ref.documentId })
  const prior: OpenAccountWorkspace = { ...remote.workspace, state, entries: [...selected.values()] as AccountWorkspaceEntry[], allocations: [...allocations.values()], payloads: new Map(await Promise.all([...selected.values()].map(async entry => [entry.key, (await readCaptured(entry.ref)).source] as const))), readCaptured }
  const prepared = await prepareAccountWorkspace(database, token, state, prior)
  await database.encryptedRevisions.bulkAdd(prepared.records)
  return { target: prepared.opened, changes: mappedChanges(remote.workspace, prepared.opened), authorities, archivedBindings }
}

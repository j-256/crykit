import { hashBlob } from './blobs'
import { workspaceDocumentSource } from './document-codec'
import { reconstructCopiedMapping } from './copied-mapping'
import { inspectWorkspaceClosure } from './closure'
import { splitWorkspace } from './documents'
import { resolvedDomainClosureKeys } from './domain-closure'
import { assertOwnedWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'
import { capturedBackupEvidence, historicalMetadataIdentity } from '../interchange/workspace-backup-evidence'
import { assertAccountInheritedEvidenceOwner, openAccountInheritedEvidence } from './account-evidence-snapshots'
import { applicableCopiedComparisons, copiedBranchState } from './copied-branch'
import { prepareAccountWorkspaceWithEvidence } from './account-graph'
import type { PreparedAccountInheritedEvidence } from './account-evidence-snapshots'
import { personalLineageChains } from '../account/sync/lineage'
import { stagePersonalLineage } from '../account/sync/lineage-publication'
import type { AccountPreparationOwner } from './account-prepared-records'
import { z } from 'zod'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { OpaqueIdSchema } from '../account/protocol'
import type { AccountDatabase, CipherRecord, CipherRef } from '../persistence/account-database'
import { accountLocalId, cipherRef, CipherRefSchema, openAccountJson, stageAccountJson } from './account-cache'
import { buildIndexPages, INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES } from './directory'
import { sameCipherRefs } from './account-retaining'
import { prepareAccountWorkspace, openAccountWorkspace, type OpenAccountWorkspace } from './account-graph'
import { mappedChanges, type MappedWorkspaceIntent } from './account-intents'
import { createWorkspaceConflict } from './conflicts'
import type { ConflictAuthority } from './conflict-authority'
import { stagePublicationRecord } from '../account/sync/publication'
import { readOriginalPublication } from '../account/sync/conflict-authority'
import type { RemoteProjection } from '../account/sync/projection'
import type { ConvergenceResult } from '../account/sync/convergence'
import { SyncError } from '../account/sync/client'

const RegistrationSchema = z.strictObject({ id: OpaqueIdSchema, privateKey: z.string().min(1), source: CipherRefSchema, destination: CipherRefSchema, sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), mode: z.enum(['additive', 'replace']), original: z.strictObject({ conflictId: z.string(), source: CipherRefSchema, accepted: CipherRefSchema, collisionId: OpaqueIdSchema }).optional(), phase: z.literal('awaiting-destination-publication') })
const PageSchema = z.strictObject({ version: z.literal(1), kind: z.literal('copied-conflict-page'), operationId: OpaqueIdSchema, entries: z.array(RegistrationSchema), children: z.array(CipherRefSchema) }).refine(page => page.entries.length + page.children.length <= INDEX_PAGE_ENTRIES)
export type CopiedConflictRegistration = z.infer<typeof RegistrationSchema>

// A registration refers only to destination-encrypted graphs. Source publication IDs remain inert
// inside inherited evidence and never authorize destination envelope parents
export async function prepareCopiedConflicts(database: AccountDatabase, token: ProfileToken, input: { operationId: string; source: OpenAccountWorkspace; destination: OpenAccountWorkspace; keys: readonly string[]; owner?: AccountPreparationOwner; evidence: PreparedAccountInheritedEvidence; snapshot: WorkspaceSnapshot; mode: 'additive' | 'replace' }): Promise<{ root: CipherRef; records: readonly CipherRecord[] }> {
  assertActiveProfile(token)
  await assertOwnedWorkspaceSnapshot(input.snapshot)
  await assertAccountInheritedEvidenceOwner(input.evidence.handle, database, token)
  if (input.source.state !== input.snapshot.state) throw new Error('Copied source is not the owned selected snapshot')
  const identity = await historicalMetadataIdentity(capturedBackupEvidence(input.snapshot).current)
  if (!input.evidence.handle.members.some(member => member.id === identity.id)) throw new Error('Copied originals are not retained by the selected evidence root')
  const binding = { sourceIdentity: identity.id, sourceDigest: identity.metadataStreamDigest, mode: input.mode }
  const entries = input.keys.filter(key => !input.source.state.conflicts.some(conflict => conflict.unit.privateKey === key)).map(privateKey => {
    const source = input.source.entries.find(entry => entry.key === privateKey), expected = input.destination.entries.find(entry => entry.key === privateKey)
    const lineage = personalLineageChains(input.source.state.planner.localData).has(privateKey) && personalLineageChains(input.destination.state.planner.localData).has(privateKey)
    if (!lineage && (!source || !expected)) throw new Error('A copied comparison requires both exact captured records')
    return RegistrationSchema.parse({ ...binding, id: accountLocalId(), privateKey, source: input.source.head, destination: input.destination.head, phase: 'awaiting-destination-publication' })
  })
  const records: CipherRecord[] = []
  for (const conflict of await applicableCopiedComparisons(input.source.state)) {
    const acceptedState = await copiedBranchState(input.source.state, conflict.branches[1].closure, input.source.state)
    const pendingState = await copiedBranchState(input.source.state, conflict.branches[0].closure, input.source.state)
    // A deleted accepted original needs its real native tombstone, produced from the opposite
    // exact branch. Its local predecessor supplies no destination publication authority
    const acceptedDeleted = (await inspectWorkspaceClosure(input.source.state, conflict.branches[1].closure)).root.kind === 'tombstone'
    const seed = acceptedDeleted ? await prepareAccountWorkspaceWithEvidence(database, token, pendingState, input.evidence, undefined, input.source.allocations) : undefined
    if (seed) records.push(...seed.records)
    const accepted = await prepareAccountWorkspaceWithEvidence(database, token, acceptedState, input.evidence, seed?.opened, seed?.opened.allocations ?? input.source.allocations)
    const pending = await prepareAccountWorkspaceWithEvidence(database, token, pendingState, input.evidence, accepted.opened, accepted.opened.allocations)
    records.push(...accepted.records, ...pending.records)
    entries.push(RegistrationSchema.parse({ ...binding, id: accountLocalId(), privateKey: conflict.unit.privateKey, source: pending.head, destination: input.destination.head, original: { conflictId: conflict.id, source: input.source.head, accepted: accepted.head, collisionId: accountLocalId() }, phase: 'awaiting-destination-publication' }))
  }
  const pages = await stageCopiedConflictRegistrations(database, token, input.operationId, entries, input.owner)
  return { root: pages.root, records: [...new Map([...records, ...pages.records].map(record => [record.revisionId, record])).values()] }
}
export async function stageCopiedConflictRegistrations(database: AccountDatabase, token: ProfileToken, operationId: string, entries: readonly CopiedConflictRegistration[], owner?: AccountPreparationOwner): Promise<{ root: CipherRef; records: readonly CipherRecord[] }> {
  const records: CipherRecord[] = []
  const root = await buildIndexPages(entries, async page => {
    const value = PageSchema.parse({ ...page, kind: 'copied-conflict-page', operationId })
    const refs = [...new Map([...page.children, ...page.entries.flatMap(entry => [entry.source, entry.destination, ...(entry.original ? [entry.original.source, entry.original.accepted] : [])])].map(ref => [JSON.stringify(ref), ref])).values()]
    const record = await stageAccountJson(database, token, value, refs, undefined, owner)
    records.push(record); return cipherRef(record)
  }, page => new TextEncoder().encode(JSON.stringify({ ...page, kind: 'copied-conflict-page', operationId })).length)
  return { root, records }
}

// Scope authentication reuse to one operation and its captured database/profile. Complete references
// bind every lookup; every use still checks the profile and every registration keeps its own checks
export function createCopiedConflictReader(database: AccountDatabase, token: ProfileToken) {
  const workspaces = new Map<string, Promise<OpenAccountWorkspace>>()
  const workspace = async (ref: CipherRef): Promise<OpenAccountWorkspace> => {
    assertActiveProfile(token)
    const key = JSON.stringify(ref)
    let opened = workspaces.get(key)
    if (!opened) { opened = openAccountWorkspace(database, token, ref); workspaces.set(key, opened) }
    const result = await opened
    assertActiveProfile(token)
    return result
  }
  return { workspace, registrations: (intent: MappedWorkspaceIntent) => readRegistrations(database, token, intent, workspace) }
}
export async function readCopiedConflicts(database: AccountDatabase, token: ProfileToken, intent: MappedWorkspaceIntent): Promise<readonly CopiedConflictRegistration[]> {
  return createCopiedConflictReader(database, token).registrations(intent)
}
async function readRegistrations(database: AccountDatabase, token: ProfileToken, intent: MappedWorkspaceIntent, workspace: (ref: CipherRef) => Promise<OpenAccountWorkspace>): Promise<readonly CopiedConflictRegistration[]> {
  if (!intent.copiedConflicts) return []
  const pages = new Set<string>(), ids = new Set<string>(), keys = new Set<string>(), result: CopiedConflictRegistration[] = []
  const visit = async (ref: CipherRef): Promise<void> => {
    if (pages.has(ref.revisionId)) throw new Error('Repeated copied conflict page')
    pages.add(ref.revisionId)
    const page = await openAccountJson(database, token, ref, PageSchema)
    const record = await database.encryptedRevisions.get(ref.revisionId)
    const refs = [...new Map([...page.children, ...page.entries.flatMap(entry => [entry.source, entry.destination, ...(entry.original ? [entry.original.source, entry.original.accepted] : [])])].map(ref => [JSON.stringify(ref), ref])).values()]
    if (page.operationId !== intent.operationId || !record || !sameCipherRefs(record.descriptor.dependencies, refs) || new TextEncoder().encode(JSON.stringify(page)).length > INDEX_PAGE_BYTES) throw new Error('Copied conflict page association mismatch')
    for (const entry of page.entries) {
      if (entry.mode !== intent.mode) throw new Error('Copied comparison mode differs from its operation')
      if (ids.has(entry.id) || keys.has(JSON.stringify([entry.privateKey, entry.original?.conflictId ?? null]))) throw new Error('Duplicate copied comparison identity')
      const source = await workspace(entry.original?.source ?? entry.source)
      if (!source.inheritedEvidence) throw new Error('Copied source originals are missing')
      const evidence = await openAccountInheritedEvidence(database, token, source.inheritedEvidence)
      try {
        const { accountInheritedSources } = await import('./account-evidence-snapshots')
        const members = await accountInheritedSources(evidence)
        const member = members.members.find(value => value.id === entry.sourceIdentity)
        if (!member || (await historicalMetadataIdentity(member.metadata)).metadataStreamDigest !== entry.sourceDigest) throw new Error('Copied source metadata identity mismatch')
        if (entry.original) {
          const original = source.state.conflicts.find(value => value.id === entry.original!.conflictId && value.unit.privateKey === entry.privateKey)
          if (!original) throw new Error('Copied original conflict association mismatch')
          for (const [index, ref] of [entry.source, entry.original.accepted].entries()) {
            const expected = await copiedBranchState(source.state, original.branches[index].closure, source.state)
            const projected = await workspace(ref)
            const actual = projected.entries.find(value => value.key === entry.privateKey)
            if (!actual || actual.kind === 'tombstone') {
              const originalUnit = await inspectWorkspaceClosure(source.state, original.branches[index].closure)
              if (originalUnit.root.kind === 'tombstone') {
                const tombstone = originalUnit.documents.get(entry.privateKey)
                if (!tombstone || actual?.kind !== 'tombstone' || actual.digest !== await hashBlob(workspaceDocumentSource(tombstone))) throw new Error('Copied deletion differs from its original')
              }
            }
            const native = (kind: string) => !['workspace-identity', 'workspace-preferences', 'blob', 'blob-reference', 'tombstone'].includes(kind)
            const documents = splitWorkspace(expected).filter(document => native(document.kind))
            if (projected.entries.filter(value => native(value.kind)).length !== documents.length) throw new Error('Copied branch projection differs from its original')
            for (const document of documents) if (projected.entries.find(value => value.key === document.key)?.digest !== await hashBlob(workspaceDocumentSource(document))) throw new Error('Copied branch projection differs from its original')
          }
        }
      } finally { await evidence.dispose() }
      ids.add(entry.id); keys.add(JSON.stringify([entry.privateKey, entry.original?.conflictId ?? null])); result.push(entry)
    }
    for (const child of page.children) await visit(child)
  }
  await visit(intent.copiedConflicts); assertActiveProfile(token); return result
}

export async function prepareCopiedConflictPublication(database: AccountDatabase, token: ProfileToken, intent: MappedWorkspaceIntent, target: OpenAccountWorkspace, remote: RemoteProjection, existing?: ConvergenceResult): Promise<ConvergenceResult> {
  const reader = createCopiedConflictReader(database, token)
  const entries = await reader.registrations(intent)
  const authorities = new Map<string, ConflictAuthority>(existing?.authorities)
  const archivedBindings = [...(existing?.archivedBindings ?? [])]
  let retained = target.state
  let publicationBase = target
  const initialTombstones = new Map(existing?.initialTombstones)
  for (const entry of entries) {
    const destination = await reader.workspace(entry.destination)
    let source = await reader.workspace(entry.source)
    const anchor = remote.lineages.get(entry.privateKey)
    const accepted = anchor ?? remote.units.get(entry.privateKey)
    if (!accepted) {
      if (entry.original) {
        const imported = await reader.workspace(entry.original.accepted)
        const deleted = imported.entries.find(value => value.key === entry.privateKey)
        if (deleted?.kind === 'tombstone') {
          if (remote.workspace.allocations.some(value => value.key === entry.privateKey) || [...remote.directories.values()].some(value => value.allocations.some(allocation => allocation.key === entry.privateKey))) throw new SyncError('STALE_CONFLICT_CHOICE')
          // Retain the exact newly allocated native deletion in a real prepared root. The ordinary
          // publication path establishes parentless destination A before any comparison uses it
          const previous = publicationBase
          publicationBase = { ...previous, entries: [...previous.entries.filter(value => value.key !== entry.privateKey), deleted], allocations: [...previous.allocations.filter(value => value.key !== entry.privateKey), { key: entry.privateKey, documentId: deleted.ref.documentId }], payloads: new Map([...previous.payloads, [entry.privateKey, imported.payloads.get(entry.privateKey)!]]), readCaptured: ref => JSON.stringify(ref) === JSON.stringify(deleted.ref) ? imported.readCaptured(ref) : previous.readCaptured(ref) }
          initialTombstones.set(entry.privateKey, deleted.ref)
        }
        continue
      }
      throw new SyncError('STALE_CONFLICT_CHOICE')
    }
    let conflictId = entry.id, mapping = false
    if (entry.original) {
      const imported = await reader.workspace(entry.original.accepted)
      const compatible = compatibleCopiedBase(imported, remote.workspace, entry.privateKey)
      // Explicit replacement publishes its authorized target before its comparisons can use that base
      if (!compatible && entry.mode === 'replace') continue
      if (!compatible) { source = imported; conflictId = entry.original.collisionId }
      else {
        const originals = await reader.workspace(entry.original.source)
        mapping = originals.state.conflicts.find(value => value.id === entry.original!.conflictId)!.unit.kind === 'directory-mapping'
      }
      if (retained.conflicts.some(value => value.id === conflictId)) continue
    } else if (anchor) {
      const chain = personalLineageChains(destination.state.planner.localData).get(entry.privateKey)
      const expected = chain?.map(definition => destination.entries.find(value => value.key === JSON.stringify(['personal-definition', definition.id]))!.ref)
      if (JSON.stringify(expected) !== JSON.stringify(anchor.entries.map(value => value.ref))) throw new SyncError('STALE_CONFLICT_CHOICE')
    } else if (!entry.original) {
      const expected = destination.entries.find(value => value.key === entry.privateKey)
      if (!expected || JSON.stringify(remote.units.get(entry.privateKey)!.body.ref) !== JSON.stringify(expected.ref)) throw new SyncError('STALE_CONFLICT_CHOICE')
    }
    // Preserve domain identities while rebuilding encryption/transport identities in the destination scope
    const allocations = [...new Map([...source.allocations, ...remote.workspace.allocations.filter(value => !mapping || value.key !== entry.privateKey)].map(value => [value.key, value])).values()]
    // Only a deletion needs an existing native unit to produce its tombstone. Passing the full
    // remote graph for an ordinary alternative would manufacture unrelated deletion records
    const deleted = source.entries.find(value => value.key === entry.privateKey)?.kind === 'tombstone'
    const predecessor = deleted ? { ...remote.workspace, entries: remote.workspace.entries.filter(value => value.key === entry.privateKey) } : undefined
    const pending = await prepareAccountWorkspace(database, token, source.state, predecessor, allocations)
    await database.transaction('rw', database.encryptedRevisions, async () => { assertActiveProfile(token); await database.encryptedRevisions.bulkAdd(pending.records); assertActiveProfile(token) })
    if (mapping) {
      const reconstructed = await reconstructCopiedMapping(database, token, { id: conflictId, key: entry.privateKey, pending: pending.opened, remote, retained })
      retained = reconstructed.state
      authorities.set(JSON.stringify(['conflict', conflictId]), reconstructed.authority)
      archivedBindings.push(reconstructed.binding)
      continue
    }
    const mine = anchor
      ? pending.entries.find(value => value.key === JSON.stringify(['personal-definition', personalLineageChains(source.state.planner.localData).get(entry.privateKey)?.at(-1)?.id]))
      : pending.entries.find(value => value.key === entry.privateKey)
    if (!mine) throw new Error('Copied branch is missing its exact native unit')
    const envelope = anchor
      ? (await stagePersonalLineage(database, token, pending.opened, entry.privateKey, remote.lineageId, accepted.ref)).ref
      : cipherRef(await stagePublicationRecord(database, token, mine, remote.lineageId, accepted.ref))
    const ancestor = await readOriginalPublication(database, token, accepted.ref)
    const authority: ConflictAuthority = { version: 1, unit: { kind: 'record', privateKey: entry.privateKey }, lineageId: remote.lineageId, commonAncestor: { kind: 'present', publication: ancestor }, branches: [{ role: 'local-pending', publication: await readOriginalPublication(database, token, envelope) }, { role: 'accepted-cloud', publication: ancestor }] }
    const captured = await createWorkspaceConflict({ base: remote.workspace, local: pending.opened, remote: { ...remote.workspace, state: retained }, privateKey: entry.privateKey, authority })
    const conflict = { ...captured.conflict, id: conflictId }
    retained = { ...retained, conflicts: [...retained.conflicts, conflict], blobs: captured.blobs }
    authorities.set(JSON.stringify(['conflict', conflictId]), authority)
    archivedBindings.push({ body: mine.ref, publication: envelope })
  }
  const prepared = await prepareAccountWorkspace(database, token, retained, publicationBase)
  await database.transaction('rw', database.encryptedRevisions, async () => { assertActiveProfile(token); await database.encryptedRevisions.bulkAdd(prepared.records); assertActiveProfile(token) })
  return { target: prepared.opened, changes: mappedChanges(remote.workspace, prepared.opened), authorities, archivedBindings, ...(initialTombstones.size ? { initialTombstones } : {}) }
}

// Root equality alone cannot establish a compatible immutable dependency or personal-definition chain
// Check each exact native dependency; transport ancestry still comes only from the current destination
function compatibleCopiedBase(imported: OpenAccountWorkspace, destination: OpenAccountWorkspace, key: string): boolean {
  const lineage = personalLineageChains(imported.state.planner.localData).get(key)
  const other = personalLineageChains(destination.state.planner.localData).get(key)
  if (lineage && JSON.stringify(lineage) !== JSON.stringify(other)) return false
  const roots = lineage ? lineage.map(definition => JSON.stringify(['personal-definition', definition.id])) : [key]
  const documents = new Map(splitWorkspace(imported.state).map(document => [document.key, document]))
  const visited = new Set<string>()
  const visit = (privateKey: string): boolean => {
    if (visited.has(privateKey)) return true
    visited.add(privateKey)
    const expected = imported.entries.find(value => value.key === privateKey), actual = destination.entries.find(value => value.key === privateKey)
    if (!expected || !actual || expected.kind !== actual.kind || expected.digest !== actual.digest) return false
    const document = documents.get(privateKey)
    return !document || resolvedDomainClosureKeys(document, documents).every(visit)
  }
  return roots.every(visit)
}

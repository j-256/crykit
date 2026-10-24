import { conflictAuthorityRefs, type ConflictAuthority } from '../../workspace/conflict-authority'
import { validateConflictAuthority } from './conflict-authority'
import { isPersonalLineageKey, readPersonalLineage, type PersonalLineagePublication } from './lineage-publication'
import { personalLineageKey } from './lineage'
import { definitionLineageRootRef } from '../../domain/definitions'
import { createBlankLocalData } from '../../domain/local-data'
import type { PersonalDefinition } from '../../domain/types'
import { z } from 'zod'
import { sourceBookkeepingRefs, type SourceBookkeeping } from '../../workspace/source-bookkeeping'
import { nowTimestamp } from '../../interchange/util'
import { assertActiveProfile, withAccountKey, type ProfileToken } from '../profile'
import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import { openAccountJson } from '../../workspace/account-cache'
import { capturedRecordReader, validateCapturedWorkspaceRecords, type CapturedWorkspaceRecord } from '../../workspace/account-evidence'
import { AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema, type AccountWorkspaceEntry, type OpenAccountWorkspace } from '../../workspace/account-graph'
import { sameCipherRefs } from '../../workspace/account-retaining'
import { assembleWorkspace, type WorkspaceDocument, type BlobSource } from '../../workspace/documents'
import { validatedWorkspaceRetentionEdges } from '../../workspace/closure'
import { blobIdentity } from '../../workspace/blobs'
import { DIRECTORY_SHARDS, INDEX_PAGE_BYTES, directoryDocumentId, directoryShard, workspaceControlDocumentId } from '../../workspace/directory'
import { BaselinePageSchema, DirectoryPageSchema, DirectorySchema, PublicationControlSchema, PublicationRecordSchema, RecoveryPageSchema, type PublicationBaselineEntry } from './publication'
import { SyncError } from './client'
import { createProjectionReader } from './projection-reader'
import { projectionBookkeeping } from './projection-bookkeeping'

export interface RemoteUnit { readonly key: string; readonly ref: CipherRef; readonly physical: string | null; readonly body: AccountWorkspaceEntry; readonly conflictAuthority?: ConflictAuthority }
export interface RemoteDirectory { readonly shard: number; readonly ref: CipherRef; readonly physical: string | null; readonly allocations: readonly { key: string; documentId: string }[] }
export interface RemoteProjection {
  readonly control: CipherRef
  readonly inheritedEvidence?: CipherRef
  readonly lineageId: string
  readonly baseline: readonly PublicationBaselineEntry[]
  readonly units: ReadonlyMap<string, RemoteUnit>
  readonly directories: ReadonlyMap<number, RemoteDirectory>
  readonly lineages: ReadonlyMap<string, PersonalLineagePublication>
  readonly supersededConflictIds: ReadonlySet<string>
  readonly workspace: OpenAccountWorkspace
}
async function descriptor(database: AccountDatabase, token: ProfileToken, ref: CipherRef) {
  assertActiveProfile(token)
  const record = await database.encryptedRevisions.get(ref.revisionId)
  if (!record || record.descriptor.accountId !== token.accountId || record.descriptor.documentId !== ref.documentId || record.descriptor.revisionId !== ref.revisionId) throw new SyncError('INTEGRITY_FAILED')
  return record.descriptor
}
async function dependencies(database: AccountDatabase, token: ProfileToken, ref: CipherRef, expected: readonly CipherRef[]) {
  if (!sameCipherRefs((await descriptor(database, token, ref)).dependencies, [...new Map(expected.map(ref => [JSON.stringify(ref), ref])).values()])) throw new SyncError('INTEGRITY_FAILED')
}
export async function readPublicationPages<T>(database: AccountDatabase, token: ProfileToken, root: CipherRef, schema: z.ZodType<{ entries: T[]; children: CipherRef[] }>, retained: (entry: T) => readonly CipherRef[]): Promise<T[]> {
  const seen = new Set<string>(), values: T[] = [], queue = [root]
  while (queue.length) {
    const ref = queue.shift()!, key = blobIdentity(ref)
    if (seen.has(key)) throw new SyncError('INTEGRITY_FAILED')
    seen.add(key)
    const page = await openAccountJson(database, token, ref, schema)
    if (new TextEncoder().encode(JSON.stringify(page)).length > INDEX_PAGE_BYTES) throw new SyncError('INTEGRITY_FAILED')
    await dependencies(database, token, ref, [...page.children, ...page.entries.flatMap(retained)])
    values.push(...page.entries); queue.push(...page.children)
  }
  return values
}
async function descended(database: AccountDatabase, token: ProfileToken, head: CipherRef, seed: CipherRef): Promise<void> {
  if (head.documentId !== seed.documentId) throw new SyncError('INTEGRITY_FAILED')
  const completed = new Set<string>(), visiting = new Set<string>()
  let found = false
  const visit = async (ref: CipherRef): Promise<void> => {
    if (visiting.has(ref.revisionId)) throw new SyncError('INTEGRITY_FAILED')
    if (completed.has(ref.revisionId)) return
    visiting.add(ref.revisionId)
    if (ref.revisionId === seed.revisionId) found = true
    else {
      const value = await descriptor(database, token, ref)
      // Parent descriptors authenticate ancestry even after an unretained autosave body has expired
      for (const revisionId of value.parents) await visit({ documentId: head.documentId, revisionId })
    }
    visiting.delete(ref.revisionId); completed.add(ref.revisionId)
  }
  await visit(head)
  if (!found) throw new SyncError('INTEGRITY_FAILED')
}
export async function openRemoteProjection(database: AccountDatabase, token: ProfileToken, heads: ReadonlyMap<string, string>, localHead: CipherRef, localRevision: number, verified?: import('../../workspace/account-evidence-snapshots').AccountInheritedEvidence): Promise<RemoteProjection | null> {
  const controlId = await withAccountKey(token, key => workspaceControlDocumentId(key, token.accountId))
  const revisionId = heads.get(controlId)
  if (!revisionId) { if (heads.size) throw new SyncError('INTEGRITY_FAILED'); return null }
  const control = { documentId: controlId, revisionId }
  const root = await openAccountJson(database, token, control, PublicationControlSchema)
  await dependencies(database, token, control, [root.baseline, ...(root.recovery ? [root.recovery] : []), ...(root.version === 2 ? [root.inheritedEvidence] : [])])
  if (root.version === 2) {
    const { openAccountInheritedEvidence, assertAccountInheritedEvidenceOwner } = await import('../../workspace/account-evidence-snapshots')
    // Only the exact archive admitted by this live sync capture can be borrowed
    // All publication control, membership and causal checks below remain independent
    const borrowed = verified && JSON.stringify(verified.root) === JSON.stringify(root.inheritedEvidence) ? verified : undefined
    const inherited = borrowed ?? await openAccountInheritedEvidence(database, token, root.inheritedEvidence)
    try { if (borrowed) await assertAccountInheritedEvidenceOwner(borrowed, database, token); await inherited.check() }
    finally { if (!borrowed) await inherited.dispose() }
  }
  if (root.recovery) {
    const recovery = await readPublicationPages(database, token, root.recovery, RecoveryPageSchema, entry => [entry.ref])
    if (new Set(recovery.map(entry => entry.key)).size !== recovery.length || recovery.some(entry => entry.key !== entry.ref.documentId)) throw new SyncError('INTEGRITY_FAILED')
    // Recovery has exact retained capability refs; it never contributes operative membership
    if (!recovery.some(entry => entry.ref.documentId === controlId && entry.ref.revisionId !== control.revisionId)) throw new SyncError('INTEGRITY_FAILED')
  }
  const baseline = await readPublicationPages(database, token, root.baseline, BaselinePageSchema, entry => [entry.seed])
  const directories = new Map<number, RemoteDirectory>(), unitSeeds = new Map<string, Exclude<PublicationBaselineEntry, { kind: 'directory' }>>()
  const allocation = new Map<string, string>(), owners = new Map<string, string>()
  const bind = (key: string, documentId: string) => {
    if (allocation.has(key) && allocation.get(key) !== documentId || owners.has(documentId) && owners.get(documentId) !== key) throw new SyncError('INTEGRITY_FAILED')
    allocation.set(key, documentId); owners.set(documentId, key)
  }
  for (const entry of baseline) {
    if (entry.kind !== 'directory') {
      if (unitSeeds.has(entry.key)) throw new SyncError('INTEGRITY_FAILED')
      unitSeeds.set(entry.key, entry); bind(entry.key, entry.seed.documentId); continue
    }
    if (directories.has(entry.shard)) throw new SyncError('INTEGRITY_FAILED')
    const documentId = await withAccountKey(token, key => directoryDocumentId(key, token.accountId, entry.shard))
    if (entry.seed.documentId !== documentId) throw new SyncError('INTEGRITY_FAILED')
    const physical = heads.get(documentId) ?? null
    const selected = physical === entry.replacedHead ? entry.seed : physical ? { documentId, revisionId: physical } : undefined
    if (!selected) throw new SyncError('INTEGRITY_FAILED')
    const value = await openAccountJson(database, token, selected, DirectorySchema)
    if (value.shard !== entry.shard || value.lineageId !== root.lineageId) throw new SyncError('INTEGRITY_FAILED')
    if (selected.revisionId !== entry.seed.revisionId) await descended(database, token, selected, entry.seed)
    await dependencies(database, token, selected, [value.index])
    const allocations = await readPublicationPages(database, token, value.index, DirectoryPageSchema, () => [])
    const keys = new Set<string>()
    for (const value of allocations) {
      if (keys.has(value.key) || await directoryShard(value.key) !== entry.shard) throw new SyncError('INTEGRITY_FAILED')
      keys.add(value.key); bind(value.key, value.documentId)
    }
    directories.set(entry.shard, { shard: entry.shard, ref: selected, physical, allocations })
  }
  if (directories.size !== DIRECTORY_SHARDS) throw new SyncError('INTEGRITY_FAILED')
  const captured = new Map<string, CapturedWorkspaceRecord>()
  const pass = createProjectionReader(token, capturedRecordReader(database, token, new Map()))
  const readCaptured = pass.read
  try {
    const lineages = new Map<string, PersonalLineagePublication>()
    const units = new Map<string, RemoteUnit>(), entries: AccountWorkspaceEntry[] = [], documents: WorkspaceDocument[] = [], payloads = new Map<string, BlobSource>()
    for (const [key, documentId] of allocation) {
      const seed = unitSeeds.get(key), physical = heads.get(documentId) ?? null
      if (isPersonalLineageKey(key)) {
        if (seed && seed.kind !== 'lineage') throw new SyncError('INTEGRITY_FAILED')
        const selected = seed && physical === seed.replacedHead ? seed.seed : physical ? { documentId, revisionId: physical } : undefined
        if (!selected) throw new SyncError('INTEGRITY_FAILED')
        const anchor = await readPersonalLineage(database, token, selected, readCaptured)
        if (anchor.value.privateKey !== key || anchor.value.lineageId !== root.lineageId) throw new SyncError('INTEGRITY_FAILED')
        if (seed && selected.revisionId !== seed.seed.revisionId) await descended(database, token, selected, seed.seed)
        lineages.set(key, anchor); continue
      }
      if (seed?.kind === 'lineage') throw new SyncError('INTEGRITY_FAILED')
      let selected: CipherRef, body: CipherRef, digest: string, valueKind: AccountWorkspaceEntry['kind'], sourceBookkeeping: SourceBookkeeping | undefined, conflictAuthority: ConflictAuthority | undefined
      if (seed?.kind === 'immutable') {
        selected = seed.seed; body = seed.seed; digest = seed.digest; valueKind = seed.valueKind
      } else {
        selected = seed && physical === seed.replacedHead ? seed.seed : physical ? { documentId, revisionId: physical } : (() => { throw new SyncError('INTEGRITY_FAILED') })()
        const value = await openAccountJson(database, token, selected, PublicationRecordSchema)
        if (value.privateKey !== key || value.lineageId !== root.lineageId || value.body.documentId !== documentId || value.body.revisionId === selected.revisionId) throw new SyncError('INTEGRITY_FAILED')
        await dependencies(database, token, selected, [value.body, ...(value.sourceBookkeeping ? sourceBookkeepingRefs(value.sourceBookkeeping) : []), ...(value.conflictAuthority ? conflictAuthorityRefs(value.conflictAuthority) : [])])
        sourceBookkeeping = value.sourceBookkeeping; conflictAuthority = value.conflictAuthority
        if (seed && selected.revisionId !== seed.seed.revisionId) await descended(database, token, selected, seed.seed)
        body = value.body; digest = value.digest; valueKind = value.valueKind
      }
      const original = { ...await readCaptured(body), ...(sourceBookkeeping ? { sourceBookkeeping } : {}) }
      if (original.document.key !== key || original.document.kind !== valueKind || original.digest !== digest) throw new SyncError('INTEGRITY_FAILED')
      const entry: AccountWorkspaceEntry = { key, kind: valueKind, ref: body, digest, ...(sourceBookkeeping ? { sourceBookkeeping } : {}), ...(original.retainingIndex ? { retainingIndex: original.retainingIndex } : {}) }
      entries.push(entry); units.set(key, { key, ref: selected, physical, body: entry, ...(conflictAuthority ? { conflictAuthority } : {}) }); captured.set(blobIdentity(body), original); payloads.set(key, original.source)
      if (valueKind !== 'tombstone') documents.push(original.document)
    }
    const definitions = Object.fromEntries(documents.filter(document => document.kind === 'personal-definition').map(document => { const value = document.value as unknown as PersonalDefinition; return [value.id, value] }))
    const lineageData = { ...createBlankLocalData(), personalDefinitions: definitions }
    const selectedKeys = new Set<string>()
    for (const anchor of lineages.values()) for (const binding of anchor.entries) {
      const body = units.get(binding.key)?.body
      if (anchor.value.deleted) { if (body?.kind !== 'tombstone') throw new SyncError('INTEGRITY_FAILED'); continue }
      if (!body || body.kind !== 'personal-definition' || !sameCipherRefs([body.ref], [binding.ref]) || body.digest !== binding.digest) throw new SyncError('INTEGRITY_FAILED')
      selectedKeys.add(binding.key)
    }
    const inactive = new Set(documents.filter(document => {
      if (document.kind !== 'personal-definition') return false
      const definition = document.value as unknown as PersonalDefinition
      const root = definitionLineageRootRef(lineageData, { kind: 'personal', definitionId: definition.id })
      return lineages.has(personalLineageKey(root)) && !selectedKeys.has(document.key)
    }).map(document => document.key))
    for (let index = documents.length - 1; index >= 0; index--) if (inactive.has(documents[index].key)) documents.splice(index, 1)
    for (let index = entries.length - 1; index >= 0; index--) if (inactive.has(entries[index].key)) entries.splice(index, 1)
    const bookkeeping = await projectionBookkeeping(entries.filter(entry => entry.kind === 'scenario').map(entry => captured.get(blobIdentity(entry.ref))!), readCaptured, nowTimestamp())
    const state = assembleWorkspace(documents, localRevision, { version: 1, changes: [], checkpoints: [], undoable: false }, bookkeeping)
    const retained = await validatedWorkspaceRetentionEdges(state)
    const supersededConflictIds = new Set<string>()
    for (const conflict of state.conflicts) {
      const authority = units.get(JSON.stringify(['conflict', conflict.id]))?.conflictAuthority
      if (!authority) throw new SyncError('INTEGRITY_FAILED')
      await validateConflictAuthority(database, token, state, conflict, authority, control)
      if (authority.supersedes) supersededConflictIds.add(authority.supersedes.id)
    }
    const exactReader = capturedRecordReader(database, token, captured)
    await validateCapturedWorkspaceRecords(capturedRecordReader(database, token, captured, readCaptured), entries.map(entry => entry.ref), allocation, retained)
    // This projection is parented to the actual local graph on adoption. Its cache lineage must
    // follow that head; the publication control has a separate lineage that bulk commits can change
    const localRoot = await openAccountJson(database, token, localHead, z.union([AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema]))
    assertActiveProfile(token)
    return { control, ...(root.version === 2 ? { inheritedEvidence: root.inheritedEvidence } : {}), lineageId: root.lineageId, baseline, units, directories, lineages, supersededConflictIds, workspace: { state, head: localHead, ...(root.version === 2 ? { formatVersion: 2 as const, inheritedEvidence: root.inheritedEvidence } : {}), lineageId: localRoot.lineageId, entries, allocations: [...allocation].map(([key, documentId]) => ({ key, documentId })), payloads, readCaptured: exactReader } }
  } finally { pass.dispose() }
}
async function assertAdvance(database: AccountDatabase, token: ProfileToken, next: RemoteProjection | null, previous: { readonly control: CipherRef; readonly lineageId: string; readonly units: readonly { key: string; publication: CipherRef }[] }): Promise<void> {
  if (!next) throw new SyncError('INTEGRITY_FAILED')
  await descended(database, token, next.control, previous.control)
  if (next.lineageId !== previous.lineageId) {
    if (next.control.revisionId === previous.control.revisionId) throw new SyncError('INTEGRITY_FAILED')
  }
  for (const value of previous.units) {
    const unit = next.units.get(value.key) ?? next.lineages.get(value.key)
    if (!unit) throw new SyncError('INTEGRITY_FAILED')
    // Immutable non-head bodies are authorized by the new index; only envelope ancestry crosses a lineage replacement
    if (next.lineageId !== previous.lineageId && next.baseline.some(entry => entry.kind === 'immutable' && entry.key === value.key)) continue
    if (unit.ref.documentId !== value.publication.documentId) {
      await (await import('./mapping-advance')).assertResolvedMappingAdvance(database, token, next, value)
      continue
    }
    // A larger server watermark cannot authorize replaying an older valid same-lineage envelope
    await descended(database, token, unit.ref, value.publication)
  }
}
export async function assertProjectionSuccessor(database: AccountDatabase, token: ProfileToken, next: RemoteProjection | null, previous: RemoteProjection | null): Promise<void> {
  if (previous) await assertAdvance(database, token, next, { control: previous.control, lineageId: previous.lineageId, units: [...previous.units.values()].map(unit => ({ key: unit.key, publication: unit.ref })).concat([...previous.lineages].map(([key, anchor]) => ({ key, publication: anchor.ref }))) })
}
export async function assertProjectionAdvance(database: AccountDatabase, token: ProfileToken, next: RemoteProjection | null, previous?: import('./pull').RemoteState['effective']): Promise<void> {
  if (!previous) return
  const { z } = await import('zod')
  const { CipherRefSchema } = await import('../../workspace/account-cache')
  const { publicationPageSchema } = await import('./publication')
  const pages = publicationPageSchema(z.strictObject({ key: z.string(), body: CipherRefSchema, publication: CipherRefSchema }), 'local-effective-units')
  const units = await readPublicationPages(database, token, previous.units, pages, entry => [entry.body, entry.publication])
  await assertAdvance(database, token, next, { ...previous, units })
}

export { descended as assertPublicationDescendant }

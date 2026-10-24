import { ConflictAuthoritySchema, conflictAuthorityRefs, type ConflictAuthority } from '../../workspace/conflict-authority'
import { z } from 'zod'
import { SourceBookkeepingSchema, sourceBookkeepingRefs } from '../../workspace/source-bookkeeping'
import { assertActiveProfile, withAccountKey, type ProfileToken } from '../profile'
import { OpaqueIdSchema } from '../protocol'
import type { AccountDatabase, CipherRecord, CipherRef } from '../../persistence/account-database'
import { CipherRefSchema, cipherRef } from '../../workspace/account-cache'
import { stageAccountSource } from '../../workspace/account-streams'
import type { AccountWorkspaceEntry } from '../../workspace/account-graph'
import { WORKSPACE_DOCUMENT_KINDS } from '../../workspace/documents'
import { memoryBlob } from '../../workspace/blobs'
import { buildIndexPages, DIRECTORY_SHARDS, directoryDocumentId, INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES, workspaceControlDocumentId } from '../../workspace/directory'
import { SyncError } from './client'

export const ordinaryAutosaveKinds: ReadonlySet<string> = new Set<string>(['workspace-preferences', 'reference-preferences', 'library-defaults', 'build', 'team', 'playthrough', 'character', 'progress', 'goal', 'scenario', 'inventory', 'quintar-breeding', 'skill-layout', 'skill-capture', 'editor', 'save'])
const PublishedValueKindSchema = z.enum(WORKSPACE_DOCUMENT_KINDS).refine(kind => !['directory', 'directory-page', 'unit-index', 'directory-mapping-unit', 'workspace-control', 'baseline-page', 'recovery-page'].includes(kind))
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const PublicationRecordSchema = z.strictObject({ version: z.literal(1), kind: z.literal('publication-record'), privateKey: z.string(), valueKind: PublishedValueKindSchema, lineageId: OpaqueIdSchema, body: CipherRefSchema, digest: DigestSchema, sourceBookkeeping: SourceBookkeepingSchema.optional(), conflictAuthority: ConflictAuthoritySchema.optional() }).refine(value => !value.conflictAuthority || value.valueKind === 'conflict')
const PublicationControlV1Schema = z.strictObject({ version: z.literal(1), kind: z.literal('workspace-control'), lineageId: OpaqueIdSchema, baseline: CipherRefSchema, recovery: CipherRefSchema.optional() })
const PublicationControlV2Schema = PublicationControlV1Schema.extend({ version: z.literal(2), inheritedEvidence: CipherRefSchema })
export const PublicationControlSchema = z.union([PublicationControlV1Schema, PublicationControlV2Schema])
export const DirectorySchema = z.strictObject({ version: z.literal(1), kind: z.literal('publication-directory'), lineageId: OpaqueIdSchema, shard: z.number().int().min(0).max(DIRECTORY_SHARDS - 1), index: CipherRefSchema })
export const AllocationSchema = z.strictObject({ key: z.string(), documentId: OpaqueIdSchema })
export const BaselineEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mutable'), key: z.string(), seed: CipherRefSchema, replacedHead: OpaqueIdSchema.nullable() }),
  z.strictObject({ kind: z.literal('immutable'), key: z.string(), valueKind: PublishedValueKindSchema, seed: CipherRefSchema, digest: DigestSchema }),
  z.strictObject({ kind: z.literal('lineage'), key: z.string(), seed: CipherRefSchema, replacedHead: OpaqueIdSchema.nullable() }),
  z.strictObject({ kind: z.literal('directory'), shard: z.number().int().min(0).max(DIRECTORY_SHARDS - 1), seed: CipherRefSchema, replacedHead: OpaqueIdSchema.nullable() }),
])
export type PublicationBaselineEntry = z.infer<typeof BaselineEntrySchema>
export function publicationPageSchema<T>(entry: z.ZodType<T>, kind: string) {
  return z.strictObject({ version: z.literal(1), kind: z.literal(kind), entries: z.array(entry), children: z.array(CipherRefSchema) }).refine(page => page.entries.length + page.children.length <= INDEX_PAGE_ENTRIES)
}
export const BaselinePageSchema = publicationPageSchema(BaselineEntrySchema, 'publication-baseline-page')
export const DirectoryPageSchema = publicationPageSchema(AllocationSchema, 'publication-directory-page')
export const RecoveryEntrySchema = z.strictObject({ key: z.string(), ref: CipherRefSchema })
export const RecoveryPageSchema = publicationPageSchema(RecoveryEntrySchema, 'publication-recovery-page')

export async function stagePublicationJson(database: AccountDatabase, token: ProfileToken, value: unknown, dependencies: readonly CipherRef[], documentId?: string, parent?: CipherRef | readonly CipherRef[], protection: 'protected' | 'ordinary-autosave-envelope' = 'protected'): Promise<CipherRecord> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  if (bytes.length > INDEX_PAGE_BYTES) throw new SyncError('PAYLOAD_TOO_LARGE')
  const record = await stageAccountSource(database, token, memoryBlob(bytes), [...new Map(dependencies.map(ref => [JSON.stringify(ref), ref])).values()], parent, documentId, undefined, protection)
  assertActiveProfile(token)
  // Immutable encrypted staging is recoverable but cannot alter a local or remote projection by itself
  await database.encryptedRevisions.add(record)
  assertActiveProfile(token)
  return record
}
export async function stagePublicationRecord(database: AccountDatabase, token: ProfileToken, entry: AccountWorkspaceEntry, lineageId: string, parent?: CipherRef | readonly CipherRef[], conflictAuthority?: ConflictAuthority, ordinaryAutosave = false): Promise<CipherRecord> {
  if (parent && (Array.isArray(parent) ? parent : [parent as CipherRef]).some(ref => ref.documentId !== entry.ref.documentId)) throw new SyncError('INTEGRITY_FAILED')
  const value = PublicationRecordSchema.parse({ version: 1, kind: 'publication-record', privateKey: entry.key, valueKind: entry.kind, lineageId, body: entry.ref, digest: entry.digest, ...(entry.sourceBookkeeping ? { sourceBookkeeping: entry.sourceBookkeeping } : {}), ...(conflictAuthority ? { conflictAuthority } : {}) })
  const eligible = ordinaryAutosave && !!parent && !Array.isArray(parent) && !conflictAuthority && ordinaryAutosaveKinds.has(entry.kind)
  // Only new ordinary envelopes can expire; exact mapped bodies and initial seeds remain protected
  // An authoritative branch parents its captured envelope, never the mapped body's independent ancestry
  return stagePublicationJson(database, token, value, [entry.ref, ...(entry.sourceBookkeeping ? sourceBookkeepingRefs(entry.sourceBookkeeping) : []), ...(conflictAuthority ? conflictAuthorityRefs(conflictAuthority) : [])], entry.ref.documentId, parent, eligible ? 'ordinary-autosave-envelope' : 'protected')
}
export async function stagePublicationPages<T>(database: AccountDatabase, token: ProfileToken, kind: string, entries: readonly T[], dependencies: (entry: T) => readonly CipherRef[]): Promise<CipherRef> {
  return buildIndexPages(entries, async page => cipherRef(await stagePublicationJson(database, token, { ...page, kind }, [...page.children, ...page.entries.flatMap(dependencies)])), page => new TextEncoder().encode(JSON.stringify({ ...page, kind })).length)
}
export async function stagePublicationDirectory(database: AccountDatabase, token: ProfileToken, lineageId: string, shard: number, allocations: readonly z.infer<typeof AllocationSchema>[], parent?: CipherRef | readonly CipherRef[]): Promise<CipherRef> {
  const index = await stagePublicationPages(database, token, 'publication-directory-page', allocations, () => [])
  return stageDirectoryEnvelope(database, token, lineageId, shard, index, parent)
}

async function stageDirectoryEnvelope(database: AccountDatabase, token: ProfileToken, lineageId: string, shard: number, index: CipherRef, parent?: CipherRef | readonly CipherRef[]): Promise<CipherRef> {
  const documentId = await withAccountKey(token, key => directoryDocumentId(key, token.accountId, shard))
  if (parent && (Array.isArray(parent) ? parent : [parent as CipherRef]).some(ref => ref.documentId !== documentId)) throw new SyncError('INTEGRITY_FAILED')
  const value = DirectorySchema.parse({ version: 1, kind: 'publication-directory', lineageId, shard, index })
  return cipherRef(await stagePublicationJson(database, token, value, [index], documentId, parent))
}
export async function stagePublicationControl(database: AccountDatabase, token: ProfileToken, lineageId: string, entries: readonly PublicationBaselineEntry[], parent?: CipherRef | readonly CipherRef[], recovery?: CipherRef, inheritedEvidence?: CipherRef): Promise<CipherRef> {
  for (const entry of entries) BaselineEntrySchema.parse(entry)
  const baseline = await stagePublicationPages(database, token, 'publication-baseline-page', entries, entry => [entry.seed])
  const documentId = await withAccountKey(token, key => workspaceControlDocumentId(key, token.accountId))
  if (parent && (Array.isArray(parent) ? parent : [parent as CipherRef]).some(ref => ref.documentId !== documentId)) throw new SyncError('INTEGRITY_FAILED')
  const value = inheritedEvidence ? PublicationControlV2Schema.parse({ version: 2, kind: 'workspace-control', lineageId, baseline, ...(recovery ? { recovery } : {}), inheritedEvidence }) : PublicationControlV1Schema.parse({ version: 1, kind: 'workspace-control', lineageId, baseline, ...(recovery ? { recovery } : {}) })
  return cipherRef(await stagePublicationJson(database, token, value, [baseline, ...(recovery ? [recovery] : []), ...(inheritedEvidence ? [inheritedEvidence] : [])], documentId, parent))
}

export interface PublicationAttempt {
  readonly final: import('../protocol').CommitRequest
  readonly registrations: readonly import('../protocol').CommitRequest[]
  readonly bindings: readonly { readonly body: CipherRef; readonly publication: CipherRef }[]
  readonly lineageId: string
  readonly bulk: boolean
}
export async function preparePublicationAttempt(database: AccountDatabase, token: ProfileToken, target: import('../../workspace/account-graph').OpenAccountWorkspace, remote: import('./projection').RemoteProjection | null, heads: ReadonlyMap<string, string>, epoch: number, changes?: readonly import('../../workspace/account-intents').MappedWorkspaceChange[], mode: 'additive' | 'replace' = 'additive', captured?: { readonly lineageId: string; readonly parents: ReadonlyMap<string, CipherRef> }, options?: { readonly initialTombstones?: ReadonlyMap<string, CipherRef>; readonly authorities?: ReadonlyMap<string, ConflictAuthority>; readonly resolutionParents?: ReadonlyMap<string, readonly CipherRef[]>; readonly installLineages?: boolean; readonly mappingResolutions?: ReadonlyMap<string, { readonly parents: readonly CipherRef[]; readonly record: import('../../workspace/conflict-authority').OriginalPublication }> }): Promise<PublicationAttempt> {
  if (remote?.inheritedEvidence && !target.inheritedEvidence) throw new SyncError('INTEGRITY_FAILED')
  const { publicationDocuments } = await import('../../workspace/closure')
  const { accountLocalId } = await import('../../workspace/account-cache')
  const { directoryShard } = await import('../../workspace/directory')
  const { maxChangedHeads, maxCommitJsonBytes } = await import('../protocol')
  const eligible = new Set((await publicationDocuments(target.state)).map(document => document.key))
  // Only verified imported accepted deletions request a first destination tombstone. Ordinary
  // callers still cannot publish orphan deletions; absence, exact body and initial parent stay guarded
  for (const [key, ref] of options?.initialTombstones ?? []) {
    const entry = target.entries.find(value => value.key === key)
    if (!remote || remote.units.has(key) || remote.lineages.has(key) || remote.workspace.allocations.some(value => value.key === key) || [...remote.directories.values()].some(value => value.allocations.some(allocation => allocation.key === key)) || !entry || entry.kind !== 'tombstone' || JSON.stringify(entry.ref) !== JSON.stringify(ref)) throw new SyncError('INTEGRITY_FAILED')
    const original = await target.readCaptured(ref)
    if (original.document.kind !== 'tombstone' || original.document.key !== key || (original.document.value as unknown as { privateKey: string }).privateKey !== key || original.digest !== entry.digest) throw new SyncError('INTEGRITY_FAILED')
  }
  const targetEntries = new Map(target.entries.filter(entry => eligible.has(entry.key) || entry.kind === 'tombstone' && (remote?.units.has(entry.key) || options?.initialTombstones?.has(entry.key))).map(entry => [entry.key, entry]))
  const changed = changes ? changes.filter(change => targetEntries.has(change.key) && change.kind !== 'workspace-identity') : [...targetEntries.values()].filter(entry => entry.kind !== 'workspace-identity').map(entry => ({ key: entry.key, kind: entry.kind, before: null, after: entry.ref }))
  const entries = new Map(remote?.workspace.entries.map(entry => [entry.key, entry]) ?? [])
  const selected = new Map(remote?.units ?? [])
  if (mode === 'replace') {
    const { workspaceDocumentSource } = await import('../../workspace/document-codec')
    const { hashBlob } = await import('../../workspace/blobs')
    // Only explicit replacement grants deletion authority for allocations absent from the immutable target
    for (const [key, old] of entries) if (!targetEntries.has(key)) {
      const source = workspaceDocumentSource({ version: 1, kind: 'tombstone', key, value: { version: 1, kind: 'tombstone', privateKey: key } })
      const record = await stageAccountSource(database, token, source, [], old.ref, old.ref.documentId)
      await database.encryptedRevisions.add(record)
      entries.set(key, { key, kind: 'tombstone', ref: cipherRef(record), digest: await hashBlob(source) })
    }
    for (const [key, entry] of targetEntries) {
      if (entries.has(key) && entries.get(key)!.ref.documentId !== entry.ref.documentId) throw new SyncError('HEAD_CONFLICT')
      entries.set(key, entry)
    }
  }
  for (const change of changed) {
    const accepted = remote?.units.get(change.key)
    if (accepted && accepted.body.ref.documentId !== change.after?.documentId && !options?.mappingResolutions?.has(change.key)) throw new SyncError('HEAD_CONFLICT')
    if (remote && mode !== 'replace' && ((change.before === null && accepted) || (change.before !== null && (!accepted || accepted.body.ref.revisionId !== change.before.revisionId)))) throw new SyncError('HEAD_CONFLICT')
    entries.set(change.key, targetEntries.get(change.key)!)
  }
  if (!remote) for (const [key, entry] of targetEntries) entries.set(key, entry)
  const { personalLineageChains } = await import('./lineage')
  const { stagePersonalLineage, stageDeletedPersonalLineage } = await import('./lineage-publication')
  const chains = personalLineageChains(target.state.planner.localData)
  const removedAnchors = [...(remote?.lineages.keys() ?? [])].filter(key => !chains.has(key) && (mode === 'replace' || remote!.lineages.get(key)!.entries.some(entry => changed.some(change => change.key === entry.key && targetEntries.get(entry.key)?.kind === 'tombstone'))))
  const anchorKeys = options?.installLineages === false ? [] : [...new Set([...chains.keys(), ...removedAnchors, ...[...(remote?.lineages ?? [])].filter(([, anchor]) => anchor.value.deleted).map(([key]) => key)])]
  const changedAnchors = anchorKeys.filter(key => {
    const previous = remote?.lineages.get(key)
    if (!chains.has(key)) return !previous?.value.deleted
    return !previous || previous.value.deleted || JSON.stringify(previous.entries.map(entry => entry.ref)) !== JSON.stringify(chains.get(key)!.map(definition => target.entries.find(entry => entry.key === JSON.stringify(['personal-definition', definition.id]))!.ref))
  })
  const newAnchorKeys = changedAnchors.filter(key => !remote?.lineages.has(key))
  const newKeys = changed.filter(change => !remote?.units.has(change.key)).map(change => change.key)
  const shards = new Set(await Promise.all([...newKeys, ...newAnchorKeys].map(directoryShard)))
  const bulk = !!options?.mappingResolutions?.size || !remote || mode === 'replace' || JSON.stringify(target.inheritedEvidence) !== JSON.stringify(remote?.inheritedEvidence) || changed.length + changedAnchors.length + shards.size + 1 > maxChangedHeads || options?.installLineages === true
  const installation = options?.installLineages === true && !!remote
  if (installation && (changed.length || target.entries.some(entry => remote!.units.get(entry.key)?.body.ref.revisionId !== entry.ref.revisionId))) throw new SyncError('HEAD_CONFLICT')
  const lineageId = installation ? remote!.lineageId : bulk ? accountLocalId() : remote!.lineageId
  const bindings: { body: CipherRef; publication: CipherRef }[] = [], publish: CipherRef[] = []
  const seeds: PublicationBaselineEntry[] = installation ? [...remote!.baseline] : []
  const wrap = async (entry: AccountWorkspaceEntry) => {
    const changedEntry = changed.find(change => change.key === entry.key)
    const mapping = options?.mappingResolutions?.get(entry.key)
    if (mapping && (mapping.record.body.documentId !== entry.ref.documentId || mapping.record.privateKey !== entry.key || mapping.record.digest !== entry.digest)) throw new SyncError('INTEGRITY_FAILED')
    if (mapping && JSON.stringify(mapping.record.body) !== JSON.stringify(entry.ref)) await (await import('./mapping-selection')).assertEditorTransportBinding(database, token, mapping.record, entry.ref)
    const parent = mapping?.record.ref ?? (changedEntry?.before && mode !== 'replace' ? captured?.parents.get(changedEntry.before.revisionId) : remote?.units.get(entry.key)?.ref)
    if (!mapping && changedEntry?.before && remote && mode !== 'replace' && (!parent || captured?.lineageId !== remote.lineageId || parent.revisionId !== remote.units.get(entry.key)?.ref.revisionId)) throw new SyncError('HEAD_CONFLICT')
    const authority = options?.authorities?.get(entry.key) ?? remote?.units.get(entry.key)?.conflictAuthority
    const ref = cipherRef(await stagePublicationRecord(database, token, entry, lineageId, options?.resolutionParents?.get(entry.key) ?? parent, authority, !bulk && !options?.resolutionParents?.has(entry.key) && !options?.mappingResolutions?.has(entry.key)))
    bindings.push({ body: entry.ref, publication: ref }); selected.set(entry.key, { key: entry.key, ref, physical: heads.get(ref.documentId) ?? null, body: entry }); return ref
  }
  const anchorRefs = new Map<string, CipherRef>()
  for (const key of installation ? newAnchorKeys : bulk ? anchorKeys : changedAnchors) {
    const anchor = chains.has(key) ? await stagePersonalLineage(database, token, target, key, lineageId, options?.resolutionParents?.get(key) ?? remote?.lineages.get(key)?.ref) : await stageDeletedPersonalLineage(database, token, remote!.lineages.get(key)!, lineageId)
    anchorRefs.set(key, anchor.ref)
    if (bulk) seeds.push({ kind: 'lineage', key, seed: anchor.ref, replacedHead: heads.get(anchor.ref.documentId) ?? null })
    else publish.push(anchor.ref)
  }
  if (installation) {
    const recovery = await stagePublicationPages(database, token, 'publication-recovery-page', [{ key: remote!.control.documentId, ref: remote!.control }], entry => [entry.ref])
    publish.push(await stagePublicationControl(database, token, lineageId, seeds, remote!.control, recovery, target.inheritedEvidence))
  } else if (bulk) {
    for (const entry of entries.values()) {
      if (entry.kind === 'workspace-identity') { seeds.push({ kind: 'immutable', key: entry.key, valueKind: entry.kind, seed: entry.ref, digest: entry.digest }); continue }
      seeds.push({ kind: 'mutable', key: entry.key, seed: await wrap(entry), replacedHead: heads.get(entry.ref.documentId) ?? null })
    }
    // Empty pages carry no shard authority; share only this newly staged page while each envelope keeps its actual parents
    const emptyIndex = await stagePublicationPages(database, token, 'publication-directory-page', [], () => [])
    for (let shard = 0; shard < DIRECTORY_SHARDS; shard++) {
      const old = remote?.directories.get(shard)
      const resolutions = [...(options?.mappingResolutions ?? [])].filter(([, value]) => value.parents[0].documentId === old?.ref.documentId)
      if (resolutions.length > 1) throw new SyncError('HEAD_CONFLICT')
      const resolution = resolutions[0]?.[1]
      if (resolution && (resolution.parents.length !== 2 || JSON.stringify(resolution.parents[1]) !== JSON.stringify(old?.ref))) throw new SyncError('INTEGRITY_FAILED')
      const seed = await stageDirectoryEnvelope(database, token, lineageId, shard, emptyIndex, resolution?.parents ?? old?.ref)
      if (resolution) publish.push(seed)
      seeds.push({ kind: 'directory', shard, seed, replacedHead: heads.get(seed.documentId) ?? null })
    }
    const recovery = remote ? await stagePublicationPages(database, token, 'publication-recovery-page', [remote.control, ...[...remote.units.values()].map(unit => unit.ref), ...[...remote.lineages.values()].map(anchor => anchor.ref), ...[...remote.directories.values()].map(directory => directory.ref)].map(ref => ({ key: ref.documentId, ref })), entry => [entry.ref]) : undefined
    publish.push(await stagePublicationControl(database, token, lineageId, seeds, remote?.control, recovery, target.inheritedEvidence))
  } else {
    for (const change of changed) publish.push(await wrap(entries.get(change.key)!))
    for (const shard of shards) {
      const prior = remote!.directories.get(shard)!
      const allocations = [...prior.allocations]
      for (const key of newAnchorKeys) if (await directoryShard(key) === shard) allocations.push({ key, documentId: anchorRefs.get(key)!.documentId })
      for (const key of newKeys) if (await directoryShard(key) === shard) allocations.push({ key, documentId: entries.get(key)!.ref.documentId })
      publish.push(await stagePublicationDirectory(database, token, lineageId, shard, allocations, prior.ref))
    }
    // This real unchanged-head guard permits disjoint ordinary commands without an account-wide epoch CAS
    publish.push(remote!.control)
  }
  const final = { version: 1 as const, mutationId: accountLocalId(), revisions: [], heads: publish, expected: publish.map(ref => ({ documentId: ref.documentId, revisionId: heads.get(ref.documentId) ?? null })), ...(bulk && remote ? { expectedPublicationEpoch: epoch } : {}) }
  const known = new Set<string>(), inspected = new Set<string>()
  async function knownClosure(ref: CipherRef, retained = true): Promise<void> {
    const role = `${ref.revisionId}:${retained}`
    if (inspected.has(role)) return
    inspected.add(role); known.add(ref.revisionId)
    const record = await database.encryptedRevisions.get(ref.revisionId)
    if (!record || record.descriptor.documentId !== ref.documentId) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    // An ancestor proves registration and ancestry, not retention of its historical payload dependency graph
    if (retained) for (const dependency of record.descriptor.dependencies) await knownClosure(dependency)
    for (const revisionId of record.descriptor.parents) await knownClosure({ documentId: ref.documentId, revisionId }, false)
  }
  if (remote) for (const ref of [remote.control, ...[...remote.units.values()].map(unit => unit.ref), ...[...remote.lineages.values()].map(anchor => anchor.ref), ...[...remote.directories.values()].map(directory => directory.ref)]) await knownClosure(ref)
  const ordered: import('../protocol').RevisionDescriptor[] = [], done = new Set<string>(), visiting = new Set<string>()
  async function visit(ref: CipherRef): Promise<void> {
    if (known.has(ref.revisionId) || done.has(ref.revisionId)) return
    if (visiting.has(ref.revisionId)) throw new SyncError('INTEGRITY_FAILED')
    visiting.add(ref.revisionId)
    const record = await database.encryptedRevisions.get(ref.revisionId)
    if (!record || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    for (const dependency of record.descriptor.dependencies) await visit(dependency)
    for (const revisionId of record.descriptor.parents) await visit({ documentId: ref.documentId, revisionId })
    visiting.delete(ref.revisionId); done.add(ref.revisionId); ordered.push(record.descriptor)
  }
  for (const ref of publish) await visit(ref)
  const registrations: import('../protocol').CommitRequest[] = []
  let command: import('../protocol').CommitRequest = { version: 1, mutationId: accountLocalId(), revisions: [], heads: [], expected: [] }
  for (const revision of ordered) {
    const candidate = { ...command, revisions: [...command.revisions, revision] }
    if (candidate.revisions.length > maxChangedHeads || new TextEncoder().encode(JSON.stringify(candidate)).length > maxCommitJsonBytes) {
      if (!command.revisions.length) throw new SyncError('PAYLOAD_TOO_LARGE')
      registrations.push(command); command = { version: 1, mutationId: accountLocalId(), revisions: [revision], heads: [], expected: [] }
    } else command = candidate
  }
  if (command.revisions.length) registrations.push(command)
  return { final, registrations, bindings, bulk, lineageId }
}

import { z } from 'zod'
import { PublicationLineageSchema, readPersonalLineage } from './lineage-publication'
import { capturedRecordReader } from '../../workspace/account-evidence'
import type { ProfileToken } from '../profile'
import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import { openAccountJson } from '../../workspace/account-cache'
import { OriginalPublicationSchema, ConflictAuthoritySchema, type OriginalPublication, type ConflictAuthority } from '../../workspace/conflict-authority'
import type { WorkspaceState, WorkspaceConflict } from '../../workspace/documents'
import { inspectWorkspaceClosure } from '../../workspace/closure'
import { PublicationRecordSchema } from './publication'
import { SyncError } from './client'

export async function readOriginalPublication(database: AccountDatabase, token: ProfileToken, ref: CipherRef): Promise<OriginalPublication> {
  const raw = await openAccountJson(database, token, ref, z.unknown())
  const anchor = PublicationLineageSchema.safeParse(raw)
  if (anchor.success) {
    const lineage = await readPersonalLineage(database, token, ref, capturedRecordReader(database, token, new Map()))
    const record = await database.encryptedRevisions.get(ref.revisionId)
    if (!record || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw new SyncError('INTEGRITY_FAILED')
    return OriginalPublicationSchema.parse({ version: 1, ref, lineageId: lineage.value.lineageId, body: lineage.value.selected, privateKey: lineage.value.privateKey, valueKind: 'personal-lineage', digest: lineage.entries.at(-1)!.digest, parents: record.descriptor.parents, lineage: { root: lineage.value.root, chain: lineage.value.chain, ...(lineage.value.deleted ? { deleted: true } : {}), ...(lineage.value.reallocatedFrom ? { reallocatedFrom: lineage.value.reallocatedFrom } : {}) } })
  }
  const envelope = PublicationRecordSchema.parse(raw)
  const record = await database.encryptedRevisions.get(ref.revisionId)
  if (!record || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw new SyncError('INTEGRITY_FAILED')
  return OriginalPublicationSchema.parse({ version: 1, ref, lineageId: envelope.lineageId, body: envelope.body, privateKey: envelope.privateKey, valueKind: envelope.valueKind, digest: envelope.digest, parents: record.descriptor.parents, ...(envelope.sourceBookkeeping ? { sourceBookkeeping: envelope.sourceBookkeeping } : {}) })
}
export async function validateConflictAuthority(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, conflict: WorkspaceConflict, input: ConflictAuthority, acceptedControl?: CipherRef): Promise<void> {
  const authority = ConflictAuthoritySchema.parse(input)
  if (JSON.stringify(authority.unit) !== JSON.stringify(conflict.unit) || authority.commonAncestor.kind !== conflict.commonAncestor.kind) throw new SyncError('INTEGRITY_FAILED')
  const branches = conflict.branches.map((branch, index) => ({ closure: branch.closure, publication: authority.branches[index].publication }))
  if (conflict.commonAncestor.kind === 'present' && authority.commonAncestor.kind === 'present') branches.push({ closure: conflict.commonAncestor.closure, publication: authority.commonAncestor.publication })
  for (const branch of branches) {
    const actual = branch.publication.mapping ? await (await import('./mapping-publication')).readMappingPublication(database, token, branch.publication.ref, conflict.unit.privateKey, branch.publication.mapping.record?.ref, branch.publication.mapping.context, acceptedControl) : await readOriginalPublication(database, token, branch.publication.ref)
    const archived = await inspectWorkspaceClosure(state, branch.closure)
    if (JSON.stringify(actual) !== JSON.stringify(branch.publication) || JSON.stringify(archived.publication) !== JSON.stringify(actual) || actual.privateKey !== conflict.unit.privateKey) throw new SyncError('INTEGRITY_FAILED')
  }
  const successor = (await inspectWorkspaceClosure(state, conflict.branches[0].closure)).supersedes
  if (Boolean(successor) !== Boolean(authority.supersedes)) throw new SyncError('INTEGRITY_FAILED')
  if (authority.supersedes && successor) {
    const prior = await readOriginalPublication(database, token, authority.supersedes.ref)
    if (authority.supersedes.id !== successor.priorId || successor.conflictId !== conflict.id || JSON.stringify(prior) !== JSON.stringify(successor.prior)) throw new SyncError('INTEGRITY_FAILED')
    const priorEnvelope = await openAccountJson(database, token, prior.ref, PublicationRecordSchema)
    const previous = priorEnvelope.conflictAuthority
    if (!previous || JSON.stringify(previous.unit) !== JSON.stringify(authority.unit) || JSON.stringify(previous.commonAncestor) !== JSON.stringify(authority.commonAncestor) || JSON.stringify(previous.branches[0]) !== JSON.stringify(authority.branches[0])) throw new SyncError('INTEGRITY_FAILED')
    await (await import('./projection')).assertPublicationDescendant(database, token, authority.branches[1].publication.ref, previous.branches[1].publication.ref)
  }
  const [local, remote] = authority.branches.map(branch => branch.publication.ref)
  if (local.documentId !== remote.documentId || local.revisionId === remote.revisionId) throw new SyncError('INTEGRITY_FAILED')
  if (authority.branches[0].publication.lineageId !== authority.lineageId) throw new SyncError('INTEGRITY_FAILED')
  if (authority.commonAncestor.kind === 'present') {
    const ancestor = authority.commonAncestor.publication.ref
    if (ancestor.documentId !== local.documentId || JSON.stringify(authority.branches[0].publication.parents) !== JSON.stringify([ancestor.revisionId])) throw new SyncError('INTEGRITY_FAILED')
    await (await import('./projection')).assertPublicationDescendant(database, token, remote, ancestor)
  } else if (authority.branches[0].publication.parents.length !== 0 || !authority.supersedes && authority.branches[1].publication.parents.length !== 0) throw new SyncError('INTEGRITY_FAILED')
}

export async function assertUnchangedPublicationContinuation(database: AccountDatabase, token: ProfileToken, current: CipherRef, captured: CipherRef): Promise<void> {
  try {
    const original = await readOriginalPublication(database, token, captured)
    const association = async (value: OriginalPublication) => JSON.stringify([value.privateKey, value.valueKind, value.body, value.digest, value.sourceBookkeeping ?? null, value.lineage ? [value.lineage.root, value.lineage.deleted ?? false, (await readPersonalLineage(database, token, value.ref, capturedRecordReader(database, token, new Map()))).entries] : null])
    const expected = await association(original), visiting = new Set<string>(), checked = new Set<string>()
    const visit = async (ref: CipherRef): Promise<void> => {
      if (ref.documentId !== captured.documentId || visiting.has(ref.revisionId)) throw new SyncError('STALE_CONFLICT_CHOICE')
      if (checked.has(ref.revisionId)) return
      const envelope = await readOriginalPublication(database, token, ref)
      if (await association(envelope) !== expected) throw new SyncError('STALE_CONFLICT_CHOICE')
      if (ref.revisionId !== captured.revisionId) {
        const record = await database.encryptedRevisions.get(ref.revisionId)
        if (!record || record.descriptor.documentId !== captured.documentId || record.descriptor.accountId !== token.accountId || record.descriptor.parents.length === 0) throw new SyncError('STALE_CONFLICT_CHOICE')
        visiting.add(ref.revisionId)
        // A temporary change and reversion is new work, even when its final body matches the reviewed branch
        for (const revisionId of record.descriptor.parents) await visit({ documentId: ref.documentId, revisionId })
        visiting.delete(ref.revisionId)
      }
      checked.add(ref.revisionId)
    }
    await visit(current)
  } catch { throw new SyncError('STALE_CONFLICT_CHOICE') }
}

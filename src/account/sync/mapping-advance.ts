import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import type { ProfileToken } from '../profile'
import { openAccountJson } from '../../workspace/account-cache'
import { sameCipherRefs } from '../../workspace/account-retaining'
import { PublicationControlSchema, BaselinePageSchema, RecoveryPageSchema } from './publication'
import { openRemoteProjection, readPublicationPages, assertPublicationDescendant, type RemoteProjection } from './projection'
import { readOriginalPublication, assertUnchangedPublicationContinuation } from './conflict-authority'
import { assertUnchangedMappingContinuation } from './mapping-continuation'
import { assertEditorTransportBinding } from './mapping-selection'
import { SyncError } from './client'

// Cross-allocation advance exists only at an authenticated resolved mapping boundary
export async function assertResolvedMappingAdvance(database: AccountDatabase, token: ProfileToken, next: RemoteProjection, previous: { key: string; publication: CipherRef }): Promise<void> {
  const current = next.units.get(previous.key)
  if (!current) throw new SyncError('INTEGRITY_FAILED')
  const candidates = next.workspace.state.conflicts.filter(conflict => conflict.unit.kind === 'directory-mapping' && conflict.unit.privateKey === previous.key && conflict.disposition.kind === 'resolved')
  for (const conflict of candidates) {
    const published = next.units.get(JSON.stringify(['conflict', conflict.id])), authority = published?.conflictAuthority
    if (!authority || JSON.stringify(authority.unit) !== JSON.stringify(conflict.unit) || conflict.unit.kind !== 'directory-mapping' || conflict.disposition.kind !== 'resolved' || conflict.disposition.choice === 'both') continue
    const shardNumber = conflict.unit.shard
    const chosenIndex = conflict.disposition.choice === 'this' ? 0 : 1
    const chosen = authority.branches[chosenIndex].publication.mapping?.record
    const accepted = authority.branches[1].publication.mapping?.record
    if (!chosen || !accepted || chosen.ref.documentId !== current.ref.documentId || accepted.ref.documentId !== previous.publication.documentId || JSON.stringify(conflict.disposition.result) !== JSON.stringify(conflict.branches[chosenIndex].closure)) continue
    const queue = [next.control], seen = new Set<string>()
    while (queue.length) {
      const ref = queue.pop()!
      if (seen.has(ref.revisionId)) continue
      seen.add(ref.revisionId)
      const row = await database.encryptedRevisions.get(ref.revisionId)
      if (!row || ref.documentId !== next.control.documentId || row.descriptor.documentId !== ref.documentId || row.descriptor.accountId !== token.accountId) throw new SyncError('INTEGRITY_FAILED')
      const control = await openAccountJson(database, token, ref, PublicationControlSchema)
      if (!sameCipherRefs(row.descriptor.dependencies, [control.baseline, ...(control.recovery ? [control.recovery] : [])])) throw new SyncError('INTEGRITY_FAILED')
      for (const revisionId of row.descriptor.parents) queue.push({ documentId: ref.documentId, revisionId })
      const baseline = await readPublicationPages(database, token, control.baseline, BaselinePageSchema, entry => [entry.seed])
      const seed = baseline.find(entry => entry.kind === 'directory' && entry.shard === shardNumber)
      const record = baseline.find(entry => entry.kind === 'mutable' && entry.key === previous.key)
      if (!seed || !record || record.seed.documentId !== chosen.ref.documentId || !control.recovery) continue
      const shard = await database.encryptedRevisions.get(seed.seed.revisionId)
      if (!shard || shard.descriptor.parents.length !== 2 || shard.descriptor.parents[0] !== authority.branches[0].publication.ref.revisionId) continue
      // Recovery captures the complete effective pre-resolution projection, not arbitrary prepared controls
      const recovery = await readPublicationPages(database, token, control.recovery, RecoveryPageSchema, entry => [entry.ref])
      if (row.descriptor.parents.length !== 1 || !recovery.some(entry => entry.ref.documentId === ref.documentId && entry.ref.revisionId === row.descriptor.parents[0])) throw new SyncError('INTEGRITY_FAILED')
      const beforeHeads = new Map(recovery.map(entry => [entry.ref.documentId, entry.ref.revisionId]))
      const before = await openRemoteProjection(database, token, beforeHeads, next.workspace.head, next.workspace.state.planner.localData.revision)
      const boundaryHeads = new Map(baseline.map(entry => [entry.seed.documentId, entry.seed.revisionId]))
      boundaryHeads.set(ref.documentId, ref.revisionId)
      const boundary = await openRemoteProjection(database, token, boundaryHeads, next.workspace.head, next.workspace.state.planner.localData.revision)
      if (!before || !boundary || boundary.units.get(published!.key)?.body.digest !== published!.body.digest) throw new SyncError('INTEGRITY_FAILED')
      const oldShard = await assertUnchangedMappingContinuation(database, token, before, authority.branches[1].publication)
      if (shard.descriptor.documentId !== oldShard.documentId || JSON.stringify(shard.descriptor.parents) !== JSON.stringify([authority.branches[0].publication.ref.revisionId, oldShard.revisionId])) throw new SyncError('INTEGRITY_FAILED')
      await assertUnchangedPublicationContinuation(database, token, before.units.get(previous.key)!.ref, previous.publication)
      const selected = await readOriginalPublication(database, token, record.seed)
      if (selected.privateKey !== chosen.privateKey || selected.valueKind !== chosen.valueKind || selected.digest !== chosen.digest || JSON.stringify(selected.sourceBookkeeping) !== JSON.stringify(chosen.sourceBookkeeping) || JSON.stringify(selected.parents) !== JSON.stringify([chosen.ref.revisionId])) throw new SyncError('INTEGRITY_FAILED')
      if (JSON.stringify(selected.body) !== JSON.stringify(chosen.body)) await assertEditorTransportBinding(database, token, chosen, selected.body)
      for (const [key, old] of before.units) {
        if (key === previous.key) continue
        const value = boundary.units.get(key)
        if (!value) throw new SyncError('INTEGRITY_FAILED')
        await assertPublicationDescendant(database, token, value.ref, old.ref)
      }
      // Later ordinary edits may differ from the frozen choice, but must descend from this proved boundary
      await assertPublicationDescendant(database, token, current.ref, selected.ref)
      await assertPublicationDescendant(database, token, next.directories.get(shardNumber)!.ref, seed.seed)
      return
    }
  }
  throw new SyncError('INTEGRITY_FAILED')
}

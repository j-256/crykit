import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import type { ProfileToken } from '../profile'
import type { OriginalPublication } from '../../workspace/conflict-authority'
import { openAccountJson } from '../../workspace/account-cache'
import { sameCipherRefs } from '../../workspace/account-retaining'
import { DirectorySchema, DirectoryPageSchema, PublicationControlSchema, BaselinePageSchema } from './publication'
import { assertPublicationDescendant, readPublicationPages, type RemoteProjection } from './projection'
import { assertUnchangedPublicationContinuation } from './conflict-authority'
import { SyncError } from './client'

export async function assertUnchangedMappingContinuation(database: AccountDatabase, token: ProfileToken, remote: RemoteProjection, captured: OriginalPublication): Promise<CipherRef> {
  try {
    const mapping = captured.mapping, original = mapping?.record
    const current = remote.units.get(captured.privateKey), directory = mapping && remote.directories.get(mapping.shard)
    if (!mapping || !original || !current || !directory) throw new Error('Missing mapping context')
    await assertUnchangedPublicationContinuation(database, token, current.ref, original.ref)
    const descriptor = async (ref: CipherRef) => {
      const row = await database.encryptedRevisions.get(ref.revisionId)
      if (!row || row.descriptor.accountId !== token.accountId || row.descriptor.documentId !== ref.documentId) throw new Error('Missing authenticated mapping descriptor')
      return row.descriptor
    }
    // Only the accepted control's actual ancestry can authorize a relocated allocation
    const controls: { ref: CipherRef; value: ReturnType<typeof PublicationControlSchema.parse> }[] = []
    const visitedControls = new Set<string>(), visitingControls = new Set<string>()
    const control = async (ref: CipherRef): Promise<void> => {
      if (ref.documentId !== remote.control.documentId || visitingControls.has(ref.revisionId)) throw new Error('Invalid control ancestry')
      if (visitedControls.has(ref.revisionId)) return
      const value = await openAccountJson(database, token, ref, PublicationControlSchema), row = await descriptor(ref)
      if (!sameCipherRefs(row.dependencies, [value.baseline, ...(value.recovery ? [value.recovery] : [])])) throw new Error('Invalid control dependencies')
      controls.push({ ref, value }); visitingControls.add(ref.revisionId)
      for (const revisionId of row.parents) await control({ documentId: ref.documentId, revisionId })
      visitingControls.delete(ref.revisionId); visitedControls.add(ref.revisionId)
    }
    await control(remote.control)
    const visited = new Set<string>(), visiting = new Set<string>()
    const visit = async (ref: CipherRef): Promise<void> => {
      if (ref.documentId !== captured.ref.documentId || visiting.has(ref.revisionId)) throw new Error('Invalid mapping ancestry')
      if (visited.has(ref.revisionId)) return
      const value = await openAccountJson(database, token, ref, DirectorySchema), row = await descriptor(ref)
      if (value.shard !== mapping.shard || !sameCipherRefs(row.dependencies, [value.index])) throw new Error('Invalid mapping node')
      const entries = await readPublicationPages(database, token, value.index, DirectoryPageSchema, () => [])
      const { directoryShard } = await import('../../workspace/directory')
      if (new Set(entries.map(entry => entry.key)).size !== entries.length || (await Promise.all(entries.map(entry => directoryShard(entry.key)))).some(shard => shard !== mapping.shard)) throw new Error('Invalid mapping membership')
      const allocation = entries.find(entry => entry.key === captured.privateKey)
      if (allocation) {
        if (allocation.documentId !== original.ref.documentId) throw new Error('Changed mapping')
      } else {
        let proven = false
        for (const context of controls.filter(candidate => candidate.value.lineageId === value.lineageId)) {
          const baseline = await readPublicationPages(database, token, context.value.baseline, BaselinePageSchema, entry => [entry.seed])
          const seeds = baseline.filter(entry => entry.kind === 'directory' && entry.shard === mapping.shard)
          const records = baseline.filter(entry => entry.kind !== 'directory' && entry.key === captured.privateKey)
          if (seeds.length !== 1 || records.length !== 1 || records[0].kind !== 'mutable' || records[0].seed.documentId !== original.ref.documentId) continue
          await assertPublicationDescendant(database, token, ref, seeds[0].seed)
          await assertUnchangedPublicationContinuation(database, token, records[0].seed, original.ref)
          proven = true; break
        }
        if (!proven) throw new Error('Unproven relocated allocation')
      }
      if (ref.revisionId !== captured.ref.revisionId) {
        if (!row.parents.length) throw new Error('Missing captured mapping ancestor')
        visiting.add(ref.revisionId)
        // Every path stays unchanged; a changed-and-reverted allocation is new work
        for (const revisionId of row.parents) await visit({ documentId: ref.documentId, revisionId })
        visiting.delete(ref.revisionId)
      }
      visited.add(ref.revisionId)
    }
    await visit(directory.ref)
    return directory.ref
  } catch { throw new SyncError('STALE_CONFLICT_CHOICE') }
}

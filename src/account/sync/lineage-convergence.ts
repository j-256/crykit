import type { ProfileToken } from '../profile'
import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import type { OpenAccountWorkspace } from '../../workspace/account-graph'
import { personalLineageChains } from './lineage'
import { stagePersonalLineage, readPersonalLineage } from './lineage-publication'
import { readOriginalPublication } from './conflict-authority'
import { createWorkspaceConflict } from '../../workspace/conflicts'
import type { ConflictAuthority } from '../../workspace/conflict-authority'
import type { RemoteProjection } from './projection'
import { SyncError } from './client'

export async function comparePersonalLineages(database: AccountDatabase, token: ProfileToken, base: OpenAccountWorkspace, target: OpenAccountWorkspace, remote: RemoteProjection, captured: ReadonlyMap<string, CipherRef>, leafParents: ReadonlyMap<string, CipherRef>, candidates: ReadonlyMap<string, CipherRef>) {
  const baseChains = personalLineageChains(base.state.planner.localData), targetChains = personalLineageChains(target.state.planner.localData)
  const refs = (workspace: OpenAccountWorkspace, chain: readonly { id: string }[] | undefined) => (chain ?? []).map(value => workspace.entries.find(entry => entry.key === JSON.stringify(['personal-definition', value.id]))!.ref)
  const blocked = new Set<string>(), authorities = new Map<string, ConflictAuthority>()
  let retained = remote.workspace.state
  for (const [key, chain] of targetChains) {
    const before = refs(base, baseChains.get(key)), after = refs(target, chain), accepted = remote.lineages.get(key)
    if (JSON.stringify(before) === JSON.stringify(after) || !accepted || JSON.stringify(after) === JSON.stringify(accepted.entries.map(entry => entry.ref))) continue
    let parent = captured.get(key)
    if (!parent && before.length) {
      // Legacy installation is admissible only at an exact initial anchor over the captured accepted leaf
      const leaf = before.at(-1)!
      if (!leafParents.has(leaf.revisionId)) throw new SyncError('HEAD_CONFLICT')
      const seen = new Set<string>(), queue = [accepted.ref]
      while (queue.length) {
        const ref = queue.pop()!
        if (seen.has(ref.revisionId)) continue
        seen.add(ref.revisionId)
        const candidate = await readPersonalLineage(database, token, ref, remote.workspace.readCaptured)
        const record = await database.encryptedRevisions.get(ref.revisionId)
        if (!record || candidate.value.privateKey !== key) throw new SyncError('INTEGRITY_FAILED')
        if (!record.descriptor.parents.length && JSON.stringify(candidate.entries.map(entry => entry.ref)) === JSON.stringify(before)) { parent = ref; break }
        for (const revisionId of record.descriptor.parents) queue.push({ documentId: ref.documentId, revisionId })
      }
    }
    if (before.length && !parent) throw new SyncError('HEAD_CONFLICT')
    if (parent) {
      const original = await readPersonalLineage(database, token, parent, base.readCaptured)
      if (original.value.privateKey !== key || JSON.stringify(original.entries.map(entry => entry.ref)) !== JSON.stringify(before) || parent.documentId !== accepted.ref.documentId) throw new SyncError('INTEGRITY_FAILED')
      if (parent.revisionId === accepted.ref.revisionId) continue
    }
    const mine = await stagePersonalLineage(database, token, target, key, remote.lineageId, parent, accepted.ref.documentId, !parent ? candidates.get(key) : undefined)
    const authority: ConflictAuthority = { version: 1, unit: { kind: 'record', privateKey: key }, lineageId: remote.lineageId, commonAncestor: parent ? { kind: 'present', publication: await readOriginalPublication(database, token, parent) } : { kind: 'absent' }, branches: [{ role: 'local-pending', publication: await readOriginalPublication(database, token, mine.ref) }, { role: 'accepted-cloud', publication: await readOriginalPublication(database, token, accepted.ref) }] }
    const result = await createWorkspaceConflict({ base, local: target, remote: { ...remote.workspace, state: retained }, privateKey: key, authority })
    retained = { ...retained, conflicts: [...retained.conflicts, result.conflict], blobs: result.blobs }
    authorities.set(JSON.stringify(['conflict', result.conflict.id]), authority)
    for (const definition of chain) blocked.add(JSON.stringify(['personal-definition', definition.id]))
  }
  return { retained, authorities, blocked }
}

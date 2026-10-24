import type { OpenAccountWorkspace, AccountWorkspaceEntry } from '../../workspace/account-graph'
import { assembleWorkspace, splitWorkspace } from '../../workspace/documents'
import { blobIdentity } from '../../workspace/blobs'
import type { OriginalPublication } from '../../workspace/conflict-authority'
import { sourceBookkeepingRefs } from '../../workspace/source-bookkeeping'
import { SyncError } from './client'

export async function selectCapturedBranch(local: OpenAccountWorkspace, source: OpenAccountWorkspace, selected: OriginalPublication) {
  const original = { ...await source.readCaptured(selected.body), ...(selected.sourceBookkeeping ? { sourceBookkeeping: selected.sourceBookkeeping } : {}) }
  const documents = new Map(splitWorkspace(local.state).map(document => [document.key, document]))
  const entries = new Map(local.entries.map(entry => [entry.key, entry]))
  const unit = JSON.parse(original.document.key) as string[]
  if (selected.lineage) {
    const { personalLineageChains } = await import('./lineage')
    for (const definition of personalLineageChains(local.state.planner.localData).get(selected.privateKey) ?? []) {
      const key = JSON.stringify(['personal-definition', definition.id]); documents.delete(key); entries.delete(key)
    }
  }
  if (unit[0] === 'build' && original.document.kind === 'tombstone') {
    for (const [key, document] of documents) if (document.kind === 'build-checkpoint' && (document.value as unknown as { buildId: string }).buildId === unit[1]) { documents.delete(key); entries.delete(key) }
  }
  if (original.document.kind === 'tombstone') documents.delete(original.document.key)
  else documents.set(original.document.key, original.document)
  const pending = [...original.dependencies, ...(original.sourceBookkeeping ? sourceBookkeepingRefs(original.sourceBookkeeping) : [])], seen = new Set<string>()
  while (pending.length) {
    const ref = pending.pop()!, identity = blobIdentity(ref)
    if (seen.has(identity)) continue
    seen.add(identity)
    const record = await source.readCaptured(ref)
    if (unit[0] === 'build' && record.document.kind === 'build-checkpoint') {
      const checkpoint = record.document.value as unknown as { buildId: string; revision: number }
      if (checkpoint.buildId === unit[1]) for (const [key, document] of documents) {
        const other = document.value as unknown as { buildId: string; revision: number }
        if (document.kind === 'build-checkpoint' && other.buildId === unit[1] && other.revision === checkpoint.revision && entries.get(key)?.digest !== record.digest) { documents.delete(key); entries.delete(key) }
      }
    }
    const existing = entries.get(record.document.key)
    if (!existing) {
      documents.set(record.document.key, record.document)
      entries.set(record.document.key, { key: record.document.key, kind: record.document.kind, ref, digest: record.digest, ...(record.sourceBookkeeping ? { sourceBookkeeping: record.sourceBookkeeping } : {}), ...(record.retainingIndex ? { retainingIndex: record.retainingIndex } : {}) })
    } else if (['build-checkpoint', 'personal-definition', 'setup', 'catalog', 'source'].includes(record.document.kind) && existing.digest !== record.digest) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
    pending.push(...record.dependencies, ...(record.sourceBookkeeping ? sourceBookkeepingRefs(record.sourceBookkeeping) : []))
  }
  const entry: AccountWorkspaceEntry = { key: original.document.key, kind: original.document.kind, ref: original.ref, digest: original.digest, ...(original.sourceBookkeeping ? { sourceBookkeeping: original.sourceBookkeeping } : {}), ...(original.retainingIndex ? { retainingIndex: original.retainingIndex } : {}) }
  entries.set(entry.key, entry)
  if (unit[0] === 'build') {
    for (const dependent of local.entries) if (dependent.kind === 'team' || dependent.kind === 'scenario') {
      const captured = await local.readCaptured(dependent.ref)
      for (const ref of [...captured.dependencies, ...(captured.sourceBookkeeping ? sourceBookkeepingRefs(captured.sourceBookkeeping) : [])]) {
        const pinned = await local.readCaptured(ref)
        if (pinned.document.kind !== 'build-checkpoint' || (pinned.document.value as unknown as { buildId: string }).buildId !== unit[1]) continue
        const retained = entries.get(pinned.document.key)
        if (!retained || retained.digest !== pinned.digest) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
      }
    }
  }
  try {
    const state = assembleWorkspace([...documents.values()], local.state.planner.localData.revision, local.state.planner.journal)
    const allocations = new Map([...local.allocations, ...source.allocations].map(value => [value.key, value]))
    for (const [key, entry] of entries) allocations.set(key, { key, documentId: entry.ref.documentId })
    const payloads = new Map(await Promise.all([...entries.values()].map(async entry => [entry.key, (await source.readCaptured(entry.ref)).source] as const)))
    return { ...source, state, entries: [...entries.values()], allocations: [...allocations.values()], payloads }
  } catch { throw new SyncError('CONFLICT_DEPENDENCY_IN_USE') }
}

import type { ProfileToken } from '../profile'
import type { PersonalDefinition } from '../../domain/types'
import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import type { OpenAccountWorkspace } from '../../workspace/account-graph'
import { blobIdentity } from '../../workspace/blobs'
import { OriginalPublicationSchema, type OriginalPublication } from '../../workspace/conflict-authority'
import { sourceBookkeepingRefs } from '../../workspace/source-bookkeeping'
import { SyncError } from './client'

// A retained alternative can contain allocations absent from the selected graph; only its exact captured edges authorize them
export async function captureOriginalUnit(source: OpenAccountWorkspace, publication: OriginalPublication): Promise<OpenAccountWorkspace> {
  OriginalPublicationSchema.parse(publication)
  return captureRecords(source, publication.body, publication.privateKey, publication.valueKind, publication.digest, publication.sourceBookkeeping)
}
async function captureRecords(source: OpenAccountWorkspace, body: CipherRef, key: string, kind: string, digest: string, sourceBookkeeping?: OriginalPublication['sourceBookkeeping']): Promise<OpenAccountWorkspace> {
  const root = await source.readCaptured(body)
  if (root.document.key !== key || root.document.kind !== kind || root.digest !== digest) throw new SyncError('INTEGRITY_FAILED')
  const records = new Map<string, typeof root>(), pending = new Set<string>()
  async function visit(ref: CipherRef): Promise<void> {
    const identity = blobIdentity(ref)
    if (pending.has(identity)) throw new SyncError('INTEGRITY_FAILED')
    const record = identity === blobIdentity(body) ? { ...root, ...(sourceBookkeeping ? { sourceBookkeeping } : {}) } : await source.readCaptured(ref)
    const prior = records.get(record.document.key)
    if (prior) {
      if (blobIdentity(prior.ref) !== identity) throw new SyncError('INTEGRITY_FAILED')
      return
    }
    records.set(record.document.key, record); pending.add(identity)
    for (const dependency of [...record.dependencies, ...(record.sourceBookkeeping ? sourceBookkeepingRefs(record.sourceBookkeeping) : [])]) await visit(dependency)
    pending.delete(identity)
  }
  await visit(body)
  const byRef = new Map([...records.values()].map(record => [blobIdentity(record.ref), record]))
  return {
    ...source,
    entries: [...records].map(([key, record]) => ({ key, kind: record.document.kind, ref: record.ref, digest: record.digest })),
    allocations: [...records].map(([key, record]) => ({ key, documentId: record.ref.documentId })),
    readCaptured: async ref => {
      const record = byRef.get(blobIdentity(ref))
      if (!record) throw new SyncError('INTEGRITY_FAILED')
      return record
    },
  }
}

// The frozen anchor, never the active native graph, selects every immutable definition in a stale comparison
export async function captureOriginalLineage(database: AccountDatabase, token: ProfileToken, source: OpenAccountWorkspace, publication: OriginalPublication): Promise<OpenAccountWorkspace> {
  const { readPersonalLineage } = await import('./lineage-publication')
  const { readOriginalPublication } = await import('./conflict-authority')
  if (!publication.lineage || JSON.stringify(await readOriginalPublication(database, token, publication.ref)) !== JSON.stringify(publication)) throw new SyncError('INTEGRITY_FAILED')
  const anchor = await readPersonalLineage(database, token, publication.ref, source.readCaptured)
  const selected = anchor.entries.at(-1)!
  const captured = await captureRecords(source, selected.ref, selected.key, 'personal-definition', selected.digest)
  const definitions: Record<string, PersonalDefinition> = {}
  const entries = captured.entries.filter(entry => entry.kind === 'personal-definition')
  if (entries.length !== anchor.entries.length) throw new SyncError('INTEGRITY_FAILED')
  for (const entry of anchor.entries) {
    if (!entries.some(value => value.key === entry.key && value.digest === entry.digest && blobIdentity(value.ref) === blobIdentity(entry.ref))) throw new SyncError('INTEGRITY_FAILED')
    const definition = (await captured.readCaptured(entry.ref)).document.value as unknown as PersonalDefinition
    definitions[definition.id] = definition
  }
  return { ...captured, state: { ...source.state, planner: { ...source.state.planner, localData: { ...source.state.planner.localData, personalDefinitions: definitions } } } }
}

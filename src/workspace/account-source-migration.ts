import type { ProfileToken } from '../account/profile'
import type { AccountDatabase, CipherRecord, CipherRef, EncryptedSyncState } from '../persistence/account-database'
import type { MappedWorkspaceIntent } from './account-intents'
import { prepareAccountWorkspace, prepareLegacySourceContext, type OpenAccountWorkspace } from './account-graph'
import { cipherRef, stageAccountJson } from './account-cache'
import { archiveWorkspaceUnit } from './pending-content'
import { archiveTypedReferences, inspectLegacyLocalWorkspaceClosure, inspectWorkspaceClosure, validatedWorkspaceRetentionEdges } from './closure'
import { blobIdentity } from './blobs'
import { splitWorkspace, type WorkspaceState, type WorkspaceConflictClosure } from './documents'

// Every source is an exact saved local snapshot; no current remote membership can supply omitted historical edges
export async function prepareSourceEvidenceMigration(database: AccountDatabase, token: ProfileToken, current: CipherRef, snapshots: ReadonlyMap<string, OpenAccountWorkspace>, intents: readonly MappedWorkspaceIntent[]) {
  const enriched = new Map<string, OpenAccountWorkspace>(), records: CipherRecord[] = [], sourceCaptures: EncryptedSyncState[] = []
  for (const [id, snapshot] of snapshots) {
    const prepared = await prepareLegacySourceContext(database, token, snapshot)
    enriched.set(id, prepared.opened); records.push(...prepared.records)
    if (prepared.capture) sourceCaptures.push(prepared.capture)
  }
  let head = current
  for (const [id, snapshot] of enriched) {
    if (snapshot.sourceEvidenceVersion === 1) continue
    let state = snapshot.state
    const blobs = new Map(state.blobs.map(blob => [blobIdentity(blob.ref), blob])), obsolete = new Set<string>()
    async function upgrade(closure: WorkspaceConflictClosure, intent: MappedWorkspaceIntent | undefined, side: 'base' | 'target'): Promise<WorkspaceConflictClosure> {
      try { await inspectWorkspaceClosure(state, closure); return closure } catch { /* Frozen inspection below must independently validate the complete old format */ }
      const old = await inspectLegacyLocalWorkspaceClosure(state, closure)
      const source = intent && enriched.get(intent[side].revisionId)
      const entry = source?.entries.find(entry => entry.key === old.root.key)
      if (!source || !entry || blobIdentity(entry.ref) !== blobIdentity(old.root.ref) || JSON.stringify((await source.readCaptured(entry.ref)).document.value) !== JSON.stringify(old.value)) throw new Error('Original pending source context is unavailable')
      const upgraded = await archiveWorkspaceUnit(source, entry.key, blobs)
      for (const ref of old.refs) obsolete.add(ref)
      return upgraded
    }
    const retainedContent: WorkspaceState['retainedContent'][number][] = []
    for (const content of state.retainedContent) {
      if (content.kind !== 'pending-content') { retainedContent.push(content); continue }
      const matching = intents.filter(intent => intent.portableGroupId === content.groupId)
      if (matching.length > 1) throw new Error('Contradictory original pending source context')
      retainedContent.push({ ...content, base: content.base.kind === 'present' ? { kind: 'present', closure: await upgrade(content.base.closure, matching[0], 'base') } : content.base, target: await upgrade(content.target, matching[0], 'target') })
    }
    state = { ...state, retainedContent, blobs: [...blobs.values()] }
    const edges = await validatedWorkspaceRetentionEdges(state), live = new Set<string>()
    const retain = (ref: import('./documents').WorkspaceBlobRef) => { const id = blobIdentity(ref); if (live.has(id)) return; live.add(id); for (const child of edges.get(id) ?? []) retain(child) }
    for (const document of splitWorkspace(state)) if (document.kind !== 'blob') for (const ref of archiveTypedReferences(document.kind, document.value)) retain(ref)
    // The old root remains an actual descriptor dependency; only its superseded wrapper infrastructure leaves the strict view
    state = { ...state, blobs: state.blobs.filter(blob => !obsolete.has(blobIdentity(blob.ref)) || live.has(blobIdentity(blob.ref))) }
    const prepared = await prepareAccountWorkspace(database, token, state, snapshot)
    records.push(...prepared.records)
    const view = await stageAccountJson(database, token, { version: 1, kind: 'local-source-view', source: snapshot.head, view: prepared.head }, [snapshot.head, prepared.head])
    records.push(view); sourceCaptures.push({ id: `source-view:${snapshot.head.revisionId}`, ref: cipherRef(view) })
    if (id === current.revisionId) head = prepared.head
  }
  return { head, records, sourceCaptures }
}

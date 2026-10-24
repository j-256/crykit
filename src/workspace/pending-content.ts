import { OriginalPublicationSchema, type OriginalPublication, type ConflictSuccessorEvidence } from './conflict-authority'
import { sourceBookkeepingRefs } from './source-bookkeeping'
import { maxDependencies } from '../account/protocol'
import { accountLocalId } from './account-cache'
import type { MappedWorkspaceChange } from './account-intents'
import type { OpenAccountWorkspace } from './account-graph'
import { ARCHIVAL_DOCUMENT_KINDS, archiveTypedReferences, inspectWorkspaceClosure, inspectWorkspaceClosures, type WorkspaceUnitIndex } from './closure'
import { resolvedDomainClosureKeys } from './domain-closure'
import { isBlobSource, type WorkspaceState, type WorkspaceBlobRef, type WorkspaceConflictClosureEntry, type WorkspaceConflictClosure, type WorkspaceRetainedContent } from './documents'
import { memoryBlob, blobIdentity, hashBlob } from './blobs'
import { decodeWorkspaceDocument } from './document-codec'
import { PackagedCatalogPinSchema } from './catalog-codec'
import { INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES } from './directory'

export async function archiveWorkspaceUnit(workspace: OpenAccountWorkspace, key: string, output: Map<string, WorkspaceState['blobs'][number]>, publication?: OriginalPublication, successor?: ConflictSuccessorEvidence): Promise<WorkspaceConflictClosure> {
  return archiveCapturedUnit(await captureArchivalRecords(workspace, key), key, output, publication, successor)
}

// Portable evidence follows the authenticated captured graph, not replacement owner heads in the live projection
async function captureArchivalRecords(workspace: OpenAccountWorkspace, key: string) {
  const root = workspace.entries.find(entry => entry.key === key)
  if (!root) throw new Error('Original pending unit is unavailable')
  const records = new Map<string, Awaited<ReturnType<typeof workspace.readCaptured>>>()
  const pending = new Set<string>()
  const allocations = new Map(workspace.allocations.map(entry => [entry.key, entry.documentId]))
  async function visit(ref: import('../persistence/account-database').CipherRef): Promise<void> {
    const id = blobIdentity(ref)
    if (pending.has(id)) throw new Error('Cyclic captured pending unit')
    const record = await workspace.readCaptured(ref), previous = records.get(record.document.key)
    if (previous) { if (blobIdentity(previous.ref) !== id) throw new Error('Contradictory captured pending unit'); return }
    if (allocations.get(record.document.key) !== ref.documentId) throw new Error('Foreign captured pending allocation')
    records.set(record.document.key, record); pending.add(id)
    for (const dependency of record.dependencies) await visit(dependency)
    if (record.sourceBookkeeping) for (const ref of sourceBookkeepingRefs(record.sourceBookkeeping)) await visit(ref)
    pending.delete(id)
  }
  await visit(root.ref)
  return { documents: new Map([...records].map(([key, record]) => [key, record.document])), allocations: new Map([...records].map(([key, record]) => [key, { ...record, kind: record.document.kind }])), records }
}

async function archiveCapturedUnit(captured: Awaited<ReturnType<typeof captureArchivalRecords>>, key: string, output: Map<string, WorkspaceState['blobs'][number]>, publication?: OriginalPublication, successor?: ConflictSuccessorEvidence): Promise<WorkspaceConflictClosure> {
  const { documents, allocations, records } = captured
  const expansions: WorkspaceBlobRef[] = []
  const entries = new Map<string, WorkspaceConflictClosureEntry>(), keys = new Map<string, WorkspaceBlobRef>(), visiting = new Set<string>()
  async function json(value: unknown, documentId = accountLocalId(), revisionId = accountLocalId()): Promise<WorkspaceBlobRef> {
    const content = memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
    const ref: WorkspaceBlobRef = { documentId, revisionId, byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'utf8' }
    put({ ref, content }); return ref
  }
  function put(blob: WorkspaceState['blobs'][number]) {
    const prior = output.get(blobIdentity(blob.ref))
    if (prior && JSON.stringify(prior.ref) !== JSON.stringify(blob.ref)) throw new Error('Contradictory archived body identity')
    if (!prior) output.set(blobIdentity(blob.ref), blob)
  }
  async function unit(value: WorkspaceUnitIndex): Promise<WorkspaceBlobRef> {
    const ref = await json(value)
    entries.set(blobIdentity(ref), { version: 1, ref, documentVersion: 1, kind: 'unit-index', key: JSON.stringify(['unit-index', blobIdentity(ref)]), encoding: 'json', dependencies: value.roots })
    return ref
  }
  function binary(ref: WorkspaceBlobRef) {
    const saved = records.get(JSON.stringify(['blob', blobIdentity(ref)]))
    if (!saved || !isBlobSource(saved.document.value)) throw new Error('Original pending body is unavailable')
    put({ ref, content: saved.document.value })
    entries.set(blobIdentity(ref), { version: 1, ref, documentVersion: 1, kind: 'blob', key: JSON.stringify(['blob', blobIdentity(ref)]), encoding: 'bytes', dependencies: [] })
  }
  async function visit(key: string): Promise<WorkspaceBlobRef> {
    if (visiting.has(key)) throw new Error('Cyclic pending unit references')
    const known = keys.get(key)
    if (known) return known
    const entry = allocations.get(key), document = documents.get(key)
    if (!entry) throw new Error('Original pending unit is unavailable')
    const kind = entry.kind
    if (!(ARCHIVAL_DOCUMENT_KINDS as readonly string[]).includes(kind)) throw new Error(`Unsupported pending unit kind: ${kind}`)
    const value = document?.value ?? (kind === 'tombstone' ? { version: 1, kind: 'tombstone', privateKey: key } : undefined)
    if (value === undefined || isBlobSource(value)) throw new Error('Pending unit metadata is unavailable')
    visiting.add(key)
    const direct = archiveTypedReferences(kind, value)
    for (const ref of direct) binary(ref)
    const dependencies = [...direct]
    for (const dependency of resolvedDomainClosureKeys({ key, kind, value }, documents, entry.sourceBookkeeping?.scenarioDependencies ?? 'legacy-s02')) dependencies.push(await visit(dependency))
    const payload = records.get(key)?.source
    const decoded = kind === 'catalog' && payload ? await decodeWorkspaceDocument(payload) : undefined
    const pin = decoded?.kind === 'catalog' ? PackagedCatalogPinSchema.safeParse(decoded.value) : undefined
    const materialized = pin?.success === true
    const ref = await json(value, materialized ? `materialized-catalog:${entry.ref.documentId}` : entry.ref.documentId, entry.ref.revisionId)
    if (materialized) {
      if (decoded!.key !== key || await hashBlob(payload!) !== entry.digest) throw new Error('Original catalog pin evidence changed')
      const evidence: WorkspaceBlobRef = { ...entry.ref, byteLength: payload!.byteLength, sha256: entry.digest, encoding: 'bytes' }
      put({ ref: evidence, content: payload! })
      entries.set(blobIdentity(evidence), { version: 1, ref: evidence, documentVersion: 1, kind: 'blob', key: JSON.stringify(['blob', blobIdentity(evidence)]), encoding: 'bytes', dependencies: [] })
      expansions.push(await unit({ version: 1, kind: 'unit-index', roots: [evidence, ref], relation: { kind: 'catalog-expansion', privateKey: key, evidence, materialized: ref, id: pin.data.id, revisionId: pin.data.revisionId, checksum: pin.data.checksum } }))
    }
    const sourceBookkeeping = entry.sourceBookkeeping
    if (sourceBookkeeping) {
      const { version: _version, ...relation } = sourceBookkeeping
      const owner = await visit(sourceBookkeeping.ownerKey)
      if (!owner || owner.documentId !== sourceBookkeeping.owner.documentId || owner.revisionId !== sourceBookkeeping.owner.revisionId) throw new Error('Captured source bookkeeping owner changed')
      const baselineCheckpoints: { key: string; ref: WorkspaceBlobRef }[] = []
      for (const value of sourceBookkeeping.baselineCheckpoints) baselineCheckpoints.push({ key: value.key, ref: await visit(value.key) })
      expansions.push(await unit({ version: 1, kind: 'unit-index', roots: [...new Map([ref, owner, ...baselineCheckpoints.map(value => value.ref)].map(ref => [blobIdentity(ref), ref])).values()], relation: { ...relation, scenario: ref, owner, baselineCheckpoints } }))
    }
    keys.set(key, ref)
    let retained = [...new Map(dependencies.map(ref => [blobIdentity(ref), ref])).values()]
    let retainingIndex: WorkspaceBlobRef | undefined
    if (retained.length > maxDependencies) {
      // The owner backpointer declares identity only; roots are the actual retaining edges
      const relation = { kind: 'retaining-edges' as const, privateKey: key, owner: ref }
      let layer = retained
      do {
        const parents: WorkspaceBlobRef[] = []
        let roots: WorkspaceBlobRef[] = []
        for (const child of layer) {
          const next = { version: 1 as const, kind: 'unit-index' as const, roots: [...roots, child], relation }
          if (next.roots.length > INDEX_PAGE_ENTRIES || new TextEncoder().encode(JSON.stringify(next)).length > INDEX_PAGE_BYTES) {
            if (!roots.length) throw new Error('Retaining edge exceeds page format')
            parents.push(await unit({ ...next, roots })); roots = []
          }
          roots.push(child)
          if (new TextEncoder().encode(JSON.stringify({ ...next, roots })).length > INDEX_PAGE_BYTES) throw new Error('Retaining edge exceeds page format')
        }
        if (roots.length) parents.push(await unit({ version: 1, kind: 'unit-index', roots, relation }))
        layer = parents
      } while (layer.length > 1)
      retainingIndex = layer[0]; retained = [retainingIndex]
    }
    entries.set(blobIdentity(ref), { version: 1, ref, documentVersion: 1, kind, key, encoding: 'json', dependencies: retained, ...(retainingIndex ? { retainingIndex } : {}) })
    visiting.delete(key); return ref
  }
  const primary = await visit(key)
  if (publication) {
    OriginalPublicationSchema.parse(publication)
    const original = records.get(key)!
    if (publication.privateKey !== key || publication.valueKind !== original.document.kind || publication.digest !== original.digest || JSON.stringify(publication.sourceBookkeeping) !== JSON.stringify(original.sourceBookkeeping) || blobIdentity(publication.body) !== blobIdentity(original.ref)) throw new Error('Original publication association mismatch')
    expansions.push(await unit({ version: 1, kind: 'unit-index', roots: [primary], relation: { kind: 'publication-source', publication, body: primary } }))
  }
  if (successor) expansions.push(await unit({ version: 1, kind: 'unit-index', roots: [primary], relation: { ...successor, body: primary } }))
  let children = expansions
  // The primary semantic unit stays singular while pin evidence is retained through bounded compound pages
  while (children.length >= INDEX_PAGE_ENTRIES) {
    const parents: WorkspaceBlobRef[] = []
    for (let at = 0; at < children.length; at += INDEX_PAGE_ENTRIES) parents.push(await unit({ version: 1, kind: 'unit-index', roots: children.slice(at, at + INDEX_PAGE_ENTRIES), relation: { kind: 'page' } }))
    children = parents
  }
  const root = children.length ? await unit({ version: 1, kind: 'unit-index', roots: [primary, ...children], relation: { kind: 'unit', privateKey: key, primary } }) : primary
  async function pages(values: readonly WorkspaceConflictClosureEntry[] | readonly WorkspaceBlobRef[], children: boolean): Promise<WorkspaceBlobRef[]> {
    const result: WorkspaceBlobRef[] = []
    let page = { version: 1, kind: 'conflict-closure-page', entries: [] as WorkspaceConflictClosureEntry[], children: [] as WorkspaceBlobRef[] }
    const full = (value: typeof page) => value.entries.length + value.children.length > INDEX_PAGE_ENTRIES || new TextEncoder().encode(JSON.stringify(value)).length > INDEX_PAGE_BYTES
    for (const value of values) {
      const next = children ? { ...page, children: [...page.children, value as WorkspaceBlobRef] } : { ...page, entries: [...page.entries, value as WorkspaceConflictClosureEntry] }
      if (full(next)) { if (!page.entries.length && !page.children.length) throw new Error('Pending closure entry exceeds page format'); result.push(await json(page)); page = { version: 1, kind: 'conflict-closure-page', entries: [], children: [] } }
      if (children) page.children.push(value as WorkspaceBlobRef); else page.entries.push(value as WorkspaceConflictClosureEntry)
      if (full(page)) throw new Error('Pending closure entry exceeds page format')
    }
    if (page.entries.length || page.children.length) result.push(await json(page))
    return result
  }
  let refs = await pages([...entries.values()], false)
  while (refs.length > 1) refs = await pages(refs, true)
  return { version: 1, root, index: refs[0] }
}

export async function retainPendingUnits(state: WorkspaceState, base: OpenAccountWorkspace, target: OpenAccountWorkspace, groupId: string, changes: readonly MappedWorkspaceChange[]): Promise<WorkspaceState> {
  const blobs = new Map(state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const retained = new Map(state.retainedContent.map(content => [content.id, content]))
  for (const change of changes) {
    if (!(ARCHIVAL_DOCUMENT_KINDS as readonly string[]).includes(change.kind) || ['blob', 'history', 'change'].includes(change.kind)) continue
    const id = `${groupId}:${change.key}`
    if (retained.has(id)) throw new Error('Portable pending identity was reused')
    const before = change.before ? { kind: 'present' as const, closure: await archiveWorkspaceUnit(base, change.key, blobs) } : { kind: 'absent' as const }
    const content: WorkspaceRetainedContent = { version: 1, kind: 'pending-content', id, groupId, unit: { kind: 'record', privateKey: change.key }, base: before, target: await archiveWorkspaceUnit(target, change.key, blobs) }
    retained.set(id, content)
  }
  const result = { ...state, blobs: [...blobs.values()], retainedContent: [...retained.values()] }
  await inspectWorkspaceClosures(result, result.retainedContent.flatMap(content => content.kind === 'pending-content' ? [...(content.base.kind === 'present' ? [content.base.closure] : []), content.target] : []))
  return result
}
export async function retirePendingContent(state: WorkspaceState, groupId: string): Promise<WorkspaceState> {
  // Operational receipts and source snapshots are not portable history; require an independently declared closed representation
  const represented = new Set<string>()
  const identify = async (closure: WorkspaceConflictClosure) => JSON.stringify((await inspectWorkspaceClosure(state, closure)).root.ref)
  for (const value of state.retainedContent) if (value.kind === 'file-history') represented.add(await identify(value.content))
  for (const conflict of state.conflicts) {
    const closures = [...(conflict.commonAncestor.kind === 'present' ? [conflict.commonAncestor.closure] : []), ...conflict.branches.map(value => value.closure), ...(conflict.disposition.kind === 'resolved' ? [conflict.disposition.result] : [])]
    for (const closure of closures) represented.add(await identify(closure))
  }
  const removed = new Set<string>(), retired = new Set<string>()
  for (const content of state.retainedContent) if (content.kind === 'pending-content' && content.groupId === groupId) {
    const closures = [...(content.base.kind === 'present' ? [content.base.closure] : []), content.target]
    const inspected = await Promise.all(closures.map(closure => inspectWorkspaceClosure(state, closure)))
    if (!inspected.every(value => represented.has(JSON.stringify(value.root.ref)))) continue
    removed.add(content.id)
    for (const value of inspected) for (const id of value.refs) retired.add(id)
  }
  if (!removed.size) return state
  const next = { ...state, retainedContent: state.retainedContent.filter(content => !removed.has(content.id)) }
  const { validatedWorkspaceRetentionEdges } = await import('./closure')
  const { splitWorkspace } = await import('./documents')
  const edges = await validatedWorkspaceRetentionEdges(next), live = new Set<string>()
  const retain = (ref: WorkspaceBlobRef) => { const id = blobIdentity(ref); if (live.has(id)) return; live.add(id); for (const child of edges.get(id) ?? []) retain(child) }
  for (const document of splitWorkspace(next)) for (const ref of archiveTypedReferences(document.kind, document.value)) retain(ref)
  // Other pending units and shared history retain their exact bodies before obsolete wrapper infrastructure can leave
  return { ...next, blobs: next.blobs.filter(blob => !retired.has(blobIdentity(blob.ref)) || live.has(blobIdentity(blob.ref))) }
}

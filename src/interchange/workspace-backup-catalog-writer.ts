import { createBackupStaging } from '../workspace/backup-staging'
import { blobIdentity } from '../workspace/blobs'
import { assertOwnedWorkspaceSnapshot, disposeWorkspaceSnapshot, snapshotMetadata, projectWorkspaceSnapshotV1, vectorDigest, type WorkspaceSnapshot, type SnapshotMetadataV3 } from '../workspace/snapshot'
import { capturedBackupEvidence, compareBackupRefs, equalMetadataStreams, historicalEvidenceId, metadataSource, type BackupDocument, type InheritedSnapshotSources } from './workspace-backup-evidence'
import { compactHistoricalIdentity, finishCatalogSnapshot, historicalMemberKey, type HistoricalMemberFormat } from './workspace-backup-catalog'
import { sameCatalogBodyRef } from '../workspace/catalog-reference'

// Each output owns independent encrypted staging; duplicate frames share only within their declared role
// Legacy metadata streams are copied byte-for-byte and never reserialized under the compact identity domain
export async function inheritCatalogSnapshot(current: WorkspaceSnapshot, sources: readonly WorkspaceSnapshot[], options: { readonly signal?: AbortSignal } = {}, inherited?: InheritedSnapshotSources) {
  // Capture public collections and source capabilities before the first asynchronous staging boundary
  const selected = new Set(sources), inputs = [...new Set([current, ...sources])]
  const bind = (source: import('../workspace/documents').BlobSource) => ({ byteLength: source.byteLength, open: source.open.bind(source) })
  const captureBodies = (values: WorkspaceSnapshot['state']['blobs']) => values.map(body => ({ ref: structuredClone(body.ref), content: bind(body.content) }))
  const captured = new Map(inputs.map(input => { const evidence = capturedBackupEvidence(input); return [input, { current: bind(evidence.current), historical: new Map([...evidence.historical].map(([id, content]) => [id, bind(content)])), blobs: captureBodies(evidence.blobs), catalogBodies: captureBodies(evidence.catalogBodies ?? []) }] }))
  if (inherited) inherited = { ...inherited, members: inherited.members.map(member => ({ ...member, subset: structuredClone(member.subset), catalogSubset: member.catalogSubset && structuredClone(member.catalogSubset), metadata: bind(member.metadata) })), bodies: captureBodies(inherited.bodies), catalogBodies: captureBodies(inherited.catalogBodies ?? []) }
  const staging = await createBackupStaging(options.signal)
  let ordinal = 0
  const stage = (source: import('../workspace/documents').BlobSource) => staging.stage(ordinal++, source)
  const members = new Map<string, { format: HistoricalMemberFormat; id: string; content: import('../workspace/documents').BlobSource }>()
  const native = new Map<string, WorkspaceSnapshot['state']['blobs'][number]>(), catalogs = new Map<string, WorkspaceSnapshot['state']['blobs'][number]>()
  const addMember = async (format: HistoricalMemberFormat, content: import('../workspace/documents').BlobSource, claimed?: string) => {
    const id = format === 'legacy-v1' ? await historicalEvidenceId(content) : await compactHistoricalIdentity(content)
    if (claimed !== undefined && claimed !== id) throw new Error('Historical identity mismatch')
    const key = historicalMemberKey({ format, id }), previous = members.get(key)
    if (previous) { if (!await equalMetadataStreams(previous.content, content)) throw new Error('Contradictory historical metadata'); return }
    members.set(key, { format, id, content: await stage(content) })
  }
  const addBodies = async (registry: typeof native, bodies: WorkspaceSnapshot['state']['blobs']) => {
    for (const body of bodies) {
      const key = blobIdentity(body.ref), previous = registry.get(key)
      if (previous && (!sameCatalogBodyRef(previous.ref, body.ref) || !await equalMetadataStreams(previous.content, body.content))) throw new Error('Contradictory retained body')
      if (!previous) registry.set(key, { ref: structuredClone(body.ref), content: await stage(body.content) })
    }
  }
  try {
    for (const input of inputs) {
      await assertOwnedWorkspaceSnapshot(input)
      const evidence = captured.get(input)!
      if (input.version !== 1) for (const member of input.historicalEvidence?.snapshots ?? []) {
        const content = evidence.historical.get(member.id)
        if (!content) throw new Error('Missing historical metadata')
        await addMember('format' in member ? member.format as HistoricalMemberFormat : 'legacy-v1', content, member.id)
      }
      if (selected.has(input)) {
        const format = input.version === 3 ? 'compact-v2' : 'legacy-v1'
        const flat = input.version === 3 ? (() => { const { historicalEvidence: _history, ...value } = snapshotMetadata(input); return value })() : snapshotMetadata(projectWorkspaceSnapshotV1(input))
        await addMember(format, input.version === 1 || input.version === 3 && !input.historicalEvidence ? evidence.current : metadataSource(flat))
      }
      await addBodies(native, evidence.blobs); await addBodies(catalogs, evidence.catalogBodies ?? [])
      await assertOwnedWorkspaceSnapshot(input)
    }
    if (inherited) {
      for (const member of inherited.members) await addMember(member.format ?? 'legacy-v1', member.metadata, member.id)
      await addBodies(native, inherited.bodies); await addBodies(catalogs, inherited.catalogBodies ?? [])
    }
    const ordered = [...members].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, member]) => member)
    const bodies = [...native.values()].sort((a, b) => compareBackupRefs(a.ref, b.ref)), fallbacks = [...catalogs.values()].sort((a, b) => compareBackupRefs(a.ref, b.ref))
    const metadata = snapshotMetadata(current)
    const raw: SnapshotMetadataV3 = current.version === 3 ? metadata as SnapshotMetadataV3 : { ...snapshotMetadata(projectWorkspaceSnapshotV1(current)), version: 3, catalogBodies: [], state: { ...metadata.state, planner: { ...metadata.state.planner, catalogs: current.state.planner.catalogs.map(snapshot => ({ kind: 'inline-catalog' as const, snapshot: snapshot as never })) } } }
    const complete: SnapshotMetadataV3 = { ...raw, historicalEvidence: { version: 2, snapshots: ordered.map(({ format, id }) => ({ format, id })), blobs: bodies.map(body => body.ref), catalogBodies: fallbacks.map(body => ({ ...body.ref, encoding: 'bytes' as const })) } }
    const content = await stage(metadataSource(complete))
    const documents: BackupDocument[] = [
      ...ordered.map(member => ({ key: `historical:${historicalMemberKey(member)}`, encoding: 'deflate-json-tokens-v1' as const, content: member.content })),
      ...bodies.map(body => ({ key: blobIdentity(body.ref), encoding: 'bytes' as const, content: body.content })),
      ...fallbacks.map(body => ({ key: `catalog-body:${blobIdentity(body.ref)}`, encoding: 'bytes' as const, content: body.content })),
    ]
    for (const input of inputs) await assertOwnedWorkspaceSnapshot(input)
    const result = await finishCatalogSnapshot(content, documents, staging, await vectorDigest(current.revisionVector), options.signal, inherited ? { check: () => assertOwnedWorkspaceSnapshot(current), dispose: () => disposeWorkspaceSnapshot(current) } : undefined)
    if (!result.historicalEvidence) throw new Error('Missing inherited catalog evidence')
    return result as typeof result & { readonly historicalEvidence: NonNullable<typeof result.historicalEvidence> }
  } catch (error) { await staging.dispose(); throw error }
}

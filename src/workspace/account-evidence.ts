import { resolveAccountRecord, type AccountPreparationOwner } from './account-prepared-records'
import type { AccountWorkspaceGraphReader } from './account-graph-reader'
import { recordedPartyFloor, validateSourceCheckpoints, type SourceBookkeeping } from './source-bookkeeping'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, CipherRef } from '../persistence/account-database'
import { openAccountSource } from './account-streams'
import { decodeWorkspaceDocument } from './document-codec'
import { decodeCatalogPayload } from './catalog-codec'
import { readAccountRetainingEdges, sameCipherRefs } from './account-retaining'
import { archiveTypedReferences } from './closure'
import { resolvedDomainClosureKeys } from './domain-closure'
import { blobIdentity, hashBlob } from './blobs'
import { isBlobSource, type BlobSource, type WorkspaceBlobRef, type WorkspaceDocument } from './documents'

export interface CapturedWorkspaceRecord {
  readonly ref: CipherRef
  readonly document: WorkspaceDocument
  readonly source: BlobSource
  readonly digest: string
  readonly dependencies: readonly CipherRef[]
  readonly retainingIndex?: CipherRef
  readonly sourceBookkeeping?: SourceBookkeeping
}
export type CapturedRecordReader = (ref: CipherRef) => Promise<CapturedWorkspaceRecord>

export function capturedRecordReader(database: AccountDatabase, token: ProfileToken, known: ReadonlyMap<string, CapturedWorkspaceRecord>, fallback?: CapturedRecordReader, owner?: AccountPreparationOwner, reader?: AccountWorkspaceGraphReader): CapturedRecordReader {
  return async ref => {
    assertActiveProfile(token)
    owner?.check()
    await reader?.beforeRead()
    const captured = known.get(blobIdentity(ref))
    if (captured) return captured
    if (fallback) return fallback(ref)
    const record = reader ? await reader.record(ref) : await resolveAccountRecord(database, token, ref, owner)
    const source = reader ? await reader.source(ref) : await openAccountSource(database, token, ref, owner, record)
    const framed = await decodeWorkspaceDocument(source)
    const document = framed.kind === 'catalog' ? { ...framed, value: decodeCatalogPayload(framed.value) as WorkspaceDocument['value'] } : framed
    let dependencies = record.descriptor.dependencies, retainingIndex: CipherRef | undefined
    if (dependencies.length === 1) {
      const child = reader ? await reader.source(dependencies[0]) : await openAccountSource(database, token, dependencies[0], owner)
      let first: number | undefined
      for await (const chunk of child.open()) { if (chunk.length) { first = chunk[0]; break } }
      // Only an unframed authenticated control envelope can be a retaining page, never imported framed bytes
      if (first === 0x7b) {
        retainingIndex = dependencies[0]
        dependencies = [...await readAccountRetainingEdges(database, token, document.key, retainingIndex, owner, reader)]
      }
    }
    return { ref, document, source, digest: await hashBlob(source), dependencies, ...(retainingIndex ? { retainingIndex } : {}) }
  }
}

export async function validateCapturedWorkspaceRecords(read: CapturedRecordReader, roots: readonly CipherRef[], allocations: ReadonlyMap<string, string>, retained: ReadonlyMap<string, readonly WorkspaceBlobRef[]>, legacyLocal = false, reader?: AccountWorkspaceGraphReader): Promise<void> {
  const heights = new Map<string, number>(), pending = new Set<string>()
  async function visit(ref: CipherRef, depth = 0): Promise<number> {
    reader?.depth(depth)
    const id = blobIdentity(ref)
    if (pending.has(id)) throw new Error('Cyclic captured workspace evidence')
    // A shared child can be reached along a deeper path after its first validation
    const priorHeight = heights.get(id)
    if (priorHeight !== undefined) { reader?.depth(depth + priorHeight); return priorHeight }
    let height = 0
    async function childHeight(ref: CipherRef): Promise<void> { height = Math.max(height, 1 + await visit(ref, depth + 1)) }
    const record = await read(ref), document = record.document
    if (allocations.get(document.key) !== ref.documentId) throw new Error('Foreign captured workspace allocation')
    pending.add(id)
    reader?.reserve(record.dependencies)
    if (record.dependencies.length) reader?.depth(depth + 1)
    const children: CapturedWorkspaceRecord[] = []
    for (const dependency of record.dependencies) children.push(await read(dependency))
    const documents = new Map([[document.key, document]])
    const bindings = new Map<string, CapturedWorkspaceRecord>()
    for (const child of children) {
      if (bindings.has(child.document.key)) throw new Error('Contradictory captured semantic key')
      documents.set(child.document.key, child.document); bindings.set(child.document.key, child)
    }
    const expected: CipherRef[] = []
    const exact = document.kind === 'blob' ? retained.get((JSON.parse(document.key) as string[])[1]) ?? [] : archiveTypedReferences(document.kind, document.value)
    for (const ref of exact) {
      const child = bindings.get(JSON.stringify(['blob', blobIdentity(ref)]))
      if (!child || !isBlobSource(child.document.value) || child.document.value.byteLength !== ref.byteLength || await hashBlob(child.document.value) !== ref.sha256) throw new Error('Missing or mismatched captured body')
      expected.push(child.ref)
    }
    for (const key of resolvedDomainClosureKeys(document, documents, record.sourceBookkeeping?.scenarioDependencies ?? 'legacy-s02')) {
      const child = bindings.get(key)
      if (!child) throw new Error('Missing captured domain evidence')
      expected.push(child.ref)
    }
    if (document.kind === 'scenario') {
      const ownerKey = JSON.stringify(['playthrough', (JSON.parse(document.key) as string[])[1]])
      const owner = record.sourceBookkeeping ? await read(record.sourceBookkeeping.owner) : bindings.get(ownerKey)
      const value = document.value as unknown as { baseline: { kind: string } }
      if (value.baseline.kind === 'recordedParty' && !record.sourceBookkeeping && !legacyLocal) throw new Error('Missing recorded-party source evidence')
      if (value.baseline.kind === 'recordedParty' && record.sourceBookkeeping) {
        if (!owner) throw new Error('Missing recorded-party captured owner')
        recordedPartyFloor(record, owner, record.sourceBookkeeping)
        const checkpoints = await Promise.all(record.sourceBookkeeping.baselineCheckpoints.map(value => read(value.ref)))
        validateSourceCheckpoints(record.sourceBookkeeping, record, checkpoints)
        for (const checkpoint of checkpoints) await childHeight(checkpoint.ref)
        await childHeight(owner.ref)
      } else if (record.sourceBookkeeping) throw new Error('Unexpected source bookkeeping')
    } else if (record.sourceBookkeeping) throw new Error('Unexpected source bookkeeping')
    const unique = [...new Map(expected.map(ref => [blobIdentity(ref), ref])).values()]
    if (!sameCipherRefs(record.dependencies, unique)) throw new Error('Captured workspace retaining edges mismatch')
    for (const child of children) await childHeight(child.ref)
    reader?.depth(depth + height)
    pending.delete(id); heights.set(id, height)
    return height
  }
  for (const root of roots) await visit(root)
}

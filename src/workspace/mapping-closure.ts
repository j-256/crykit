import { z } from 'zod'
import { OriginalPublicationSchema, type OriginalPublication } from './conflict-authority'
import { CipherRefSchema, accountLocalId } from './account-cache'
import { WorkspaceBlobRefSchema } from './file-schemas'
import { buildIndexPages, INDEX_PAGE_BYTES, directoryShard } from './directory'
import type { WorkspaceBlobRef, WorkspaceConflictClosure, WorkspaceConflictClosureEntry, WorkspaceState, BlobSource } from './documents'
import { blobIdentity, hashBlob, memoryBlob, readBlob } from './blobs'
import { validateMappingContext } from './mapping-context'

const closure = z.strictObject({ version: z.literal(1), root: WorkspaceBlobRefSchema, index: WorkspaceBlobRefSchema })
export const MappingRelationSchema = z.strictObject({ kind: z.literal('directory-mapping'), privateKey: z.string(), shard: z.number().int().min(0).max(63), publication: OriginalPublicationSchema, frames: WorkspaceBlobRefSchema, content: closure.optional() })
export const MappingFrameRelationSchema = z.strictObject({ kind: z.literal('mapping-frame'), source: CipherRefSchema, body: WorkspaceBlobRefSchema })
export type MappingRelation = z.infer<typeof MappingRelationSchema>
export const mappingRoots = (relation: MappingRelation) => [relation.frames, ...(relation.content ? [relation.content.root, relation.content.index] : [])]
export async function archiveMappingEvidence(publication: OriginalPublication, frames: readonly { source: z.infer<typeof CipherRefSchema>; content: BlobSource }[], content: WorkspaceConflictClosure | undefined, blobs: Map<string, WorkspaceState['blobs'][number]>): Promise<WorkspaceConflictClosure> {
  if (!publication.mapping || Boolean(publication.mapping.record) !== Boolean(content)) throw new Error('Mapping content role mismatch')
  const entries = new Map<string, WorkspaceConflictClosureEntry>()
  const store = async (content: BlobSource, encoding: WorkspaceBlobRef['encoding']) => {
    // Raw publication frames receive separate archival identities; their source associations stay explicit and inert
    const ref: WorkspaceBlobRef = { documentId: accountLocalId(), revisionId: accountLocalId(), byteLength: content.byteLength, sha256: await hashBlob(content), encoding }
    blobs.set(blobIdentity(ref), { ref, content }); return ref
  }
  const json = (value: unknown) => store(memoryBlob(new TextEncoder().encode(JSON.stringify(value))), 'utf8')
  const unit = async (roots: readonly WorkspaceBlobRef[], relation: unknown) => {
    const ref = await json({ version: 1, kind: 'unit-index', roots, relation })
    if (ref.byteLength > INDEX_PAGE_BYTES) throw new Error('Mapping unit exceeds page bound')
    entries.set(blobIdentity(ref), { version: 1, ref, documentVersion: 1, kind: 'unit-index', key: JSON.stringify(['unit-index', blobIdentity(ref)]), encoding: 'json', dependencies: roots })
    return ref
  }
  const frameRoots = []
  for (const frame of frames) {
    const body = await store(frame.content, 'bytes')
    entries.set(blobIdentity(body), { version: 1, ref: body, documentVersion: 1, kind: 'blob', key: JSON.stringify(['blob', blobIdentity(body)]), encoding: 'bytes', dependencies: [] })
    frameRoots.push(await unit([body], { kind: 'mapping-frame', source: frame.source, body }))
  }
  const fullRef = (ref: { documentId: string; revisionId: string }) => blobs.get(blobIdentity(ref))!.ref
  const frameIndex = fullRef(await buildIndexPages(frameRoots, page => unit([...page.entries, ...page.children.map(fullRef)], { kind: 'page' })))
  const relation = MappingRelationSchema.parse({ kind: 'directory-mapping', privateKey: publication.privateKey, shard: publication.mapping.shard, publication, frames: frameIndex, ...(content ? { content } : {}) })
  const root = await unit(mappingRoots(relation), relation)
  const index = await buildIndexPages([...entries.values()], page => json({ ...page, children: page.children.map(fullRef), kind: 'conflict-closure-page' }))
  return { version: 1, root, index: fullRef(index) }
}
export async function inspectMappingFrames(relation: MappingRelation, entries: ReadonlyMap<string, WorkspaceConflictClosureEntry>, root: WorkspaceBlobRef, get: (ref: WorkspaceBlobRef) => BlobSource, parseUnit: (ref: WorkspaceBlobRef) => Promise<{ roots: WorkspaceBlobRef[]; relation: unknown }>): Promise<void> {
  const { DirectorySchema, DirectoryPageSchema, PublicationControlSchema, BaselinePageSchema } = await import('../account/sync/publication')
  const visited = new Set([blobIdentity(root)]), frames = new Map<string, { bytes: Uint8Array; value: unknown }>()
  const visit = async (ref: WorkspaceBlobRef): Promise<void> => {
    const id = blobIdentity(ref), entry = entries.get(id)
    if (visited.has(id) || !entry || entry.kind !== 'unit-index' || entry.encoding !== 'json' || entry.retainingIndex || entry.key !== JSON.stringify(['unit-index', id])) throw new Error('Invalid mapping source page')
    visited.add(id)
    const value = await parseUnit(ref), same = (refs: readonly WorkspaceBlobRef[]) => JSON.stringify(entry.dependencies) === JSON.stringify(refs)
    if (ref.byteLength > INDEX_PAGE_BYTES || !same(value.roots)) throw new Error('Mapping source page edges mismatch')
    const frame = MappingFrameRelationSchema.safeParse(value.relation)
    if (frame.success) {
      const body = frame.data.body, item = entries.get(blobIdentity(body)), sourceId = blobIdentity(frame.data.source)
      if (value.roots.length !== 1 || JSON.stringify(value.roots[0]) !== JSON.stringify(body) || !item || item.kind !== 'blob' || item.encoding !== 'bytes' || item.dependencies.length || frames.has(sourceId) || visited.has(blobIdentity(body))) throw new Error('Mapping source frame mismatch')
      visited.add(blobIdentity(body))
      const bytes = await readBlob(get(body), INDEX_PAGE_BYTES)
      if (await hashBlob(memoryBlob(bytes)) !== body.sha256) throw new Error('Mapping original frame digest mismatch')
      frames.set(sourceId, { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) })
    } else {
      z.strictObject({ kind: z.literal('page') }).parse(value.relation)
      for (const child of value.roots) await visit(child)
    }
  }
  await visit(relation.frames)
  if (visited.size !== entries.size) throw new Error('Unrelated mapping evidence')
  const publication = relation.publication, mapping = publication.mapping
  if (!mapping || publication.privateKey !== relation.privateKey || mapping.shard !== relation.shard || relation.shard !== await directoryShard(relation.privateKey)) throw new Error('Mapping original association mismatch')
  const original = frames.get(blobIdentity(publication.ref))
  if (!original || await hashBlob(memoryBlob(original.bytes)) !== publication.digest) throw new Error('Missing exact mapping original')
  const directory = DirectorySchema.parse(original.value)
  if (directory.shard !== relation.shard || directory.lineageId !== publication.lineageId || JSON.stringify(directory.index) !== JSON.stringify(mapping.index)) throw new Error('Wrong mapping directory role')
  const used = new Set([blobIdentity(publication.ref)]), allocations = new Map<string, string>()
  const page = (ref: z.infer<typeof CipherRefSchema>) => {
    const id = blobIdentity(ref), frame = frames.get(id)
    if (!frame || used.has(id)) throw new Error('Missing or cyclic mapping original pages')
    used.add(id)
    const value = DirectoryPageSchema.parse(frame.value)
    for (const entry of value.entries) { if (allocations.has(entry.key)) throw new Error('Contradictory mapping key'); allocations.set(entry.key, entry.documentId) }
    for (const child of value.children) page(child)
  }
  page(directory.index)
  if (mapping.context) {
    const context = mapping.context, source = frames.get(blobIdentity(context.control.ref))
    if (!source || used.has(blobIdentity(context.control.ref)) || await hashBlob(memoryBlob(source.bytes)) !== context.control.digest) throw new Error('Mapping control source mismatch')
    used.add(blobIdentity(context.control.ref))
    const control = PublicationControlSchema.parse(source.value), baseline: import('../account/sync/publication').PublicationBaselineEntry[] = []
    const baselinePage = (ref: z.infer<typeof CipherRefSchema>) => {
      const id = blobIdentity(ref), frame = frames.get(id)
      if (!frame || used.has(id)) throw new Error('Missing or cyclic mapping baseline')
      used.add(id)
      const value = BaselinePageSchema.parse(frame.value)
      baseline.push(...value.entries)
      for (const child of value.children) baselinePage(child)
    }
    baselinePage(control.baseline)
    validateMappingContext(publication, directory, [...allocations].map(([key, documentId]) => ({ key, documentId })), control, baseline)
  } else if (mapping.record ? allocations.get(relation.privateKey) !== mapping.record.ref.documentId : allocations.has(relation.privateKey)) throw new Error('Mapping allocation evidence mismatch')
  if (used.size !== frames.size) throw new Error('Unrelated mapping frames')
  for (const key of allocations.keys()) if (await directoryShard(key) !== relation.shard) throw new Error('Foreign mapping shard membership')
}

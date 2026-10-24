import { MappingRelationSchema, MappingFrameRelationSchema, mappingRoots, inspectMappingFrames, type MappingRelation } from './mapping-closure'
import { PersonalLineageRelationSchema, validatePersonalLineage, type PersonalLineageRelation } from './lineage-closure'
import { BuildCopyRelationSchema, buildCopyRoots, validateBuildCopy, assertBuildCopyOriginals, type BuildCopyInspection } from './build-copy'
import { OriginalPublicationSchema, ConflictSuccessorEvidenceSchema, type ConflictSuccessorEvidence, type OriginalPublication } from './conflict-authority'
import { workspaceDocumentSource } from './document-codec'
import { z } from 'zod'
import { TEAM_SIZE } from '../domain/scenarios'
import { SourceBookkeepingSchema, validateSourceBookkeeping, validateSourceCheckpoints } from './source-bookkeeping'
import { maxDocumentBytes } from '../account/protocol'
import { parseBoundedJson, NATIVE_BACKUP_JSON_LIMITS } from '../interchange/json'
import { blobIdentity, hashBlob, readBlob } from './blobs'
import { splitWorkspace, type WorkspaceState, type BlobSource, type WorkspaceDocument, type WorkspaceBlobRef, type WorkspaceConflictClosure, type WorkspaceConflictClosureEntry } from './documents'
import { INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES } from './directory'
import { EditorWorkspaceDocumentSchema, SaveWorkspaceDocumentSchema, WorkspaceAssetSchema, WorkspaceBlobRefSchema, WorkspaceConflictSchema, WorkspaceRetainedContentSchema } from './file-schemas'
import { resolvedDomainClosureKeys } from './domain-closure'
import { decodeWorkspaceDocument } from './document-codec'
import { PackagedCatalogPinSchema } from './catalog-codec'
import { validateWorkspace } from './validation'

// Archive kinds are an allowlist: control, operational commands and conflict indexes never masquerade as domain units
export const ARCHIVAL_DOCUMENT_KINDS = ['workspace-preferences', 'build', 'build-checkpoint', 'team', 'team-checkpoint', 'playthrough', 'character', 'progress', 'goal', 'scenario', 'inventory', 'quintar-breeding', 'personal-definition', 'setup', 'catalog', 'source', 'evidence', 'import-receipt', 'history', 'change', 'skill-layout', 'skill-capture', 'reference-preferences', 'library-defaults', 'editor', 'save', 'asset', 'blob', 'directory', 'directory-page', 'tombstone', 'unit-index', 'directory-mapping-unit'] as const
const entrySchema = z.object({ version: z.literal(1), ref: WorkspaceBlobRefSchema, documentVersion: z.literal(1), kind: z.enum(ARCHIVAL_DOCUMENT_KINDS), key: z.string().min(1), encoding: z.enum(['json', 'bytes']), dependencies: z.array(WorkspaceBlobRefSchema), retainingIndex: WorkspaceBlobRefSchema.optional() }).strict()
const pageSchema = z.object({ version: z.literal(1), kind: z.literal('conflict-closure-page'), entries: z.array(entrySchema), children: z.array(WorkspaceBlobRefSchema) }).strict().refine(value => value.entries.length + value.children.length <= INDEX_PAGE_ENTRIES)
const directorySchema = z.object({ version: z.literal(1), kind: z.literal('directory'), shard: z.number().int().min(0).max(63), entries: z.array(z.object({ key: z.string(), documentId: z.string() }).strict()), children: z.array(WorkspaceBlobRefSchema) }).strict().refine(value => value.entries.length + value.children.length <= INDEX_PAGE_ENTRIES)
const mappingSchema = z.object({ version: z.literal(1), kind: z.literal('directory-mapping-unit'), privateKey: z.string(), shard: z.number().int().min(0).max(63), shardEvidence: WorkspaceBlobRefSchema, allocation: z.discriminatedUnion('kind', [z.object({ kind: z.literal('absent') }).strict(), z.object({ kind: z.literal('present'), sourceDocumentId: z.string(), valueRoot: WorkspaceBlobRefSchema }).strict()]) }).strict()
export const WorkspaceUnitIndexSchema = z.object({ version: z.literal(1), kind: z.literal('unit-index'), roots: z.array(WorkspaceBlobRefSchema).max(INDEX_PAGE_ENTRIES), relation: z.discriminatedUnion('kind', [MappingRelationSchema, MappingFrameRelationSchema, PersonalLineageRelationSchema, BuildCopyRelationSchema, z.object({ kind: z.literal('unit'), privateKey: z.string(), primary: WorkspaceBlobRefSchema }).strict(), z.object({ kind: z.literal('catalog-expansion'), privateKey: z.string(), evidence: WorkspaceBlobRefSchema, materialized: WorkspaceBlobRefSchema, id: z.string(), revisionId: z.string(), checksum: z.string() }).strict(), SourceBookkeepingSchema.omit({ version: true }).extend({ scenario: WorkspaceBlobRefSchema, owner: WorkspaceBlobRefSchema, baselineCheckpoints: SourceBookkeepingSchema.shape.baselineCheckpoints.element.extend({ ref: WorkspaceBlobRefSchema }).array().max(TEAM_SIZE) }).strict(), ConflictSuccessorEvidenceSchema.extend({ body: WorkspaceBlobRefSchema }), z.object({ kind: z.literal('publication-source'), publication: OriginalPublicationSchema, body: WorkspaceBlobRefSchema }).strict(), z.object({ kind: z.literal('page') }).strict(), z.object({ kind: z.literal('retaining-edges'), privateKey: z.string(), owner: WorkspaceBlobRefSchema }).strict()]) }).strict()
export type WorkspaceUnitIndex = z.infer<typeof WorkspaceUnitIndexSchema>
function sameRefs(left: readonly WorkspaceBlobRef[], right: readonly WorkspaceBlobRef[]) {
  const canonical = (refs: readonly WorkspaceBlobRef[]) => [...new Map(refs.map(ref => [blobIdentity(ref), JSON.stringify([ref.documentId, ref.revisionId, ref.byteLength, ref.sha256, ref.encoding])])).values()].sort()
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}
export function archiveTypedReferences(kind: WorkspaceDocument['kind'], value: unknown): readonly WorkspaceBlobRef[] {
  if (kind === 'editor') { const file = EditorWorkspaceDocumentSchema.parse(value); return [file.original, file.lastApplied, file.unfinished.text] }
  if (kind === 'save') { const file = SaveWorkspaceDocumentSchema.parse(value); return [file.original, file.working] }
  if (kind === 'asset') { const file = WorkspaceAssetSchema.parse(value); return [file.original, ...(file.thumbnail ? [file.thumbnail] : [])] }
  if (kind === 'source') return [WorkspaceBlobRefSchema.parse((value as { original: unknown }).original)]
  if (kind === 'conflict') {
    const conflict = WorkspaceConflictSchema.parse(value)
    const closures = [...(conflict.commonAncestor.kind === 'present' ? [conflict.commonAncestor.closure] : []), ...conflict.branches.map(branch => branch.closure), ...(conflict.disposition.kind === 'resolved' ? [conflict.disposition.result] : [])]
    return closures.flatMap(closure => [closure.root, closure.index])
  }
  if (kind === 'retained-content') {
    const retained = WorkspaceRetainedContentSchema.parse(value)
    const closures = retained.kind === 'file-history' ? [retained.content] : [...(retained.base.kind === 'present' ? [retained.base.closure] : []), retained.target]
    return closures.flatMap(closure => [closure.root, closure.index])
  }
  if (kind === 'directory' || kind === 'directory-page') return directorySchema.parse(value).children
  if (kind === 'unit-index') return WorkspaceUnitIndexSchema.parse(value).roots
  if (kind === 'directory-mapping-unit') { const unit = mappingSchema.parse(value); return [unit.shardEvidence, ...(unit.allocation.kind === 'present' ? [unit.allocation.valueRoot] : [])] }
  return []
}

// A validation pass can encounter the same large catalog body through several independent units
// Reuse parsing only for its exact body/source binding; each unit still validates its own edges,
// identities and authority, and a later validation invocation reads and hashes everything again
type ParsedClosureBodies = WeakMap<BlobSource, { open: BlobSource['open']; byteLength: number; values: Map<string, Promise<ReturnType<typeof parseBoundedJson>>> }>
async function closureJson(ref: WorkspaceBlobRef, source: BlobSource, limit: number, parsed: ParsedClosureBodies): Promise<ReturnType<typeof parseBoundedJson>> {
  if (ref.byteLength > limit || source.byteLength > limit) throw new Error('Retained workspace content exceeds its bound')
  let cached = parsed.get(source)
  if (cached && (cached.open !== source.open || cached.byteLength !== source.byteLength)) throw new Error('Closure body source changed during validation')
  if (!cached) { cached = { open: source.open, byteLength: source.byteLength, values: new Map() }; parsed.set(source, cached) }
  const key = JSON.stringify([ref.documentId, ref.revisionId, ref.byteLength, ref.sha256, ref.encoding])
  let value = cached.values.get(key)
  if (!value) { value = readBlob(source, limit).then(bytes => parseBoundedJson(bytes, 'retained workspace content', NATIVE_BACKUP_JSON_LIMITS)); cached.values.set(key, value) }
  return value
}

async function inspectClosure(state: WorkspaceState, closure: WorkspaceConflictClosure, legacyLocal = false, parsed: ParsedClosureBodies = new WeakMap()): Promise<{ refs: ReadonlySet<string>; root: WorkspaceConflictClosureEntry; value: unknown; edges: ReadonlyMap<string, readonly WorkspaceBlobRef[]>; publication?: OriginalPublication; supersedes?: ConflictSuccessorEvidence; documents: ReadonlyMap<string, WorkspaceDocument>; buildCopy?: BuildCopyInspection; lineage?: PersonalLineageRelation; mapping?: MappingRelation }> {
  const registry = new Map(state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const refs = new Set<string>()
  const entries = new Map<string, WorkspaceConflictClosureEntry>()
  const edges = new Map<string, readonly WorkspaceBlobRef[]>()
  const pending = new Set<string>()
  const pages = new Set<string>()
  const get = (ref: WorkspaceBlobRef) => {
    const blob = registry.get(blobIdentity(ref))
    if (!blob || !sameRefs([blob.ref], [ref])) throw new Error('Missing or foreign closure reference')
    refs.add(blobIdentity(ref)); return blob.content
  }
  const json = async (ref: WorkspaceBlobRef, limit: number) => closureJson(ref, get(ref), limit, parsed)
  async function page(ref: WorkspaceBlobRef): Promise<void> {
    const id = blobIdentity(ref)
    if (pending.has(id)) throw new Error('Cyclic closure pages')
    if (pages.has(id)) return
    pending.add(id)
    const value = pageSchema.parse(await json(ref, INDEX_PAGE_BYTES))
    edges.set(id, [...value.children, ...value.entries.map(entry => entry.ref)])
    for (const entry of value.entries) {
      const key = blobIdentity(entry.ref), previous = entries.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error('Contradictory closure entry')
      entries.set(key, entry)
    }
    for (const child of value.children) await page(child)
    pending.delete(id); pages.add(id)
  }
  await page(closure.index)
  const declaredRoot = entries.get(blobIdentity(closure.root))
  if (declaredRoot?.kind === 'unit-index') {
    const index = WorkspaceUnitIndexSchema.parse(await json(closure.root, INDEX_PAGE_BYTES))
    if (index.relation.kind === 'directory-mapping') {
      const relation = index.relation, roots = mappingRoots(relation)
      if (!sameRefs([declaredRoot.ref], [closure.root]) || declaredRoot.key !== JSON.stringify(['unit-index', blobIdentity(closure.root)]) || declaredRoot.encoding !== 'json' || declaredRoot.retainingIndex || !sameRefs(index.roots, roots) || !sameRefs(declaredRoot.dependencies, roots)) throw new Error('Invalid closed mapping structure')
      await inspectMappingFrames(relation, entries, closure.root, get, async ref => WorkspaceUnitIndexSchema.parse(await json(ref, INDEX_PAGE_BYTES)))
      for (const entry of entries.values()) { get(entry.ref); edges.set(blobIdentity(entry.ref), entry.dependencies) }
      if (relation.content) {
        const nested = await json(relation.content.root, maxDocumentBytes) as { kind?: string; relation?: { kind?: string } }
        if (nested.kind === 'unit-index' && nested.relation?.kind !== 'unit') throw new Error('Mapping value must be an ordinary semantic unit')
        const content = await inspectClosure(state, relation.content, legacyLocal, parsed)
        if (content.root.key !== relation.privateKey || JSON.stringify(content.publication) !== JSON.stringify(relation.publication.mapping?.record)) throw new Error('Mapping content association mismatch')
        for (const ref of content.refs) refs.add(ref)
        for (const [id, children] of content.edges) edges.set(id, children)
        return { ...content, refs, edges, mapping: relation, publication: relation.publication }
      }
      if (relation.publication.mapping?.record) throw new Error('Mapping value evidence missing')
      return { refs, root: declaredRoot, value: { allocation: 'absent' }, edges, documents: new Map(), mapping: relation, publication: relation.publication }
    }
    if (index.relation.kind === 'personal-lineage') {
      const relation = index.relation, roots = [relation.content.root, relation.content.index]
      if (entries.size !== 1 || !sameRefs([declaredRoot.ref], [closure.root]) || declaredRoot.key !== JSON.stringify(['unit-index', blobIdentity(closure.root)]) || declaredRoot.encoding !== 'json' || declaredRoot.retainingIndex || !sameRefs(index.roots, roots) || !sameRefs(declaredRoot.dependencies, roots)) throw new Error('Invalid closed personal lineage structure')
      const nested = await json(relation.content.root, maxDocumentBytes) as { kind?: string; relation?: { kind?: string } }
      if (nested.kind === 'unit-index' && nested.relation?.kind !== 'unit' || blobIdentity(relation.content.root) === blobIdentity(closure.root) || blobIdentity(relation.content.index) === blobIdentity(closure.index)) throw new Error('Personal lineage requires an ordinary selected chain')
      const result = await inspectClosure(state, relation.content, legacyLocal, parsed)
      await validatePersonalLineage(relation, result)
      edges.set(blobIdentity(closure.root), roots)
      for (const ref of result.refs) refs.add(ref)
      for (const [id, children] of result.edges) edges.set(id, children)
      return { ...result, refs, edges, lineage: relation, ...(relation.publication ? { publication: relation.publication } : {}), ...(relation.supersedes ? { supersedes: relation.supersedes } : {}) }
    }
    if (index.relation.kind === 'build-copy') {
      const relation = index.relation
      if (entries.size !== 1 || declaredRoot.key !== JSON.stringify(['unit-index', blobIdentity(closure.root)]) || !sameRefs([declaredRoot.ref], [closure.root]) || declaredRoot.encoding !== 'json' || declaredRoot.retainingIndex || !sameRefs(index.roots, buildCopyRoots(relation)) || !sameRefs(declaredRoot.dependencies, index.roots)) throw new Error('Invalid closed Build copy structure')
      const inputs = [relation.kept, relation.copy, relation.source]
      // Nested inputs must be ordinary units, so recursive copy containers and cycles cannot enter this role
      for (const input of inputs) {
        const value = await json(input.root, maxDocumentBytes) as { kind?: string; relation?: { kind?: string } }
        if (value.kind === 'unit-index' && value.relation?.kind !== 'unit') throw new Error('Build copy requires ordinary nested units')
        if (blobIdentity(input.root) === blobIdentity(closure.root) || blobIdentity(input.index) === blobIdentity(closure.index)) throw new Error('Cyclic Build copy')
      }
      const [kept, copy, source] = await Promise.all(inputs.map(input => inspectClosure(state, input, legacyLocal, parsed)))
      const buildCopy = validateBuildCopy(relation, kept, copy, source)
      edges.set(blobIdentity(closure.root), index.roots)
      for (const result of [kept, copy, source]) {
        for (const ref of result.refs) refs.add(ref)
        for (const [id, children] of result.edges) { const previous = edges.get(id); if (previous && !sameRefs(previous, children)) throw new Error('Contradictory Build copy edges'); edges.set(id, children) }
      }
      return { refs, root: kept.root, value: kept.value, edges, documents: new Map([...kept.documents, ...copy.documents]), buildCopy }
    }
  }
  const metadata = new Map<string, WorkspaceDocument>(), metadataByRef = new Map<string, WorkspaceDocument>()
  for (const entry of entries.values()) if (entry.encoding === 'json') {
    const document: WorkspaceDocument = { version: 1, key: entry.key, kind: entry.kind, value: await json(entry.ref, maxDocumentBytes) }
    metadataByRef.set(blobIdentity(entry.ref), document)
    if (entry.kind !== 'directory-mapping-unit' && entry.kind !== 'unit-index') {
      if (metadata.has(entry.key)) throw new Error('Contradictory typed unit identity')
      metadata.set(entry.key, document)
    }
  }
  const sourceContexts = new Map<string, Extract<WorkspaceUnitIndex['relation'], { kind: 'recorded-party-source' }>>()
  for (const document of metadataByRef.values()) if (document.kind === 'unit-index') {
    const relation = WorkspaceUnitIndexSchema.parse(document.value).relation
    if (relation.kind === 'recorded-party-source') { if (sourceContexts.has(relation.scenarioKey)) throw new Error('Contradictory source bookkeeping'); sourceContexts.set(relation.scenarioKey, relation) }
  }
  const visited = new Set<string>(), declaredRetainingPages = new Set<string>()
  async function visit(ref: WorkspaceBlobRef): Promise<unknown> {
    const id = blobIdentity(ref)
    if (pending.has(id)) throw new Error('Cyclic retained content')
    const entry = entries.get(id)
    if (!entry || !sameRefs([entry.ref], [ref])) throw new Error('Missing or foreign closure entry')
    get(ref)
    edges.set(id, entry.dependencies)
    if (entry.encoding === 'bytes') { if (entry.kind !== 'blob' || entry.dependencies.length) throw new Error('Invalid binary archive entry'); visited.add(id); return undefined }
    const value = metadataByRef.get(id)!.value
    // A shared immutable entry has already passed schema and edge checks in this exact closure
    if (visited.has(id)) return value
    if (entry.kind === 'blob') throw new Error('Invalid JSON blob entry')
    const expected = [...archiveTypedReferences(entry.kind, value)]
    const context = sourceContexts.get(entry.key)
    if (!legacyLocal && entry.kind === 'scenario' && (value as { baseline: { kind: string } }).baseline.kind === 'recordedParty' && !context) throw new Error('Missing recorded-party source evidence')
    for (const key of resolvedDomainClosureKeys({ key: entry.key, kind: entry.kind, value }, metadata, context?.kind === 'recorded-party-source' ? context.scenarioDependencies : legacyLocal ? 'legacy-s02' : 'complete-v1')) {
      const matching = [...entries.values()].filter(candidate => candidate.key === key)
      if (matching.length !== 1) throw new Error('Missing or contradictory typed domain pin')
      expected.push(matching[0].ref)
    }
    let actual = entry.dependencies
    if (entry.retainingIndex) {
      if (!sameRefs(actual, [entry.retainingIndex]) || entry.kind === 'unit-index') throw new Error('Invalid retaining index declaration')
      const seenPages = new Set<string>(), seenValues = new Set<string>(), leaves: WorkspaceBlobRef[] = []
      const collect = (ref: WorkspaceBlobRef) => {
        const key = blobIdentity(ref)
        if (seenPages.has(key)) throw new Error('Cyclic or duplicate retaining index page')
        seenPages.add(key); declaredRetainingPages.add(key)
        const child = entries.get(key), document = metadataByRef.get(key)
        if (!child || !sameRefs([child.ref], [ref]) || child.kind !== 'unit-index' || !document) throw new Error('Missing retaining index page')
        const index = WorkspaceUnitIndexSchema.parse(document.value), relation = index.relation
        if (new TextEncoder().encode(JSON.stringify(index)).length > INDEX_PAGE_BYTES || relation.kind !== 'retaining-edges' || relation.privateKey !== entry.key || !sameRefs([relation.owner], [entry.ref])) throw new Error('Foreign retaining index association')
        for (const root of index.roots) {
          const target = metadataByRef.get(blobIdentity(root))
          if (target?.kind === 'unit-index' && WorkspaceUnitIndexSchema.parse(target.value).relation.kind === 'retaining-edges') collect(root)
          else { const id = blobIdentity(root); if (seenValues.has(id)) throw new Error('Duplicate retained edge'); seenValues.add(id); leaves.push(root) }
        }
      }
      collect(entry.retainingIndex); actual = leaves
    }
    if (!sameRefs(actual, expected)) throw new Error('Typed retention edges do not match')
    pending.add(id)
    for (const dependency of entry.dependencies) await visit(dependency)
    if (entry.kind === 'unit-index') {
      const index = WorkspaceUnitIndexSchema.parse(value), relation = index.relation
      if (new TextEncoder().encode(JSON.stringify(index)).length > INDEX_PAGE_BYTES) throw new Error('Compound index exceeds page bound')
      const entryFor = (ref: WorkspaceBlobRef) => entries.get(blobIdentity(ref))!
      const childIndex = (ref: WorkspaceBlobRef) => { const child = entryFor(ref); if (child.kind !== 'unit-index') throw new Error('Unexpected compound unit root'); return WorkspaceUnitIndexSchema.parse(metadataByRef.get(blobIdentity(ref))!.value) }
      if (new Set(index.roots.map(blobIdentity)).size !== index.roots.length) throw new Error('Duplicate compound root')
      if (relation.kind === 'build-copy' || relation.kind === 'personal-lineage' || relation.kind === 'directory-mapping' || relation.kind === 'mapping-frame') throw new Error('Build copy must be the closed result root')
      if (relation.kind === 'unit') {
        const primary = entryFor(relation.primary)
        if (!index.roots.some(ref => sameRefs([ref], [relation.primary])) || primary.key !== relation.privateKey || ['unit-index', 'blob', 'directory', 'directory-page'].includes(primary.kind)) throw new Error('Compound primary unit mismatch')
        for (const ref of index.roots) if (!sameRefs([ref], [relation.primary]) && childIndex(ref).relation.kind === 'unit') throw new Error('Unexpected nested primary unit')
      } else if (relation.kind === 'page') {
        for (const ref of index.roots) if (childIndex(ref).relation.kind === 'unit') throw new Error('Unexpected paged primary unit')
      } else if (relation.kind === 'retaining-edges') {
        const owner = entries.get(blobIdentity(relation.owner))
        if (!owner || !sameRefs([owner.ref], [relation.owner]) || owner.key !== relation.privateKey || !owner.retainingIndex) throw new Error('Retaining index has no declared owner')
        if (new TextEncoder().encode(JSON.stringify(index)).length > INDEX_PAGE_BYTES) throw new Error('Retaining index exceeds page bound')
      } else if (relation.kind === 'conflict-successor') {
        if (!sameRefs(index.roots, [relation.body]) || relation.conflictId === relation.priorId || relation.prior.privateKey !== JSON.stringify(['conflict', relation.priorId]) || relation.prior.valueKind !== 'conflict' || entryFor(relation.body).key !== relation.unit.privateKey) throw new Error('Invalid conflict successor evidence')
      } else if (relation.kind === 'publication-source') {
        const associated = metadataByRef.get(blobIdentity(relation.body)), publication = relation.publication
        if (!associated || !sameRefs(index.roots, [relation.body]) || associated.key !== publication.privateKey || associated.kind !== publication.valueKind || relation.body.documentId !== publication.body.documentId || relation.body.revisionId !== publication.body.revisionId || await hashBlob(workspaceDocumentSource(associated)) !== publication.digest) throw new Error('Original publication association mismatch')
        const context = sourceContexts.get(publication.privateKey)
        const compactRef = (ref: WorkspaceBlobRef) => ({ documentId: ref.documentId, revisionId: ref.revisionId })
        const originalContext = context ? { ...context, version: 1 as const, scenario: compactRef(context.scenario), owner: compactRef(context.owner), baselineCheckpoints: context.baselineCheckpoints.map(value => ({ key: value.key, ref: compactRef(value.ref) })) } : undefined
        if (JSON.stringify(originalContext ? SourceBookkeepingSchema.parse(originalContext) : undefined) !== JSON.stringify(publication.sourceBookkeeping)) throw new Error('Original publication source context mismatch')
      } else if (relation.kind === 'recorded-party-source') {
        if (!sameRefs(index.roots, [relation.scenario, relation.owner, ...relation.baselineCheckpoints.map(value => value.ref)])) throw new Error('Source bookkeeping roots mismatch')
        const scenario = metadataByRef.get(blobIdentity(relation.scenario))!, owner = metadataByRef.get(blobIdentity(relation.owner))!
        const evidence = { ...relation, version: 1 as const, baselineCheckpoints: relation.baselineCheckpoints.map(value => ({ key: value.key, ref: { documentId: value.ref.documentId, revisionId: value.ref.revisionId } })), scenario: { documentId: relation.scenario.documentId, revisionId: relation.scenario.revisionId }, owner: { documentId: relation.owner.documentId, revisionId: relation.owner.revisionId } }
        validateSourceBookkeeping(evidence, { ref: relation.scenario, document: scenario }, { ref: relation.owner, document: owner })
        validateSourceCheckpoints(evidence, { ref: relation.scenario, document: scenario }, relation.baselineCheckpoints.map(value => ({ ref: value.ref, document: metadataByRef.get(blobIdentity(value.ref))! })))
      } else {
        if (!sameRefs(index.roots, [relation.evidence, relation.materialized]) || blobIdentity(relation.evidence) === blobIdentity(relation.materialized)) throw new Error('Catalog expansion identities conflict')
        const evidenceEntry = entryFor(relation.evidence), materializedEntry = entryFor(relation.materialized)
        if (evidenceEntry.kind !== 'blob' || materializedEntry.kind !== 'catalog' || materializedEntry.key !== relation.privateKey) throw new Error('Catalog expansion roles mismatch')
        const decoded = await decodeWorkspaceDocument(get(relation.evidence))
        const pin = PackagedCatalogPinSchema.parse(decoded.value)
        const catalog = metadataByRef.get(blobIdentity(relation.materialized))!.value as unknown as import('../domain/types').CatalogSnapshot
        if (decoded.kind !== 'catalog' || decoded.key !== relation.privateKey || pin.id !== relation.id || pin.revisionId !== relation.revisionId || pin.checksum !== relation.checksum || catalog.id !== pin.id || catalog.revisionId !== pin.revisionId || catalog.checksum !== pin.checksum) throw new Error('Catalog expansion association mismatch')
      }
    }
    if (entry.kind === 'directory-mapping-unit') {
      const unit = mappingSchema.parse(value)
      const evidence = directorySchema.parse(await json(unit.shardEvidence, INDEX_PAGE_BYTES))
      const memberships: { key: string; documentId: string }[] = []
      const collect = async (directory: z.infer<typeof directorySchema>): Promise<void> => { memberships.push(...directory.entries); for (const child of directory.children) await collect(directorySchema.parse(await json(child, INDEX_PAGE_BYTES))) }
      await collect(evidence)
      const matching = memberships.filter(entry => entry.key === unit.privateKey)
      if (evidence.shard !== unit.shard || matching.length > 1 || (unit.allocation.kind === 'absent' ? matching.length !== 0 : matching[0]?.documentId !== unit.allocation.sourceDocumentId)) throw new Error('Directory allocation evidence mismatch')
      if (unit.allocation.kind === 'present') {
        let root = entries.get(blobIdentity(unit.allocation.valueRoot))!
        if (root.kind === 'unit-index') {
          const compound = WorkspaceUnitIndexSchema.parse(metadataByRef.get(blobIdentity(root.ref))!.value)
          if (compound.relation.kind !== 'unit' || compound.relation.privateKey !== unit.privateKey) throw new Error('Directory semantic value mismatch')
          root = entries.get(blobIdentity(compound.relation.primary))!
        }
        // A transport allocation alone cannot bind a different schema-valid record to this disputed key
        if (root.key !== unit.privateKey || ['unit-index', 'blob', 'directory', 'directory-page', 'directory-mapping-unit'].includes(root.kind)) throw new Error('Directory semantic value mismatch')
        if (root.ref.documentId !== unit.allocation.sourceDocumentId) throw new Error('Directory allocation value identity mismatch')
      }
    }
    pending.delete(id); visited.add(id); return value
  }
  const value = await visit(closure.root)
  if (visited.size !== entries.size) throw new Error('Unreachable archive entry')
  for (const [id, document] of metadataByRef) if (document.kind === 'unit-index' && WorkspaceUnitIndexSchema.parse(document.value).relation.kind === 'retaining-edges' && !declaredRetainingPages.has(id)) throw new Error('Undeclared retaining index page')
  const containerRoot = entries.get(blobIdentity(closure.root))!
  if (containerRoot.kind === 'unit-index') {
    const index = WorkspaceUnitIndexSchema.parse(value)
    if (index.relation.kind !== 'unit') throw new Error('A closed unit requires its primary semantic root')
    // Evidence wrappers can preserve only catalogs already required by the singular semantic unit
    const semantic = new Set<string>()
    const collect = (ref: WorkspaceBlobRef) => { const id = blobIdentity(ref); if (semantic.has(id)) return; semantic.add(id); for (const dependency of entries.get(id)!.dependencies) collect(dependency) }
    collect(index.relation.primary)
    for (const entry of entries.values()) if (entry.kind === 'unit-index') {
      const wrapper = WorkspaceUnitIndexSchema.parse(metadataByRef.get(blobIdentity(entry.ref))!.value)
      if (wrapper.relation.kind === 'recorded-party-source' && !semantic.has(blobIdentity(wrapper.relation.scenario))) throw new Error('Source bookkeeping is unrelated to the primary unit')
      if (wrapper.relation.kind === 'catalog-expansion' && !semantic.has(blobIdentity(wrapper.relation.materialized))) throw new Error('Catalog expansion is unrelated to the primary unit')
    }
    const publications = [...metadataByRef.values()].filter(document => document.kind === 'unit-index').map(document => WorkspaceUnitIndexSchema.parse(document.value).relation).filter(relation => relation.kind === 'publication-source')
    if (publications.length > 1 || publications.some(value => !sameRefs([value.body], [index.relation.kind === 'unit' ? index.relation.primary : closure.root]))) throw new Error('Foreign or duplicate original publication association')
    const successors = [...metadataByRef.values()].filter(document => document.kind === 'unit-index').map(document => WorkspaceUnitIndexSchema.parse(document.value).relation).filter(relation => relation.kind === 'conflict-successor')
    if (successors.length > 1 || successors.some(value => !sameRefs([value.body], [index.relation.kind === 'unit' ? index.relation.primary : closure.root]))) throw new Error('Foreign conflict successor evidence')
    return { refs, documents: metadata, root: entries.get(blobIdentity(index.relation.primary))!, value: metadataByRef.get(blobIdentity(index.relation.primary))!.value, edges, ...(publications[0] ? { publication: publications[0].publication } : {}), ...(successors[0] ? { supersedes: ConflictSuccessorEvidenceSchema.parse((({ body: _body, ...value }) => value)(successors[0])) } : {}) }
  }
  return { refs, root: containerRoot, value, edges, documents: metadata }
}

function assertUnitIdentity(unit: import('./documents').WorkspaceConflictUnit, result: Awaited<ReturnType<typeof inspectWorkspaceClosure>>) {
  if (unit.kind === 'directory-mapping') {
    if (result.mapping) {
      if (result.mapping.privateKey !== unit.privateKey || result.mapping.shard !== unit.shard) throw new Error('Directory conflict unit mismatch')
      return
    }
    if (result.root.kind !== 'directory-mapping-unit') throw new Error('Directory conflict unit mismatch')
    const value = mappingSchema.parse(result.value)
    if (value.privateKey !== unit.privateKey || value.shard !== unit.shard) throw new Error('Directory conflict unit mismatch')
  } else if (result.lineage) {
    if (result.lineage.privateKey !== unit.privateKey) throw new Error('Personal lineage conflict unit mismatch')
  } else if (result.root.key !== unit.privateKey || result.root.kind === 'directory-mapping-unit') throw new Error('Semantic conflict unit mismatch')
}

export const inspectWorkspaceClosure = (state: WorkspaceState, closure: WorkspaceConflictClosure) => inspectClosure(state, closure)
// A finite fixed-state batch shares parsed bodies, never semantic closure conclusions
// Each role still checks its complete identities and edges; storage authentication remains
// with the source reader and full retention validation, not this structural inspection
export async function inspectWorkspaceClosures(state: WorkspaceState, closures: readonly WorkspaceConflictClosure[]): Promise<Awaited<ReturnType<typeof inspectClosure>>[]> {
  const parsed: ParsedClosureBodies = new WeakMap()
  const results: Awaited<ReturnType<typeof inspectClosure>>[] = []
  for (const closure of closures) results.push(await inspectClosure(state, closure, false, parsed))
  return results
}
// Only the explicit unmarked local-root loader may select frozen physical edges while preparing a strict migration
export const inspectLegacyLocalWorkspaceClosure = (state: WorkspaceState, closure: WorkspaceConflictClosure) => inspectClosure(state, closure, true)
export const validatedLegacyLocalWorkspaceRetentionEdges = (state: WorkspaceState) => retentionEdges(state, true)
export const validatedWorkspaceRetentionEdges = (state: WorkspaceState) => retentionEdges(state)

// Only immutable staged bodies may use this callback-scoped optimization
// Cache hashes, never closure conclusions: the same bytes can have different semantic owners
class ImmutableWorkspaceBodyValidation {
  private active = true
  private readonly verified = new Set<string>()
  private readonly registry = new Map<string, { ref: string; content: WorkspaceState['blobs'][number]['content']; open: WorkspaceState['blobs'][number]['content']['open']; byteLength: number }>()
  constructor(blobs: WorkspaceState['blobs']) {
    for (const blob of blobs) {
      WorkspaceBlobRefSchema.parse(blob.ref)
      const key = blobIdentity(blob.ref)
      if (this.registry.has(key)) throw new Error('Duplicate validation registry body')
      this.registry.set(key, { ref: this.fullRef(blob.ref), content: blob.content, open: blob.content.open, byteLength: blob.content.byteLength })
    }
  }
  private fullRef(ref: WorkspaceBlobRef): string { return JSON.stringify([ref.documentId, ref.revisionId, ref.byteLength, ref.sha256, ref.encoding]) }
  private check(blob: WorkspaceState['blobs'][number]): string {
    if (!this.active) throw new Error('Body validation invocation was released')
    const key = blobIdentity(blob.ref), registered = this.registry.get(key)
    if (!registered || registered.ref !== this.fullRef(blob.ref) || registered.content !== blob.content || registered.open !== blob.content.open || registered.byteLength !== blob.content.byteLength) throw new Error('Body validation source or registry mismatch')
    return key
  }
  async validate(blob: WorkspaceState['blobs'][number]): Promise<void> {
    const key = this.check(blob)
    if (this.verified.has(key)) return
    if (await hashBlob(blob.content) !== blob.ref.sha256) throw new Error('Workspace blob digest mismatch')
    this.check(blob)
    this.verified.add(key)
  }
  release(): void { this.active = false; this.verified.clear(); this.registry.clear() }
}
export type WorkspaceBodyValidation = ImmutableWorkspaceBodyValidation
export async function withImmutableWorkspaceBodyValidation<T>(blobs: WorkspaceState['blobs'], run: (validation: WorkspaceBodyValidation) => Promise<T>): Promise<T> {
  const validation = new ImmutableWorkspaceBodyValidation(blobs)
  try { return await run(validation) } finally { validation.release() }
}

export async function validateWorkspaceClosure(state: WorkspaceState, bodyValidation?: WorkspaceBodyValidation): Promise<void> {
  if (bodyValidation) await retentionEdges(state, false, undefined, bodyValidation)
  else await validatedWorkspaceRetentionEdges(state)
}

async function retentionEdges(state: WorkspaceState, legacyLocal = false, checkedRefs?: Map<string, ReadonlySet<string>>, bodyValidation?: WorkspaceBodyValidation): Promise<ReadonlyMap<string, readonly WorkspaceBlobRef[]>> {
  const edges = new Map<string, readonly WorkspaceBlobRef[]>()
  const inspected = new Map<string, Promise<Awaited<ReturnType<typeof inspectClosure>>>>()
  const parsed: ParsedClosureBodies = new WeakMap()
  const inspect = async (closure: WorkspaceConflictClosure) => {
    const identity = JSON.stringify(closure)
    const existing = inspected.get(identity)
    if (existing) return existing
    const pending = inspectClosure(state, closure, legacyLocal, parsed)
    inspected.set(identity, pending)
    const result = await pending
    // Reuse only checked edge identities within this validation pass, never decrypted bodies across reads
    for (const [key, refs] of result.edges) {
      const previous = edges.get(key)
      if (previous && !sameRefs(previous, refs)) throw new Error('Contradictory retained body edges')
      edges.set(key, refs)
    }
    checkedRefs?.set(identity, result.refs)
    return result
  }
  validateWorkspace(state)
  // Digest every source with bounded incremental state; no full-account byte aggregation
  for (const blob of state.blobs) {
    if (bodyValidation) await bodyValidation.validate(blob)
    else if (await hashBlob(blob.content) !== blob.ref.sha256) throw new Error('Workspace blob digest mismatch')
  }
  const successors = new Map<string, string>()
  for (const conflict of state.conflicts) {
    const evidence = (await inspect(conflict.branches[0].closure)).supersedes
    if (!evidence) continue
    const prior = state.conflicts.find(value => value.id === evidence.priorId)
    if (!prior || prior.disposition.kind !== 'unresolved' || evidence.conflictId !== conflict.id || JSON.stringify(evidence.unit) !== JSON.stringify(conflict.unit) || JSON.stringify(prior.unit) !== JSON.stringify(conflict.unit) || successors.has(prior.id) || await hashBlob(workspaceDocumentSource({ version: 1, kind: 'conflict', key: JSON.stringify(['conflict', prior.id]), value: prior as unknown as WorkspaceDocument['value'] })) !== evidence.prior.digest) throw new Error('Missing or contradictory conflict predecessor')
    successors.set(prior.id, conflict.id)
  }
  for (const start of successors.keys()) {
    const seen = new Set<string>()
    let id: string | undefined = start
    while (id) { if (seen.has(id)) throw new Error('Cyclic conflict comparison'); seen.add(id); id = successors.get(id) }
  }
  for (const conflict of state.conflicts) {
    if (conflict.unit.kind === 'directory-mapping' && conflict.disposition.kind === 'resolved' && (conflict.disposition.choice === 'both' || JSON.stringify(conflict.disposition.result) !== JSON.stringify(conflict.branches[conflict.disposition.choice === 'this' ? 0 : 1].closure))) throw new Error('Mapping result must retain the exact selected original closure')
    const closures = [...(conflict.commonAncestor.kind === 'present' ? [conflict.commonAncestor.closure] : []), ...conflict.branches.map(branch => branch.closure), ...(conflict.disposition.kind === 'resolved' ? [conflict.disposition.result] : [])]
    for (const closure of closures) {
      const result = await inspect(closure); assertUnitIdentity(conflict.unit, result)
      if (result.buildCopy) {
        if (conflict.disposition.kind !== 'resolved' || conflict.disposition.choice !== 'both' || closure !== conflict.disposition.result) throw new Error('Build copy is only a Both result')
        assertBuildCopyOriginals(result.buildCopy, conflict.branches[0].closure, conflict.branches[1].closure)
      } else if (conflict.disposition.kind === 'resolved' && conflict.disposition.choice === 'both' && closure === conflict.disposition.result) throw new Error('Both requires a native independent copy result')
    }
  }
  for (const retained of state.retainedContent) {
    const closures = retained.kind === 'file-history' ? [retained.content] : [...(retained.base.kind === 'present' ? [retained.base.closure] : []), retained.target]
    for (const closure of closures) {
      const result = await inspect(closure)
      if (retained.kind === 'file-history' && (result.root.kind !== retained.fileKind || (result.value as { id: string }).id !== retained.documentId)) throw new Error('Historical file identity mismatch')
      if (retained.kind === 'pending-content') assertUnitIdentity(retained.unit, result)
    }
  }
  return edges
}

export type WorkspacePublicationDisposition = 'publishable' | 'local-only'
export async function publicationDocuments(state: WorkspaceState): Promise<readonly WorkspaceDocument[]> {
  const checkedRefs = new Map<string, ReadonlySet<string>>()
  // Selection may consume only ref sets from this completed validation pass; outer role checks still run for every use
  await retentionEdges(state, false, checkedRefs)
  const retained = new Set<string>()
  const addClosure = (closure: WorkspaceConflictClosure) => {
    const refs = checkedRefs.get(JSON.stringify(closure))
    if (!refs) throw new Error('Missing validated publication closure')
    for (const id of refs) retained.add(id)
  }
  for (const conflict of state.conflicts) {
    if (conflict.commonAncestor.kind === 'present') addClosure(conflict.commonAncestor.closure)
    for (const branch of conflict.branches) addClosure(branch.closure)
    if (conflict.disposition.kind === 'resolved') addClosure(conflict.disposition.result)
  }
  for (const entry of state.retainedContent) if (entry.kind === 'file-history') addClosure(entry.content)
  const documents = splitWorkspace(state)
  for (const document of documents.filter(document => document.kind !== 'retained-content' || (document.value as { kind: string }).kind !== 'pending-content')) for (const ref of archiveTypedReferences(document.kind, document.value)) retained.add(blobIdentity(ref))
  return documents.filter(document => {
    if (document.kind === 'retained-content' && (document.value as { kind: string }).kind === 'pending-content') return false
    if (document.kind === 'blob' || document.kind === 'blob-reference') return retained.has((JSON.parse(document.key) as string[])[1])
    return true
  }).map(document => {
    if (document.kind !== 'workspace-identity') return document
    const value = document.value as unknown as { localData: Record<string, import('../domain/types').JsonValue>; lineage: import('../domain/types').JsonValue }
    const { updatedAt: _localAggregate, ...localData } = value.localData
    return { ...document, value: { ...value, localData } }
  })
}
export interface WorkspacePublicationRoot { readonly document: WorkspaceDocument; readonly disposition: WorkspacePublicationDisposition }
export async function workspacePublicationRoots(state: WorkspaceState): Promise<readonly WorkspacePublicationRoot[]> {
  const eligible = new Map((await publicationDocuments(state)).map(document => [document.key, document]))
  return splitWorkspace(state).map(document => ({ document: eligible.get(document.key) ?? document, disposition: eligible.has(document.key) ? 'publishable' : 'local-only' }))
}

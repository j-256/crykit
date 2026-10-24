import { z } from 'zod'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { createBlankLocalData } from '../domain/local-data'
import { definitionLineageRootRef } from '../domain/definitions'
import type { PersonalDefinition, EntityRef } from '../domain/types'
import { personalLineageChains, personalLineageKey } from '../account/sync/lineage'
import { OriginalPublicationSchema, ConflictSuccessorEvidenceSchema, type ConflictSuccessorEvidence, type OriginalPublication } from './conflict-authority'
import { WorkspaceBlobRefSchema } from './file-schemas'
import { accountLocalId } from './account-cache'
import type { OpenAccountWorkspace } from './account-graph'
import type { WorkspaceState, WorkspaceConflictClosure, WorkspaceDocument, WorkspaceBlobRef } from './documents'
import { blobIdentity, hashBlob, memoryBlob } from './blobs'
import { workspaceDocumentSource } from './document-codec'

const closureSchema = z.strictObject({ version: z.literal(1), root: WorkspaceBlobRefSchema, index: WorkspaceBlobRefSchema })
export const PersonalLineageRelationSchema = z.strictObject({ kind: z.literal('personal-lineage'), privateKey: z.string(), rootRef: NativeLocalDataSchema.shape.personalDefinitions.valueType.shape.baseRef.unwrap(), selected: WorkspaceBlobRefSchema, content: closureSchema, publication: OriginalPublicationSchema.optional(), supersedes: ConflictSuccessorEvidenceSchema.optional() })
export type PersonalLineageRelation = z.infer<typeof PersonalLineageRelationSchema>
export async function archivePersonalLineage(workspace: OpenAccountWorkspace, privateKey: string, blobs: Map<string, WorkspaceState['blobs'][number]>, publication?: OriginalPublication, supersedes?: ConflictSuccessorEvidence): Promise<WorkspaceConflictClosure> {
  const chain = personalLineageChains(workspace.state.planner.localData).get(privateKey)
  if (!chain?.length) throw new Error('Personal lineage evidence missing')
  const selectedKey = JSON.stringify(['personal-definition', chain.at(-1)!.id])
  const { archiveWorkspaceUnit } = await import('./pending-content')
  const content = await archiveWorkspaceUnit(workspace, selectedKey, blobs)
  const selectedEntry = workspace.entries.find(entry => entry.key === selectedKey)!
  const selected = [...blobs.values()].find(blob => blobIdentity(blob.ref) === blobIdentity(selectedEntry.ref))!.ref
  const rootRef = definitionLineageRootRef(workspace.state.planner.localData, { kind: 'personal', definitionId: chain[0].id })
  const relation = PersonalLineageRelationSchema.parse({ kind: 'personal-lineage', privateKey, rootRef, selected, content, ...(publication ? { publication } : {}), ...(supersedes ? { supersedes } : {}) })
  if (publication && (!publication.lineage || publication.privateKey !== privateKey || personalLineageKey(publication.lineage.root as EntityRef) !== privateKey || blobIdentity(publication.body) !== blobIdentity(selected) || publication.digest !== selectedEntry.digest)) throw new Error('Personal lineage publication association mismatch')
  return wrapLineage(relation, blobs)
}
async function wrapLineage(relation: PersonalLineageRelation, blobs: Map<string, WorkspaceState['blobs'][number]>): Promise<WorkspaceConflictClosure> {
  const json = async (value: unknown) => {
    const content = memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
    const ref: WorkspaceBlobRef = { documentId: accountLocalId(), revisionId: accountLocalId(), byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'utf8' }
    blobs.set(blobIdentity(ref), { ref, content }); return ref
  }
  const roots = [relation.content.root, relation.content.index]
  const root = await json({ version: 1, kind: 'unit-index', roots, relation })
  const index = await json({ version: 1, kind: 'conflict-closure-page', entries: [{ version: 1, ref: root, documentVersion: 1, kind: 'unit-index', key: JSON.stringify(['unit-index', blobIdentity(root)]), encoding: 'json', dependencies: roots }], children: [] })
  return { version: 1, root, index }
}
export async function validatePersonalLineage(relation: PersonalLineageRelation, inspected: { root: { ref: WorkspaceBlobRef; key: string; kind: string }; documents: ReadonlyMap<string, WorkspaceDocument>; value: unknown }): Promise<void> {
  if (inspected.root.kind !== 'personal-definition' || JSON.stringify(inspected.root.ref) !== JSON.stringify(relation.selected)) throw new Error('Personal lineage selected role mismatch')
  const definitions = Object.fromEntries([...inspected.documents.values()].filter(document => document.kind === 'personal-definition').map(document => { const value = NativeLocalDataSchema.shape.personalDefinitions.valueType.parse(document.value) as unknown as PersonalDefinition; return [value.id, value] }))
  const data = { ...createBlankLocalData(), personalDefinitions: definitions }, chains = personalLineageChains(data)
  const chain = chains.get(relation.privateKey)
  if (!chain?.length || personalLineageKey(relation.rootRef as EntityRef) !== relation.privateKey || inspected.root.key !== JSON.stringify(['personal-definition', chain.at(-1)!.id])) throw new Error('Personal lineage chain/root mismatch')
  if (relation.supersedes) {
    const evidence = relation.supersedes
    if (!relation.publication || evidence.conflictId === evidence.priorId || evidence.prior.privateKey !== JSON.stringify(['conflict', evidence.priorId]) || evidence.prior.valueKind !== 'conflict' || evidence.unit.kind !== 'record' || evidence.unit.privateKey !== relation.privateKey) throw new Error('Invalid personal lineage successor evidence')
  }
  if (relation.publication) {
    const publication = relation.publication
    if (!publication.lineage || publication.valueKind !== 'personal-lineage' || publication.privateKey !== relation.privateKey || personalLineageKey(publication.lineage.root as EntityRef) !== relation.privateKey || blobIdentity(publication.body) !== blobIdentity(relation.selected) || publication.digest !== await hashBlob(workspaceDocumentSource(inspected.documents.get(inspected.root.key)!))) throw new Error('Personal lineage original association mismatch')
  }
}

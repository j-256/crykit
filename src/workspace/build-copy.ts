import { z } from 'zod'
import { cloneBuild } from '../domain/builds'
import { createBlankLocalData } from '../domain/local-data'
import type { Build, BuildRevision, LocalData, CatalogSnapshot } from '../domain/types'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { validateLocalDataForStorage } from '../persistence/local-data'
import { WorkspaceBlobRefSchema } from './file-schemas'
import type { WorkspaceConflictClosure, WorkspaceDocument } from './documents'

const closure = z.strictObject({ version: z.literal(1), root: WorkspaceBlobRefSchema, index: WorkspaceBlobRefSchema })
export const BuildCopyRelationSchema = z.strictObject({ kind: z.literal('build-copy'), privateKey: z.string(), keptRole: z.literal('accepted-cloud'), copySourceRole: z.literal('local-pending'), kept: closure, copy: closure, source: closure })
export type BuildCopyRelation = z.infer<typeof BuildCopyRelationSchema>
export interface BuildCopyInspection { readonly relation: BuildCopyRelation; readonly kept: Build; readonly copy: Build; readonly source: Build; readonly sourceCheckpoint: BuildRevision }
export const buildCopyRoots = (relation: BuildCopyRelation) => [relation.kept, relation.copy, relation.source].flatMap(unit => [unit.root, unit.index])
export interface ClosedBuildInput { readonly root: { readonly kind: string; readonly key: string }; readonly value: unknown; readonly documents: ReadonlyMap<string, WorkspaceDocument> }

function build(input: ClosedBuildInput) {
  if (input.root.kind !== 'build') throw new Error('Build copy role must be an ordinary Build unit')
  const value = NativeLocalDataSchema.shape.builds.valueType.parse(input.value) as unknown as Build
  if (input.root.key !== JSON.stringify(['build', value.id])) throw new Error('Build copy key mismatch')
  const checkpoint = input.documents.get(JSON.stringify(['build-checkpoint', value.latestRevisionId]))
  if (!checkpoint || checkpoint.kind !== 'build-checkpoint') throw new Error('Build copy latest checkpoint missing')
  const revision = NativeLocalDataSchema.shape.buildRevisions.valueType.parse(checkpoint.value) as unknown as BuildRevision
  if (revision.buildId !== value.id) throw new Error('Build copy checkpoint owner mismatch')
  return { value, revision }
}
export function validateBuildCopy(relation: BuildCopyRelation, keptInput: ClosedBuildInput, copyInput: ClosedBuildInput, sourceInput: ClosedBuildInput): BuildCopyInspection {
  const kept = build(keptInput), copy = build(copyInput), source = build(sourceInput)
  if (keptInput.root.key !== relation.privateKey || sourceInput.root.key !== relation.privateKey || copy.value.id === kept.value.id || copy.revision.id === source.revision.id || copy.revision.id === kept.revision.id) throw new Error('Build copy roles or generated identities mismatch')
  const blank = createBlankLocalData({ now: copy.value.createdAt })
  const cloned = cloneBuild({ ...blank, builds: { [source.value.id]: source.value }, buildRevisions: { [source.revision.id]: source.revision } }, { sourceBuildId: source.value.id, id: copy.value.id, revisionId: copy.revision.id, title: copy.value.title, now: copy.value.createdAt })
  if (JSON.stringify(cloned.builds[copy.value.id]) !== JSON.stringify(copy.value) || JSON.stringify(cloned.buildRevisions[copy.revision.id]) !== JSON.stringify(copy.revision)) throw new Error('Build copy differs from native configuration clone')
  // Conflicting source identities remain scoped evidence; only kept/copy records form the active result
  const active = new Map(keptInput.documents)
  for (const [key, document] of copyInput.documents) {
    const previous = active.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(document)) throw new Error('Build copy changes an immutable active pin')
    active.set(key, document)
  }
  const local: LocalData = { ...blank, builds: {}, buildRevisions: {}, gameSetups: {}, personalDefinitions: {} }
  const catalogs: CatalogSnapshot[] = []
  const fields = { build: 'builds', 'build-checkpoint': 'buildRevisions', setup: 'gameSetups', 'personal-definition': 'personalDefinitions' } as const
  for (const document of active.values()) {
    if (document.kind === 'catalog') catalogs.push(document.value as unknown as CatalogSnapshot)
    const field = fields[document.kind as keyof typeof fields]
    if (field) (local[field] as Record<string, unknown>)[JSON.parse(document.key)[1]] = document.value
  }
  validateLocalDataForStorage(local, catalogs)
  return { relation, kept: kept.value, copy: copy.value, source: source.value, sourceCheckpoint: source.revision }
}
export function assertBuildCopyOriginals(result: BuildCopyInspection, pending: WorkspaceConflictClosure, accepted: WorkspaceConflictClosure) {
  if (JSON.stringify(result.relation.source) !== JSON.stringify(pending) || JSON.stringify(result.relation.kept) !== JSON.stringify(accepted)) throw new Error('Build copy is not bound to the frozen original branches')
}

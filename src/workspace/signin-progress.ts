import { z } from 'zod'
import { logicalEntityKey } from '../domain/definitions'
import type { PartyProgressRecord } from '../domain/types'
import { jsonEqual } from '../persistence/local-data'
import { assembleWorkspace, privateRecordKey, splitWorkspace, type WorkspaceDocument, type WorkspaceState } from './documents'
import { resolvedDomainClosureKeys } from './domain-closure'

export const SigninProgressMappingSchema = z.strictObject({ version: z.literal(1), sourceKey: z.string(), destinationKey: z.string(), equivalent: z.boolean() })
export type SigninProgressMapping = z.infer<typeof SigninProgressMappingSchema>

// Edit bookkeeping is not an observation: upsertProgress increments revision and updatedAt
// independently of observedAt, sources, and Knowledge evidence, which must remain exact
function observation(record: PartyProgressRecord): unknown {
  const { id: _id, revision: _revision, updatedAt: _updatedAt, ...value } = record
  return value
}
export function signinDocumentsEqual(left: WorkspaceDocument, right: WorkspaceDocument): boolean {
  if (left.kind !== right.kind || left.key !== right.key) return false
  if (left.kind === 'progress') return jsonEqual(observation(left.value as unknown as PartyProgressRecord), observation(right.value as unknown as PartyProgressRecord))
  // Child edits advance the owner counters without changing the Playthrough unit, as in the native graph codec
  const semantic = (document: WorkspaceDocument) => {
    if (document.kind !== 'playthrough') return document.value
    const value = document.value as unknown as { metadata: Record<string, unknown> }
    const { revision: _revision, updatedAt: _updatedAt, ...metadata } = value.metadata
    return { ...value, metadata }
  }
  return jsonEqual(semantic(left), semantic(right))
}
export function signinProgressCorrespondence(source: WorkspaceState, destination: WorkspaceState): { mappings: SigninProgressMapping[]; problems: string[] } {
  const mappings: SigninProgressMapping[] = [], problems: string[] = []
  const sourceDocuments = new Map(splitWorkspace(source).map(document => [document.key, document]))
  const destinationDocuments = new Map(splitWorkspace(destination).map(document => [document.key, document]))
  const sameClosure = (key: string, visited = new Set<string>()): boolean => {
    if (visited.has(key)) return true
    visited.add(key)
    const left = sourceDocuments.get(key), right = destinationDocuments.get(key)
    return !!left && !!right && signinDocumentsEqual(left, right) && resolvedDomainClosureKeys(left, sourceDocuments).every(dependency => sameClosure(dependency, visited))
  }
  for (const play of Object.values(source.planner.localData.playthroughs)) {
    const existing = destination.planner.localData.playthroughs[play.id]
    if (!existing) continue
    const group = (state: WorkspaceState, records: readonly PartyProgressRecord[]) => {
      const result = new Map<string, PartyProgressRecord[]>()
      for (const record of records) { const key = logicalEntityKey(state.planner.localData, record.subject); result.set(key, [...(result.get(key) ?? []), record]) }
      return result
    }
    const local = group(source, Object.values(play.progress)), account = group(destination, Object.values(existing.progress))
    for (const [subject, records] of local) {
      const prior = account.get(subject)
      if (!prior) continue
      if (records.length !== 1 || prior.length !== 1) { problems.push('Multiple Progress observations share a subject in this Playthrough. Review them before merging.'); continue }
      const record = records[0], other = prior[0]
      if (record.id === other.id) continue
      const sourceKey = privateRecordKey('progress', play.id, record.id), destinationKey = privateRecordKey('progress', play.id, other.id)
      // An occupied destination identity or an existing original comparison cannot be reinterpreted
      if (play.progress[other.id] || existing.progress[record.id] || source.conflicts.some(conflict => [sourceKey, destinationKey].includes(conflict.unit.privateKey))) { problems.push('A Progress identity already has retained comparisons. Review it before merging.'); continue }
      const dependencies = resolvedDomainClosureKeys(sourceDocuments.get(sourceKey)!, sourceDocuments)
      mappings.push({ version: 1, sourceKey, destinationKey, equivalent: jsonEqual(observation(record), observation(other)) && dependencies.every(key => sameClosure(key)) })
    }
  }
  return { mappings, problems: [...new Set(problems)] }
}

// This is a separate live comparison projection; callers retain the untouched source graph
// Its versioned mapping changes only the private record identity, never subject applicability
export function projectSigninProgress(source: WorkspaceState, destination: WorkspaceState, mapping: SigninProgressMapping): WorkspaceState {
  const proven = signinProgressCorrespondence(source, destination).mappings.find(value => value.sourceKey === mapping.sourceKey && value.destinationKey === mapping.destinationKey)
  if (!proven || !jsonEqual(proven, mapping)) throw new Error('Progress comparison mapping does not match its exact originals')
  const parts = JSON.parse(mapping.destinationKey) as string[]
  const documents = splitWorkspace(source).map(document => document.key === mapping.sourceKey ? { ...document, key: mapping.destinationKey, value: { ...(document.value as object), id: parts[2] } as typeof document.value } : document)
  return assembleWorkspace(documents, source.planner.localData.revision, source.planner.journal)
}

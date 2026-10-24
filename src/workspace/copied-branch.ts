import { resolvedDomainClosureKeys } from './domain-closure'
import { createBlankLocalData } from '../domain/local-data'
import { assembleWorkspace, privateRecordKey, splitWorkspace, type WorkspaceConflictClosure, type WorkspaceState } from './documents'
import { inspectWorkspaceClosure, validateWorkspaceClosure } from './closure'

// Rebuild only the domain projection described by an authenticated portable branch
// Archival wrappers and source publication IDs remain in inherited evidence, never in active records
export async function copiedBranchState(source: WorkspaceState, closure: WorkspaceConflictClosure, selected?: WorkspaceState): Promise<WorkspaceState> {
  const inspected = await inspectWorkspaceClosure(source, closure)
  const localData = createBlankLocalData()
  const blank: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: source.blobs }
  const documents = new Map(splitWorkspace(blank).map(document => [document.key, document]))
  for (const document of inspected.documents.values()) {
    if (['unit-index', 'directory', 'directory-page', 'directory-mapping-unit', 'tombstone'].includes(document.kind)) continue
    documents.set(document.key, document)
  }
  for (const document of documents.values()) if (document.kind === 'playthrough' && !documents.has(privateRecordKey('inventory', JSON.parse(document.key)[1]))) {
    // An ID-only owner archive intentionally omits mutable siblings. Only explicitly selected
    // complete owner context may fill them; the original archived owner and child still win
    const ownerId = JSON.parse(document.key)[1] as string
    const context = selected?.planner.localData.playthroughs[ownerId]
    if (!context) throw new Error('Select the complete owning Playthrough before copying this comparison')
    for (const candidate of splitWorkspace(selected!)) if (!documents.has(candidate.key)) {
      const parts = JSON.parse(candidate.key) as string[]
      if (parts[1] === ownerId && ['character', 'progress', 'goal', 'scenario', 'inventory', 'quintar-breeding', 'skill-capture'].includes(candidate.kind)) documents.set(candidate.key, candidate)
    }
    // Fill only exact dependencies of the selected children, not unrelated selected records
    const available = new Map(splitWorkspace(selected!).map(candidate => [candidate.key, candidate]))
    const include = (key: string): void => {
      if (documents.has(key)) return
      const candidate = available.get(key)
      if (!candidate) throw new Error('A selected owner is missing its exact dependent record')
      documents.set(key, candidate)
      for (const dependency of resolvedDomainClosureKeys(candidate, available)) include(dependency)
    }
    for (const candidate of documents.values()) for (const dependency of resolvedDomainClosureKeys(candidate, new Map([...available, ...documents]))) include(dependency)
  }
  const state = assembleWorkspace([...documents.values()], 0)
  await validateWorkspaceClosure(state)
  return state
}

// Supersession describes the original account only; retain the complete group as history
// and reconstruct its unresolved tip without forging destination predecessor authority
export async function applicableCopiedComparisons(source: WorkspaceState) {
  const predecessors = new Set<string>()
  for (const conflict of source.conflicts) {
    const inspected = await inspectWorkspaceClosure(source, conflict.branches[0].closure)
    if (inspected.supersedes) predecessors.add(inspected.supersedes.priorId)
  }
  return source.conflicts.filter(conflict => conflict.disposition.kind === 'unresolved' && !predecessors.has(conflict.id))
}

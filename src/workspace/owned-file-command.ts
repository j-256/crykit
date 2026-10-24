import type { JsonValue } from '../domain/types'
import type { SaveOperation } from './save-repository'
import type { InspectorStorage } from '../mod-inspector/storage'
import type { UnfinishedEditorInput } from './editor-repository'
import type { WorkspaceRepository } from './repository'
import { splitWorkspace, isBlobSource, type WorkspaceState } from './documents'
import { accountLocalId } from './account-cache'

export type OwnedFileOperation = 'libraryImport' | 'import' | 'saveUnfinished' | 'apply' | 'remove' | SaveOperation
export interface OwnedFileCommand {
  readonly id: string
  readonly operation: OwnedFileOperation
  readonly assertMayActivate: () => void
  readonly assertSaveInput?: (id: string, revision: number, input?: { readonly bytes: Uint8Array; readonly pendingForm: JsonValue }) => void
  readonly assertInput?: (id: string, revision: number, input?: UnfinishedEditorInput) => void
}
export interface OwnedFileReceipt { readonly id: string }
export interface OwnedFileOutcome {
  readonly status: 'saved' | 'not-saved' | 'uncertain'
  readonly receipt?: OwnedFileReceipt
  readonly error?: unknown
}
export interface OwnedFileCompletion { readonly repository: WorkspaceRepository; readonly state: WorkspaceState; readonly assertCurrent: () => Promise<void> }
type Committer = (before: WorkspaceState, next: WorkspaceState, command: OwnedFileCommand) => Promise<OwnedFileOutcome>
const committers = new WeakMap<WorkspaceRepository, Committer>()
const inspectorChecks = new WeakMap<OwnedFileCommand, (storage: InspectorStorage) => Promise<void>>()
const executions = new WeakMap<OwnedFileCommand, { readonly repository: WorkspaceRepository; readonly before: WorkspaceState; readonly next: WorkspaceState; readonly outcome: Promise<OwnedFileOutcome> }>()
const reconciliations = new WeakMap<OwnedFileOutcome, () => Promise<OwnedFileOutcome>>()
const receipts = new WeakMap<OwnedFileReceipt, { readonly reconcile: () => Promise<OwnedFileCompletion>; readonly assertOwner: () => void; readonly verify?: () => Promise<void> }>()
export function registerOwnedInspectorCheck(command: OwnedFileCommand, check: (storage: InspectorStorage) => Promise<void>): void { inspectorChecks.set(command, check) }
export function assertOwnedInspectorCapture(command: OwnedFileCommand, storage: InspectorStorage): Promise<void> { return inspectorChecks.get(command)?.(storage) ?? Promise.resolve() }
export function registerOwnedFileCommitter(repository: WorkspaceRepository, commit: Committer): void { committers.set(repository, commit) }
// A deferred startup facade resolves one captured repository, never a mutable latest selection
// Invoke its private committer directly so the original command retains its single execution identity
export function registerDeferredOwnedFileCommitter(repository: WorkspaceRepository, captured: () => Promise<WorkspaceRepository>): void {
  registerOwnedFileCommitter(repository, async (before, next, command) => {
    const selected = await captured(), commit = committers.get(selected)
    if (!commit) throw new Error('The captured repository lacks owned file commands')
    return commit(before, next, command)
  })
}
export function newOwnedFileCommand(operation: OwnedFileOperation, assertMayActivate: () => void = () => {}, assertInput?: OwnedFileCommand['assertInput'], assertSaveInput?: OwnedFileCommand['assertSaveInput']): OwnedFileCommand {
  return Object.freeze({ id: accountLocalId(), operation, assertMayActivate, assertInput, assertSaveInput })
}
export function commitOwnedFile(repository: WorkspaceRepository, before: WorkspaceState, next: WorkspaceState, command: OwnedFileCommand): Promise<OwnedFileOutcome> {
  const existing = executions.get(command)
  if (existing) {
    if (existing.repository !== repository) throw new Error('A file command cannot move to another repository')
    assertFileCommandResult(existing.before, before); assertFileCommandResult(existing.next, next)
    return existing.outcome.then(reconcileOwnedFileOutcome)
  }
  const commit = committers.get(repository)
  if (!commit) throw new Error('This captured workspace does not support file commands')
  command.assertMayActivate()
  const execution = commit(before, next, command)
  executions.set(command, { repository, before, next, outcome: execution })
  return execution
}
export function reconcilableFileOutcome(outcome: OwnedFileOutcome, reconcile: () => Promise<OwnedFileOutcome>): OwnedFileOutcome {
  reconciliations.set(outcome, reconcile)
  return Object.freeze(outcome)
}
export function reconcileOwnedFileOutcome(outcome: OwnedFileOutcome): Promise<OwnedFileOutcome> {
  // Retry rereads the command's journal; it cannot allocate a second operation or retarget a receipt
  return reconciliations.get(outcome)?.() ?? Promise.resolve(outcome)
}
export function ownedFileReceipt(command: OwnedFileCommand, reconcile: () => Promise<OwnedFileCompletion>, verify?: () => Promise<void>): OwnedFileReceipt {
  const receipt = Object.freeze({ id: command.id })
  receipts.set(receipt, { reconcile, assertOwner: command.assertMayActivate, verify })
  return receipt
}
// Read-only recovery verifies a private saved result without returning continuation authority
export async function verifyOwnedFileReceipt(receipt: OwnedFileReceipt): Promise<void> {
  const registered = receipts.get(receipt)
  if (!registered) throw new Error('Unknown file command receipt')
  if (!registered.verify) throw new Error('Saved-result verification is unavailable')
  await registered.verify()
}
export async function resolveOwnedFileReceipt(receipt: OwnedFileReceipt): Promise<OwnedFileCompletion> {
  // Receipt-shaped values and broadcast hints cannot manufacture continuation authority
  const registered = receipts.get(receipt)
  if (!registered) throw new Error('Unknown file command receipt')
  const result = await registered.reconcile()
  await result.assertCurrent()
  registered.assertOwner()
  return result
}
export function assertFileCommandResult(expected: WorkspaceState, actual: WorkspaceState): void {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value
  const metadata = (state: WorkspaceState) => splitWorkspace(state).map(document => [document.key, isBlobSource(document.value) ? document.value.byteLength : canonical(document.value)]).sort(([a], [b]) => String(a).localeCompare(String(b)))
  if (JSON.stringify(canonical(expected.planner.localData)) !== JSON.stringify(canonical(actual.planner.localData)) || JSON.stringify(canonical(expected.planner.journal)) !== JSON.stringify(canonical(actual.planner.journal))) throw new Error('The saved planner bookkeeping changed during file completion')
  if (JSON.stringify(metadata(expected)) !== JSON.stringify(metadata(actual))) throw new Error('The complete saved file command no longer matches its captured result')
}

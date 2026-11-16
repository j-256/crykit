import { readIncrementalMappedIntent } from './account-mapping-origin'
import { managedComparisonWritesEnabled } from './managed-copy-comparisons'
import { admitWorkspaceMetadata, createMergeOperationScope, metadataAdmissionFacts, validateSnapshotBodies, type MergeOperationScope, type WorkspaceMetadataAdmission } from './snapshot-admission'
import { assertReviewedAccountData, type ReviewedAccountData } from './reviewed-replacement'
import { accountAttachmentCheck, prepareAccountReceiptAttachment, releaseAccountActivationAttachment, type AccountSyncAttachmentValue } from '../persistence/account-activation-attachments'
import { classifySigninLocalData } from './signin-local-data'
import { signinDocumentsEqual, signinProgressCorrespondence } from './signin-progress'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { guestEvidenceForCopy, type CapturedGuestEvidence } from './guest-evidence'
import { GuestCopyJournalSchema as JournalSchema, PENDING_COPY, PreviewSchema, SAVED_COPY_PREFIX, type GuestCopyJournal as Journal, type GuestCopyPreview } from './guest-copy-journal'
import { activateGuestCopyWithReceipt, activateManagedGuestCopy, managedGuestCopyMappings, stageManagedGuestCopy } from './managed-guest-copy'
import { captureAccountSyncWorkspace, isManagedAccountHead } from './account-sync-capture'
import { initializeAccountWorkspace } from './account-initialization'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot } from './local-root'
import { prepareManagedAccountProjection } from './account-managed-projection'
import { readIncrementalMappedRoot } from './account-local-mapping'
import { checkpointBuildView } from '../domain/team-checkpoints'
import { captureAccountSnapshot } from './account-snapshot'
import { captureRetainedManagedAccountSnapshot } from './account-managed-snapshot'
import { createAccountPreparationOwner } from './account-prepared-records'
import { applicableCopiedComparisons, copiedBranchState } from './copied-branch'
import { projectPlanner } from './planner-journal'
import { personalLineageChains } from '../account/sync/lineage'
import { createCopiedConflictReader, readCopiedConflicts, stageCopiedConflictRegistrations, prepareCopiedConflicts } from './copied-conflicts'
import { preserveLocalSelections } from './local-selections'
import { z } from 'zod'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { requestSync } from '../account/sync/scheduler'
import { AccountDatabase, activateLocalAccountCommit, type AccountFence } from '../persistence/account-database'
import { createBlankLocalData } from '../domain/local-data'
import { jsonEqual } from '../persistence/local-data'
import { attachBackupBodies, inheritWorkspaceSnapshot, readBackupMetadata, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
import { accountLocalId, cipherRef, openAccountJson, stageAccountJson } from './account-cache'
import { accountInheritedEvidenceCheck, accountInheritedSources, createAccountInheritedEvidencePreparation, openAccountInheritedEvidence, type AccountInheritedEvidence } from './account-evidence-snapshots'
import { openAccountWorkspace, prepareAccountWorkspaceWithEvidence } from './account-graph'
import { MappedWorkspaceIntentSchema, mappedChanges, stageMappedWorkspaceIntent } from './account-intents'
import { inspectWorkspaceClosure, archiveTypedReferences, validatedWorkspaceRetentionEdges, validateWorkspaceClosure } from './closure'
import { resolvedDomainClosureKeys } from './domain-closure'
import { assembleWorkspace, isBlobSource, privateRecordKey, splitWorkspace, type WorkspaceDocument, type WorkspaceState } from './documents'
import { blobIdentity, hashBlob } from './blobs'
import { workspaceDocumentSource } from './document-codec'
import { captureGuestWorkspaceForCopy, type GuestCopySource } from './guest-repository'
import { assertOwnedWorkspaceSnapshot, backupMetadataDigest, disposeWorkspaceSnapshot, ownWorkspaceSnapshot, validateWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'

export type { GuestCopyPreview } from './guest-copy-journal'

const HISTORY_KEY = privateRecordKey('workspace-identity')
const ROOT_KINDS = new Set(['build', 'team', 'playthrough', 'personal-definition', 'setup', 'catalog', 'source', 'evidence', 'import-receipt', 'skill-layout', 'reference-preferences', 'editor', 'save', 'asset', 'conflict', 'history', 'library-defaults'])
const PLANNER_KINDS = new Set(['build', 'team', 'playthrough', 'personal-definition', 'setup', 'import-receipt', 'skill-layout', 'reference-preferences'])
const INFRASTRUCTURE = new Set(['workspace-identity', 'workspace-preferences'])
export interface GuestCopyReceipt { readonly copyId: string; readonly accountId: string; readonly mappings: readonly { readonly key: string; readonly documentId: string }[] }
export interface SigninMergeReview { readonly preview: GuestCopyPreview; dispose(): Promise<void> }
export interface PreparedSigninMerge { readonly copyId: string; activate(receipt: AccountSyncAttachmentValue): Promise<GuestCopyReceipt>; dispose(): Promise<void> }
interface PendingMergeReview { readonly token: ProfileToken; readonly generation: number; readonly account: ReviewedAccountData; readonly preview: GuestCopyPreview; disposed: boolean }
interface SavedGuestCopy { readonly copyId: string; readonly labels: readonly string[]; readonly activated: boolean; readonly pending: boolean }
async function hasMatchingActivation(database: AccountDatabase, token: ProfileToken, journal: Journal): Promise<boolean> {
  const receipt = await database.migrationJournal.get(journal.preview.copyId)
  if (receipt) {
    // Version 1 can have a managed activation distinct from its native saved target
    // Version 2 activates its managed target directly; both require the exact recorded intent
    const target = journal.version === 2 || jsonEqual(receipt.head, journal.target) ? receipt.head : await readIncrementalMappedRoot(database, token, { key: 'active', headRevision: journal.expected.headRevision + 1, head: receipt.head })
    if (!jsonEqual(target, journal.target) || !jsonEqual(receipt.intent, journal.intent)) throw new Error('Saved copy receipt does not match its target')
  }
  return !!receipt
}

interface CopiedComparisonView {
  readonly copyId?: string
  readonly id: string
  readonly originalId: string
  readonly registered: boolean
  readonly collision: boolean
  readonly historical: boolean
  readonly versions: readonly { readonly value: unknown; readonly documents: readonly WorkspaceDocument[] }[]
  readonly blobs: WorkspaceState['blobs']
}
interface Authority { readonly token: ProfileToken; readonly generation: number; readonly expected: AccountFence; readonly snapshot?: WorkspaceSnapshot; readonly selected?: WorkspaceSnapshot; readonly originals?: CapturedGuestEvidence; readonly journal?: Journal; readonly mergeReview?: PendingMergeReview; readonly admission?: WorkspaceMetadataAdmission }

function sampleEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(sampleEvidence)
  const record = value as Record<string, unknown>
  return record.sourceId === 'sample-starter-team' || Array.isArray(record.tags) && record.tags.includes('sample') || Object.values(record).some(sampleEvidence)
}
function describe(document: WorkspaceDocument, sample = sampleEvidence(document.value)): GuestCopyPreview['records'][number] {
  const value = document.value as unknown as { title?: string; label?: string; name?: string; filename?: string; relativePath?: string; metadata?: { label?: string } }
  return { key: document.key, kind: document.kind, label: value.title ?? value.label ?? value.name ?? value.filename ?? value.relativePath ?? value.metadata?.label ?? `${document.kind}: ${(JSON.parse(document.key) as string[]).slice(1).join(' / ') || 'saved preferences'}`, sample }
}
function frozenPreview(value: z.infer<typeof PreviewSchema>): GuestCopyPreview {
  const freeze = (value: unknown): void => { if (!value || typeof value !== 'object') return; for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  freeze(value); return value
}
function blankState(): WorkspaceState {
  const localData = createBlankLocalData()
  return { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [] }
}

async function copyPreviewState(database: AccountDatabase, token: ProfileToken, fence: AccountFence): Promise<WorkspaceState> {
  if (!await isManagedAccountHead(database, token, fence)) {
    const captured = await captureAccountSyncWorkspace(database, token, fence)
    try { return captured.workspace.state } finally { await captured.dispose() }
  }
  const store = createAccountLocalStore(database, token)
  const check = async () => {
    assertActiveProfile(token)
    if (!jsonEqual(await database.profileMeta.get('active'), fence)) throw new Error('The account changed while preparing the copy preview')
    assertActiveProfile(token)
  }
  try {
    // Conflict preview consumes current values only, not historical bodies or a cloud projection
    // Keep the exact local fence so an edit still invalidates this preview before copying
    const selected = await admitLocalRoot(store.adapter, fence.head, { check: () => assertActiveProfile(token), assertCurrent: check })
    await check()
    return selected.state
  } finally { await store.dispose() }
}

// Domain archive edges omit reverse ownership to stay acyclic; a live selected workspace
// additionally needs checkpoint owners and a Build's setup even before its first checkpoint
function copyDependencyKeys(document: WorkspaceDocument, documents: ReadonlyMap<string, WorkspaceDocument>): readonly string[] {
  const dependencies = new Set(resolvedDomainClosureKeys(document, documents))
  if (document.kind === 'build-checkpoint') dependencies.add(privateRecordKey('build', (document.value as unknown as { buildId: string }).buildId))
  if (document.kind === 'team-checkpoint') dependencies.add(privateRecordKey('team', (document.value as unknown as { teamId: string }).teamId))
  if (document.kind === 'build') {
    const build = document.value as unknown as { gameSetupId: string }
    for (const setup of documents.values()) if (setup.kind === 'setup' && (setup.value as unknown as { gameSetupId: string }).gameSetupId === build.gameSetupId) dependencies.add(setup.key)
  }
  return [...dependencies]
}

async function selectSnapshot(snapshot: WorkspaceSnapshot, selection: readonly string[], signin = false, admitted?: { readonly admission: WorkspaceMetadataAdmission; readonly scope: MergeOperationScope }) {
  const documents = new Map(splitWorkspace(snapshot.state).map(document => [document.key, document]))
  const sampleConsents: { conflictKey: string; key: string; document: WorkspaceDocument }[] = []
  const archivedSamples = new Set<string>()
  // An archived sample may have no live source record, or share an ID with a different version
  // Bind its checkbox to this exact comparison and value; an unrelated same-ID selection grants nothing
  for (const conflict of await applicableCopiedComparisons(snapshot.state)) {
    const accepted = await inspectWorkspaceClosure(snapshot.state, conflict.branches[1].closure)
    for (const document of accepted.documents.values()) if (ROOT_KINDS.has(document.kind) && sampleEvidence(document.value)) {
      archivedSamples.add(document.key)
      const current = documents.get(document.key)
      const key = current && jsonEqual(current.value, document.value) ? document.key : JSON.stringify(['conflict-sample', conflict.id, document.key, await hashBlob(workspaceDocumentSource(document))])
      sampleConsents.push({ conflictKey: privateRecordKey('conflict', conflict.id), key, document })
    }
  }
  // History is an explicit selection: its embedded old records stay inert, including old sample provenance
  const histories = [...snapshot.state.planner.history, ...(snapshot.state.planner.journal?.checkpoints ?? [])]
  for (const history of histories) documents.set(privateRecordKey('history', history.id), { version: 1, kind: 'history', key: privateRecordKey('history', history.id), value: history as unknown as WorkspaceDocument['value'] })
  const samples = new Set(archivedSamples)
  for (const document of documents.values()) if (sampleEvidence(document.value)) samples.add(document.key)
  for (const history of histories) for (const root of [history.before, history.after]) {
    for (const [id, build] of Object.entries(root.builds)) if (sampleEvidence(build)) samples.add(privateRecordKey('build', id))
    for (const [id, playthrough] of Object.entries(root.playthroughs)) if (sampleEvidence(playthrough)) samples.add(privateRecordKey('playthrough', id))
  }
  // A renamed sample owner still carries its original child/source provenance
  for (const [id, playthrough] of Object.entries(snapshot.state.planner.localData.playthroughs)) if (sampleEvidence(playthrough)) samples.add(privateRecordKey('playthrough', id))
  for (const team of Object.values(snapshot.state.planner.localData.teams)) if ((team.kind === 'shared' ? snapshot.state.planner.localData.teamRevisions[team.latestRevisionId]!.slots.map((slot, index) => slot ? checkpointBuildView(snapshot.state.planner.localData, { kind: 'team-slot', teamRevisionId: team.latestRevisionId, slot: index as 0 | 1 | 2 | 3 }) : undefined) : team.slots.map(id => id ? snapshot.state.planner.localData.buildRevisions[id] : undefined)).some(revision => revision && samples.has(privateRecordKey('build', revision.buildId)))) samples.add(privateRecordKey('team', team.id))
  const records = [...documents.values()].filter(document => (ROOT_KINDS.has(document.kind) || signin && ['workspace-preferences', 'retained-content'].includes(document.kind)) && !(document.kind === 'library-defaults' && snapshot.state.libraryDefaults.layers.length === 0)).map(document => describe(document, samples.has(document.key)))
  for (const consent of sampleConsents) if (!documents.has(consent.key)) records.push({ ...describe(consent.document, true), key: consent.key, label: `Original accepted sample: ${describe(consent.document).label}` })
  const inherited = !!snapshot.sourceEvidence || snapshot.version !== 1 && !!snapshot.historicalEvidence?.snapshots.length
  if (inherited) records.push({ key: HISTORY_KEY, kind: 'history', label: 'Exact inherited workspace originals (all original records, including unchecked records and samples)', sample: true })
  const offered = new Set(records.map(record => record.key)), selected = new Set(selection)
  if (selected.size !== selection.length || selection.some(key => !offered.has(key))) throw new Error('Choose only records from this local copy preview')
  const included = new Set<string>(), problems: string[] = []
  const edges = admitted ? new Map((await metadataAdmissionFacts(admitted.admission, snapshot, admitted.scope)).retentionEdges) : await validatedWorkspaceRetentionEdges(snapshot.state)
  const blobs = new Map(snapshot.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const includeBlob = (id: string): void => {
    const body = blobs.get(id)
    if (!body) throw new Error('A selected record is missing its exact original bytes')
    const key = privateRecordKey('blob', id)
    if (included.has(key)) return
    included.add(key); included.add(privateRecordKey('blob-reference', id))
    for (const ref of edges.get(id) ?? []) includeBlob(blobIdentity(ref))
  }
  const include = (key: string): void => {
    if (included.has(key)) return
    const document = documents.get(key)
    if (!document) throw new Error('A selected record is missing a required source or revision')
    included.add(key)
    if (document.kind === 'conflict') for (const other of snapshot.state.conflicts) if (other.unit.privateKey === (document.value as unknown as { unit: { privateKey: string } }).unit.privateKey) include(privateRecordKey('conflict', other.id))
    if (document.kind === 'playthrough') {
      const id = (JSON.parse(key) as string[])[1]
      for (const child of documents.values()) if (['character', 'progress', 'goal', 'scenario', 'inventory', 'quintar-breeding', 'skill-capture'].includes(child.kind) && (JSON.parse(child.key) as string[])[1] === id) include(child.key)
    }
    for (const dependency of copyDependencyKeys(document, documents)) include(dependency)
    for (const ref of archiveTypedReferences(document.kind, document.value)) includeBlob(blobIdentity(ref))
  }
  for (const key of selection) if (key !== HISTORY_KEY && !sampleConsents.some(consent => consent.key === key && !documents.has(key))) include(key)
  for (const consent of sampleConsents) {
    if (selected.has(consent.key) && !documents.has(consent.key) && !included.has(consent.conflictKey)) problems.push('Select the comparison for this exact original sample.')
    if (!signin && included.has(consent.conflictKey) && !selected.has(consent.key)) problems.push(`Explicitly select the required sample record: ${describe(consent.document).label}`)
  }
  const plannerSelected = selection.some(key => PLANNER_KINDS.has(documents.get(key)?.kind ?? ''))
  if (plannerSelected) for (const history of histories) if (!selected.has(privateRecordKey('history', history.id))) problems.push('Select the exact planner history to preserve earlier versions. Its old records are copied only as history.')
  if (selection.length && inherited && !selected.has(HISTORY_KEY)) problems.push('This workspace has inherited originals. Include the disclosed complete original history before copying; partial history cannot be rewritten.')
  for (const retained of snapshot.state.retainedContent) {
    const owner = retained.kind === 'file-history' ? privateRecordKey(retained.fileKind, retained.documentId) : retained.unit.privateKey
    if (included.has(owner)) include(privateRecordKey('retained-content', retained.id))
  }
  const base = new Map(splitWorkspace(blankState()).map(document => [document.key, document]))
  for (const key of included) { const document = documents.get(key); if (document) base.set(key, document) }
  for (const conflict of (await applicableCopiedComparisons(snapshot.state)).filter(value => included.has(privateRecordKey('conflict', value.id)))) {
    const accepted = await copiedBranchState(snapshot.state, conflict.branches[1].closure, assembleWorkspace([...base.values()], 0))
    for (const document of splitWorkspace(accepted)) {
      if (INFRASTRUCTURE.has(document.kind) || document.kind === 'library-defaults' || document.kind === 'blob' || document.kind === 'blob-reference') continue
      if (base.has(document.key) && !jsonEqual(base.get(document.key)!.value, document.value)) continue
      base.set(document.key, document)
      documents.set(document.key, document)
      included.add(document.key)
    }
  }
  // Imported accepted dependencies are also live candidates and must pass the same sample consent gate
  for (const key of included) if (!signin && samples.has(key) && offered.has(key) && !selected.has(key) && !sampleConsents.some(consent => consent.document.key === key && selected.has(consent.key) && jsonEqual(consent.document.value, base.get(key)?.value))) problems.push(`Explicitly select the required sample record: ${records.find(record => record.key === key)!.label}`)
  const state = assembleWorkspace([...base.values()], 0)
  const selectedSnapshot = ownWorkspaceSnapshot({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: `${snapshot.snapshotId}:selection`, capturedAt: snapshot.capturedAt, revisionVector: snapshot.revisionVector, state }, { check: () => assertOwnedWorkspaceSnapshot(snapshot), async dispose() {} })
  await validateWorkspaceSnapshot(selectedSnapshot)
  const closure = [...included].flatMap(key => { const document = documents.get(key); return document && !['blob', 'blob-reference'].includes(document.kind) ? [describe(document, samples.has(key))] : [] })
  return { records, selectedSnapshot, closure, problems: [...new Set(problems)], inherited: selected.has(HISTORY_KEY) }
}

async function additiveCopyState(previous: WorkspaceState, selected: WorkspaceSnapshot, preview: GuestCopyPreview): Promise<WorkspaceState> {
  const documents = new Map(splitWorkspace(previous).map(document => [document.key, document]))
  const incoming = new Map(splitWorkspace(selected.state).map(document => [document.key, document]))
  const blocked = new Set([...preview.conflicts, ...(preview.signin?.progressMappings.map(mapping => mapping.sourceKey) ?? [])])
  for (const [key, chain] of personalLineageChains(selected.state.planner.localData)) if (blocked.has(key)) for (const definition of chain) blocked.add(privateRecordKey('personal-definition', definition.id))
  // A pin to an incompatible immutable value cannot become active by copying its owner separately
  // Keep that dependent group in the exact selected source until its comparison is resolved
  let expanded = true
  while (expanded) {
    expanded = false
    for (const document of incoming.values()) {
      if (blocked.has(document.key)) continue
      if (copyDependencyKeys(document, incoming).some(key => blocked.has(key))) { blocked.add(document.key); expanded = true }
    }
  }
  for (const document of incoming.values()) {
    if (blocked.has(document.key)) continue
    if (document.kind === 'conflict' || INFRASTRUCTURE.has(document.kind) && !(document.kind === 'workspace-preferences' && preview.selectedKeys.includes(document.key)) || document.kind === 'library-defaults' && !preview.selectedKeys.includes(document.key)) continue
    const prior = documents.get(document.key)
    if (document.kind === 'workspace-preferences' && emptyPreferences(prior?.value)) { documents.set(document.key, document); continue }
    if (prior && !isBlobSource(document.value) && !jsonEqual(prior.value, document.value)) continue
    if (!prior) documents.set(document.key, document)
  }
  const assembled = assembleWorkspace([...documents.values()], previous.planner.localData.revision, previous.planner.journal)
  const planner = projectPlanner(previous.planner, assembled.planner, false)
  const state = { ...assembled, planner: { ...planner, localData: preserveLocalSelections(planner.localData, previous.planner.localData) } }
  await validateWorkspaceClosure(state)
  return state
}

function emptyPreferences(value: unknown): boolean {
  const preferences = value as { modSetup?: unknown; unavailableDefinitions?: readonly unknown[] } | undefined
  return !preferences?.modSetup && !preferences?.unavailableDefinitions?.length
}

export function createGuestCopyService(capture: () => Promise<WorkspaceSnapshot | GuestCopySource>, assertMayActivate: () => void = () => {}, borrowedScope?: MergeOperationScope) {
  const authorities = new WeakMap<GuestCopyPreview, Authority>()
  // Automatic sign-in selection is a pure function of this exact immutable source
  // Destination conflicts and Progress correspondence are recomputed under each preview's fence
  const selections = new WeakMap<WorkspaceMetadataAdmission, Awaited<ReturnType<typeof selectSnapshot>>>()
  let reviewScope: MergeOperationScope | undefined
  const mergeReviews = new WeakMap<SigninMergeReview, PendingMergeReview>()
  const preparedMerges = new Set<PreparedSigninMerge>()
  let captured: { token: ProfileToken; snapshot: WorkspaceSnapshot; copyId: string; originals?: CapturedGuestEvidence } | undefined
  const inspectionDatabases = new Set<AccountDatabase>()
  const originalReaders = new Set<AccountInheritedEvidence>()
  const retainedPreviews = new Map<string, { token: ProfileToken; snapshot: WorkspaceSnapshot; conflictId: string }>()
  let busy = false
  let generation = 0
  const dispose = async () => { generation++; reviewScope?.dispose(); reviewScope = undefined; await Promise.all([...preparedMerges].map(prepared => prepared.dispose())); const prior = captured; captured = undefined; await Promise.all([...originalReaders].map(reader => reader.dispose())); originalReaders.clear(); retainedPreviews.clear(); for (const database of inspectionDatabases) database.close(); inspectionDatabases.clear(); if (prior) await disposeWorkspaceSnapshot(prior.snapshot) }
  async function previewCopy(token: ProfileToken, selection: readonly string[] = [], signin = false, savedCopyId?: string, reviewOnly = false): Promise<GuestCopyPreview> {
    assertActiveProfile(token); assertMayActivate()
    if (busy) throw new Error('A local copy is already being prepared')
    const database = new AccountDatabase(token.accountId)
    try {
      const pending = await database.syncState.get(savedCopyId !== undefined ? `${SAVED_COPY_PREFIX}${savedCopyId}` : PENDING_COPY)
      if (savedCopyId !== undefined && !pending) throw new Error('The saved sign-in copy is unavailable')
      // A new sign-in decision must not inherit a manual selection or an older source capture
      if (signin && savedCopyId === undefined && pending) throw new Error('A pending copy must be resumed by its saved operation ID or kept before starting a new sign-in merge')
      if (pending) {
        const journal = await openAccountJson(database, token, pending.ref, JournalSchema)
        if (journal.preview.accountId !== token.accountId) throw new Error('The saved copy belongs to another account')
        if (savedCopyId !== undefined && (journal.preview.copyId !== savedCopyId || !journal.preview.signin)) throw new Error('The saved sign-in copy identity is unsupported')
        // A committed receipt outranks the old fence when only the UI acknowledgment was lost
        const activated = await hasMatchingActivation(database, token, journal)
        const advanced = !activated && !jsonEqual(await database.profileMeta.get('active'), journal.expected)
        const preview = frozenPreview({ ...journal.preview, resumable: true, problems: [...journal.preview.problems, ...(advanced ? ['The account changed after this copy was saved. Keep the saved copy and preview again to copy under the new account state.'] : [])] })
        assertActiveProfile(token); assertMayActivate()
        authorities.set(preview, { token, generation, expected: journal.expected, journal }); return preview
      }
      if (captured?.token !== token) {
        await dispose()
        const started = generation, source = await capture()
        const snapshot = 'snapshot' in source ? source.snapshot : source
        if (started !== generation) { await disposeWorkspaceSnapshot(snapshot); throw new Error('Local copy preview was cancelled') }
        captured = { token, snapshot, copyId: accountLocalId(), ...('snapshot' in source && source.originals ? { originals: source.originals } : {}) }
      }
      const started = generation
      await assertOwnedWorkspaceSnapshot(captured.snapshot)
      // Manual previews keep their independent complete validation behavior
      // Only the explicit live review API can borrow operation-owned metadata facts
      const scope = reviewOnly ? borrowedScope ?? (reviewScope ??= createMergeOperationScope(token, profileSignal(token), async () => { assertMayActivate(); if (started !== generation) throw new Error('Local copy preview was cancelled') })) : undefined
      const admission = scope ? await admitWorkspaceMetadata(captured.snapshot, scope) : undefined
      if (admission) await validateSnapshotBodies(admission)
      else await validateWorkspaceSnapshot(captured.snapshot)
      if (signin) {
        selection = [...new Set([...classifySigninLocalData(captured.snapshot.state).rootKeys, ...captured.snapshot.state.planner.history.map(history => privateRecordKey('history', history.id)), ...(captured.snapshot.state.planner.journal?.checkpoints ?? []).map(history => privateRecordKey('history', history.id)), ...(captured.snapshot.sourceEvidence || captured.snapshot.version !== 1 && captured.snapshot.historicalEvidence?.snapshots.length ? [HISTORY_KEY] : [])])]
      }
      let chosen = admission ? selections.get(admission) : undefined
      if (!chosen) {
        chosen = await selectSnapshot(captured.snapshot, selection, signin, admission && scope ? { admission, scope } : undefined)
        if (admission) selections.set(admission, chosen)
      }
      let expected = await database.profileMeta.get('active')
      if (!expected) {
        expected = await initializeAccountWorkspace(database, token, blankState())
      }
      const target = await copyPreviewState(database, token, expected)
      const existing = new Map(splitWorkspace(target).map(document => [document.key, document]))
      const conflicts = splitWorkspace(chosen.selectedSnapshot.state).filter(document => (!INFRASTRUCTURE.has(document.kind) || document.kind === 'workspace-preferences' && selection.includes(document.key) && !emptyPreferences(existing.get(document.key)?.value)) && !isBlobSource(document.value) && !(document.kind === 'library-defaults' && !selection.includes(document.key)) && existing.has(document.key) && !(signin ? signinDocumentsEqual(existing.get(document.key)!, document) : jsonEqual(existing.get(document.key)!.value, document.value))).map(document => document.key)
      const incomingLineages = personalLineageChains(chosen.selectedSnapshot.state.planner.localData)
      const existingLineages = personalLineageChains(target.planner.localData)
      for (const [key, chain] of incomingLineages) {
        const prior = existingLineages.get(key)
        if (!prior || jsonEqual(prior, chain)) continue
        for (const definition of chain) {
          const index = conflicts.indexOf(privateRecordKey('personal-definition', definition.id))
          if (index >= 0) conflicts.splice(index, 1)
        }
        conflicts.push(key)
      }
      const correspondence = signin ? signinProgressCorrespondence(chosen.selectedSnapshot.state, target) : { mappings: [], problems: [] }
      for (const mapping of correspondence.mappings) if (!mapping.equivalent) conflicts.push(mapping.destinationKey)
      const estimatedBytes = chosen.selectedSnapshot.state.blobs.reduce((sum, blob) => sum + blob.ref.byteLength, 0) + new TextEncoder().encode(JSON.stringify({ ...chosen.selectedSnapshot.state, blobs: [] })).length + (chosen.inherited && captured.snapshot.version !== 1 && captured.snapshot.historicalEvidence ? captured.snapshot.historicalEvidence.blobs.reduce((sum, ref) => sum + ref.byteLength, 0) : 0) + (captured.snapshot.version === 3 ? (captured.snapshot.historicalEvidence?.catalogBodies ?? captured.snapshot.catalogBodies).reduce((sum, ref) => sum + ref.byteLength, 0) : 0)
      const preview = frozenPreview({ copyId: captured.copyId, snapshotId: await backupMetadataDigest({ id: captured.snapshot.snapshotId, vector: captured.snapshot.revisionVector }), accountId: token.accountId, records: chosen.records, selectedKeys: [...selection], closure: chosen.closure, estimatedBytes, conflicts, problems: [...chosen.problems, ...correspondence.problems], resumable: false, ...(signin ? { signin: { version: 1 as const, requiredCompanionKeys: chosen.closure.filter(record => record.sample && !selection.includes(record.key)).map(record => record.key), progressMappings: correspondence.mappings } } : {}) })
      if (started !== generation) throw new Error('Local copy preview was cancelled')
      authorities.set(preview, { token, generation, expected, snapshot: captured.snapshot, selected: chosen.selectedSnapshot, originals: captured.originals, admission })
      assertActiveProfile(token); assertMayActivate(); return preview
    } finally { database.close() }
  }
  async function previewGuestCopy(token: ProfileToken, selection: readonly string[] = [], signin = false, savedCopyId?: string): Promise<GuestCopyPreview> {
    return previewCopy(token, selection, signin, savedCopyId)
  }
  async function executeGuestCopy(token: ProfileToken, preview: GuestCopyPreview, decision?: AccountSyncAttachmentValue, preparingDecision?: AccountSyncAttachmentValue, retainPrepared = false): Promise<GuestCopyReceipt | PreparedSigninMerge | undefined> {
    const authority = authorities.get(preview)
    assertActiveProfile(token); assertMayActivate()
    if (!authority || authority.token !== token || authority.generation !== generation || preview.accountId !== token.accountId) throw new Error('Reopen this account copy preview before continuing')
    if (!preview.selectedKeys.length || preview.problems.length) throw new Error('Resolve the disclosed selection dependencies and identity conflicts before copying')
    if (busy) throw new Error('A local copy is already being prepared')
    const assertCopyActive = () => {
      assertActiveProfile(token); assertMayActivate()
      if (authority.generation !== generation) throw new Error('Local copy was cancelled')
      // A review can be retired while staging awaits storage; recheck inside the journal transaction
      if (authority.mergeReview?.disposed) throw new Error('SIGNIN_REVIEW_REQUIRED')
    }
    busy = true
    let transferred = false
    let staged: Awaited<ReturnType<typeof stageManagedGuestCopy>> | undefined
    let preparationAttachment: Awaited<ReturnType<typeof prepareAccountReceiptAttachment>> | undefined
    const database = new AccountDatabase(token.accountId)
    try {
      const row = await database.syncState.get(`guest-copy:${preview.copyId}`)
      let journal = row ? await openAccountJson(database, token, row.ref, JournalSchema) : authority.journal
      if (!journal) {
        if (preparingDecision) preparationAttachment = await prepareAccountReceiptAttachment(database, token, { expected: authority.expected, head: authority.expected.head }, preparingDecision)
        const preparationCheck = accountAttachmentCheck(database, token, { expected: authority.expected, head: authority.expected.head }, preparationAttachment)
        const snapshot = authority.snapshot!, selected = authority.selected!
        await assertOwnedWorkspaceSnapshot(snapshot)
        if (!jsonEqual(await database.profileMeta.get('active'), authority.expected)) throw new Error('The account changed after preview. Preview again before copying.')
        if (await isManagedAccountHead(database, token, authority.expected) && (managedComparisonWritesEnabled() || !preview.conflicts.length && !selected.state.conflicts.length)) {
          const includeOriginals = !!preview.signin || preview.selectedKeys.includes(HISTORY_KEY)
          const incoming = await guestEvidenceForCopy(selected, includeOriginals ? snapshot : undefined, includeOriginals ? authority.originals : undefined)
          staged = await stageManagedGuestCopy(database, token, preview, authority.expected, incoming, before => additiveCopyState(before, selected, preview), assertCopyActive, preparationAttachment, preview.conflicts.length || selected.state.conflicts.length ? selected : undefined)
          journal = staged.journal
        } else {
          const capturedPrevious = await captureAccountSyncWorkspace(database, token, authority.expected)
          const previous = { ...capturedPrevious.workspace, state: { ...capturedPrevious.workspace.state, planner: capturedPrevious.operativePlanner }, inheritedEvidence: capturedPrevious.inheritedEvidence }
          await capturedPrevious.dispose()
          const state = await additiveCopyState(previous.state, selected, preview)
          const normalized = await inheritWorkspaceSnapshot(selected, (preview.signin || preview.selectedKeys.includes(HISTORY_KEY)) ? [selected, snapshot] : [selected])
          const operation = createAccountInheritedEvidencePreparation(database, token)
          const base = previous.inheritedEvidence ? await openAccountInheritedEvidence(database, token, previous.inheritedEvidence) : undefined
          try {
            const evidence = await operation.prepare({ base, additions: [normalized] })
            const prepared = await prepareAccountWorkspaceWithEvidence(database, token, state, evidence, previous)
            const source = preview.conflicts.length || selected.state.conflicts.length ? await prepareAccountWorkspaceWithEvidence(database, token, selected.state, evidence) : undefined
            const registrations = source ? await prepareCopiedConflicts(database, token, { operationId: preview.copyId, source: source.opened, destination: previous, keys: preview.conflicts.filter(key => JSON.parse(key)[0] !== 'conflict'), owner: evidence.owner, evidence, snapshot: selected, mode: 'additive', progressMappings: preview.signin?.progressMappings.filter(mapping => !mapping.equivalent) }) : undefined
            const intent = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId: preview.copyId, portableGroupId: accountLocalId(), operation: 'workspace-command', mode: 'additive', original: { base: authority.expected.head, target: prepared.head }, base: previous.head, target: prepared.head, localRevision: authority.expected.headRevision + 1, changes: mappedChanges(previous, prepared.opened), ...(registrations ? { copiedConflicts: registrations.root } : {}) }, evidence.owner)
            journal = JournalSchema.parse({ version: 1, kind: 'guest-copy', preview, expected: authority.expected, target: prepared.head, intent: cipherRef(intent.record) })
            const saved = await stageAccountJson(database, token, journal, [previous.head, prepared.head, cipherRef(intent.record)], undefined, evidence.owner)
            await assertOwnedWorkspaceSnapshot(snapshot); await evidence.handle.check(); assertCopyActive()
            const evidenceCheck = accountInheritedEvidenceCheck(evidence.handle, database, token)
            // Stage one complete closure without changing the selected root. Only opaque references are plaintext
            // Reopening this journal uses the exact saved target and mappings, never a recaptured guest workspace
            await database.transaction('rw', database.tables, async () => {
              assertCopyActive()
              if (!jsonEqual(await database.profileMeta.get('active'), authority.expected) || await database.syncState.get(PENDING_COPY)) throw new Error('The account or pending copy changed during preparation')
              await preparationCheck?.recheckAndRetireInTransaction()
              for (const record of new Map([...prepared.records, ...(source?.records ?? []), ...(registrations?.records ?? []), ...intent.records, saved].map(record => [record.revisionId, record])).values()) await database.encryptedRevisions.add(record)
              await evidenceCheck.recheckInTransaction()
              const ref = cipherRef(saved)
              await database.syncState.add({ id: `guest-copy:${preview.copyId}`, ref })
              await database.syncState.add({ id: PENDING_COPY, ref })
              // Confirmation can resume only when its receipt and complete copy share this commit
              await preparationCheck?.installInTransaction()
              assertCopyActive()
            })
          } finally { await operation.abandon(); await base?.dispose(); await disposeWorkspaceSnapshot(normalized) }
        }
      }
      if (journal.preview.copyId !== preview.copyId || journal.preview.accountId !== token.accountId) throw new Error('Saved copy identity mismatch')
      // Preparation never changes the selected head, queues an intent, or requests sync
      if (preparingDecision) {
        const receipt = await database.syncState.get(preparingDecision.id)
        if (!receipt || !jsonEqual(await openAccountJson(database, token, receipt.ref, z.unknown()), preparingDecision.value)) throw new Error('SIGNIN_RECEIPT_MISMATCH')
        if (!retainPrepared) return
      }
      // Keep a managed stage's exact ciphertext observations alive through the activation CAS
      // Native staging retires its evidence owner, so that fallback must reopen and authenticate
      // Cold resume independently authenticates either saved journal format
      const savedJournal = journal
      async function activatePrepared(decision?: AccountSyncAttachmentValue): Promise<GuestCopyReceipt> {
        assertCopyActive()
        const activated = await hasMatchingActivation(database, token, savedJournal)
        if (activated && decision) {
          // Replay cannot attach a new approval to data that was already selected without that approval
          const row = await database.syncState.get(decision.id)
          const activation = (await database.migrationJournal.get(preview.copyId))!
          const record = row && await database.encryptedRevisions.get(row.ref.revisionId)
          if (!row || !record || !record.descriptor.dependencies.some(ref => jsonEqual(ref, activation.head))
            || !jsonEqual(await openAccountJson(database, token, row.ref, z.unknown()), decision.value)) throw new Error('SIGNIN_RECEIPT_MISMATCH')
        }
        let mappings: readonly { readonly key: string; readonly documentId: string }[]
        if (savedJournal.version === 2) {
          mappings = activated
            ? await managedGuestCopyMappings(database, token, savedJournal)
            : staged ? await staged.activate(decision) : await activateManagedGuestCopy(database, token, savedJournal, assertCopyActive, decision)
        } else {
          const copied = await openAccountWorkspace(database, token, savedJournal.target)
          if (!activated) {
            if (await isManagedAccountHead(database, token, savedJournal.expected)) {
              // Resume the saved native target under the original fence; never recapture guest data or select a native head
              const managed = await prepareManagedAccountProjection(database, token, savedJournal.expected, { head: copied.head, entries: copied.entries, opened: copied, records: [] }, { id: preview.copyId, ref: savedJournal.intent, records: [] })
              try { await activateGuestCopyWithReceipt(database, token, managed.prepared, assertCopyActive, decision) }
              finally { await managed.dispose() }
            } else await activateGuestCopyWithReceipt(database, token, { version: 1, id: preview.copyId, expected: savedJournal.expected, head: savedJournal.target, intent: savedJournal.intent, intentStatus: 'mapped-local', records: [] }, assertCopyActive, decision)
          }
          mappings = copied.allocations
        }
        await database.transaction('rw', database.syncState, async () => {
          assertActiveProfile(token)
          const current = await database.syncState.get(PENDING_COPY), own = await database.syncState.get(`guest-copy:${preview.copyId}`)
          if (current && own && jsonEqual(current.ref, own.ref)) await database.syncState.delete(PENDING_COPY)
        })
        assertActiveProfile(token); requestSync(token, 'save')
        return { copyId: preview.copyId, accountId: token.accountId, mappings: mappings.filter(allocation => preview.closure.some(record => record.key === allocation.key)) }
      }
      if (retainPrepared) {
        let disposed = false
        const prepared: PreparedSigninMerge = Object.freeze({ copyId: preview.copyId,
          async activate(receipt: AccountSyncAttachmentValue) {
            if (disposed || busy) throw new Error('SIGNIN_REVIEW_REQUIRED')
            busy = true
            try { return await activatePrepared(receipt) } finally { busy = false }
          },
          async dispose() {
            if (disposed) return
            disposed = true; preparedMerges.delete(prepared)
            try { await staged?.dispose() } finally { database.close() }
          },
        })
        preparedMerges.add(prepared); transferred = true
        return prepared
      }
      return await activatePrepared(decision)
    } finally {
      try { if (!transferred) await staged?.dispose() }
      finally { try { if (preparationAttachment) await releaseAccountActivationAttachment(preparationAttachment) } finally { busy = false; if (!transferred) database.close() } }
    }
  }
  async function commitGuestCopy(token: ProfileToken, preview: GuestCopyPreview, decision?: AccountSyncAttachmentValue): Promise<GuestCopyReceipt> {
    const receipt = await executeGuestCopy(token, preview, decision)
    if (!receipt || 'activate' in receipt) throw new Error('The copy was not activated')
    return receipt
  }
  async function previewSigninMergeReview(token: ProfileToken, account: ReviewedAccountData): Promise<SigninMergeReview> {
    await assertReviewedAccountData(token, account)
    const preview = await previewCopy(token, [], true, undefined, true)
    await assertReviewedAccountData(token, account, authorities.get(preview)!.expected)
    const pending: PendingMergeReview = { token, generation, account, preview, disposed: false }
    authorities.set(preview, { ...authorities.get(preview)!, mergeReview: pending })
    const handle: SigninMergeReview = Object.freeze({ preview, async dispose() {
      pending.disposed = true
      authorities.delete(preview)
    } })
    mergeReviews.set(handle, pending)
    return handle
  }
  async function prepareReviewedSigninMerge(token: ProfileToken, handle: SigninMergeReview, decision: AccountSyncAttachmentValue): Promise<PreparedSigninMerge> {
    const pending = mergeReviews.get(handle)
    assertActiveProfile(token); assertMayActivate()
    if (!pending || pending.disposed || pending.token !== token || pending.generation !== generation) throw new Error('SIGNIN_REVIEW_REQUIRED')
    const authority = authorities.get(pending.preview)
    if (!authority) throw new Error('SIGNIN_REVIEW_REQUIRED')
    await assertReviewedAccountData(token, pending.account, authority.expected)
    if (authority.admission) await validateSnapshotBodies(authority.admission)
    // Only the exact in-memory handle can start new durable preparation after Confirm
    // Existing journals retain their original readers and resume without this ephemeral owner
    const prepared = await executeGuestCopy(token, pending.preview, undefined, decision, true)
    if (!prepared || !('activate' in prepared)) throw new Error('SIGNIN_RECEIPT_MISMATCH')
    return prepared
  }
  async function prepareSigninMerge(token: ProfileToken, preview: GuestCopyPreview, decision: AccountSyncAttachmentValue): Promise<void> {
    if (!preview.signin) throw new Error('Only sign-in copies can prepare a confirmation')
    await executeGuestCopy(token, preview, undefined, decision)
  }
  async function keepSavedCopyAndRepreview(token: ProfileToken, preview: GuestCopyPreview): Promise<{ activated: boolean }> {
    assertActiveProfile(token); assertMayActivate()
    const authority = authorities.get(preview)
    if (!authority?.journal || authority.token !== token || authority.generation !== generation) throw new Error('Reopen this account copy preview before continuing')
    if (busy) throw new Error('A local copy is already being prepared')
    const check = () => { assertActiveProfile(token); assertMayActivate(); if (authority.generation !== generation) throw new Error('Local copy was cancelled') }
    const database = new AccountDatabase(token.accountId)
    busy = true
    try {
      const receipt = await database.migrationJournal.get(preview.copyId)
      const matching = await hasMatchingActivation(database, token, authority.journal!)
      const activated = await database.transaction('rw', database.syncState, database.migrationJournal, async () => {
        check()
        const pending = await database.syncState.get(PENDING_COPY), own = await database.syncState.get(`${SAVED_COPY_PREFIX}${preview.copyId}`)
        if (!pending || !own || !jsonEqual(pending.ref, own.ref) || !jsonEqual(await database.migrationJournal.get(preview.copyId), receipt)) throw new Error('The pending copy changed. Reopen its preview.')
        // Authenticate the encrypted activation receipt before opening the pointer transaction
        const activated = matching
        // Retire only the blocking pointer. The immutable encrypted journal, target, intent and
        // allocations remain downloadable; a fresh capture must receive a different operation ID
        await database.syncState.delete(PENDING_COPY)
        check(); return activated
      })
      await dispose()
      return { activated }
    } finally { busy = false; database.close() }
  }
  async function listSavedGuestCopies(token: ProfileToken): Promise<readonly SavedGuestCopy[]> {
    assertActiveProfile(token)
    const database = new AccountDatabase(token.accountId), started = generation
    try {
      const pending = await database.syncState.get(PENDING_COPY)
      const saved: SavedGuestCopy[] = []
      for (const row of await database.syncState.where('id').startsWith(SAVED_COPY_PREFIX).toArray()) {
        if (row.id === PENDING_COPY) continue
        const journal = await openAccountJson(database, token, row.ref, JournalSchema)
        if (journal.preview.accountId !== token.accountId || row.id !== `${SAVED_COPY_PREFIX}${journal.preview.copyId}`) throw new Error('Saved copy identity mismatch')
        saved.push({ copyId: journal.preview.copyId, labels: journal.preview.records.filter(record => journal.preview.selectedKeys.includes(record.key)).map(record => record.label), activated: await hasMatchingActivation(database, token, journal), pending: !!pending && jsonEqual(pending.ref, row.ref) })
      }
      assertActiveProfile(token)
      if (started !== generation) throw new Error('Saved copy inspection was cancelled')
      return saved
    } finally { database.close() }
  }
  async function withSavedGuestCopy(token: ProfileToken, copyId: string, read: (snapshot: WorkspaceSnapshot) => Promise<void>): Promise<void> {
    assertActiveProfile(token)
    const database = new AccountDatabase(token.accountId), started = generation
    let snapshot: WorkspaceSnapshot | undefined
    const check = async () => { assertActiveProfile(token); if (started !== generation) throw new Error('Saved copy download was cancelled') }
    try {
      const row = await database.syncState.get(`${SAVED_COPY_PREFIX}${copyId}`)
      if (!row || row.id === PENDING_COPY) throw new Error('The saved copy is unavailable')
      const journal = await openAccountJson(database, token, row.ref, JournalSchema)
      if (journal.preview.copyId !== copyId || journal.preview.accountId !== token.accountId) throw new Error('Saved copy identity mismatch')
      const captured = { key: 'active' as const, headRevision: journal.expected.headRevision + 1, head: journal.target }
      if (journal.version === 2) snapshot = await captureRetainedManagedAccountSnapshot(database, token, captured, check)
      else {
        const workspace = await openAccountWorkspace(database, token, journal.target)
        // This immutable staged target is deliberately independent of the active account fence
        // Reuse complete-backup capture so exact inherited originals and lazy bodies stay closed
        snapshot = await captureAccountSnapshot(workspace, captured, check, { database, token })
      }
      await check(); await read(snapshot); await check()
    } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); database.close() }
  }
  async function inspectCopiedComparisons(token: ProfileToken): Promise<readonly CopiedComparisonView[]> {
    assertActiveProfile(token)
    const database = new AccountDatabase(token.accountId)
    try {
      const fence = await database.profileMeta.get('active')
      if (!fence) return []
      const reader = createCopiedConflictReader(database, token)
      const capturedActive = await captureAccountSyncWorkspace(database, token, fence)
      const active = { ...capturedActive.workspace, inheritedEvidence: capturedActive.inheritedEvidence }
      await capturedActive.dispose()
      const comparisons: CopiedComparisonView[] = []
      const registeredIds = new Set<string>()
      // The existing atomic activation receipt serves copy and explicit restore alike
      for (const row of await database.migrationJournal.toArray()) {
        if (!row.intent) continue
        const intentRef = row.cloudStatus === 'mapped-local' ? row.intent : await readIncrementalMappedIntent(database, token, row.id, row.intent)
        if (!intentRef) continue
        const intent = await openAccountJson(database, token, intentRef, MappedWorkspaceIntentSchema)
        if (intent.operationId !== row.id) throw new Error('Comparison receipt identity mismatch')
        for (const entry of await reader.registrations(intent)) {
          if (!entry.original || registeredIds.has(entry.id)) continue
          registeredIds.add(entry.id)
          const source = await reader.workspace(entry.original.source)
          const original = source.state.conflicts.find(value => value.id === entry.original!.conflictId)
          if (!original) throw new Error('Original copied comparison is unavailable')
          const versions = await Promise.all(original.branches.map(branch => inspectWorkspaceClosure(source.state, branch.closure)))
          comparisons.push({ historical: false, copyId: intent.operationId, id: entry.id, originalId: original.id, registered: active.state.conflicts.some(value => value.id === entry.id), collision: active.state.conflicts.some(value => value.id === entry.original!.collisionId && value.disposition.kind === 'unresolved'), versions: versions.map(value => ({ value: value.value, documents: [...value.documents.values()] })), blobs: source.state.blobs })
        }
      }
      if (active.inheritedEvidence) {
        const reader = await openAccountInheritedEvidence(database, token, active.inheritedEvidence)
        originalReaders.add(reader)
        try {
          const sources = await accountInheritedSources(reader)
          const registry = new Map(sources.bodies.map(blob => [blobIdentity(blob.ref), blob]))
          const seen = new Set(comparisons.map(value => value.originalId))
          for (const member of sources.members) {
            const snapshot = attachBackupBodies(await readBackupMetadata(member.metadata) as SnapshotMetadataV1, registry)
            for (const original of snapshot.state.conflicts) {
              if (seen.has(original.id)) continue
              const versions = await Promise.all(original.branches.map(branch => inspectWorkspaceClosure(snapshot.state, branch.closure)))
              const id = `${member.id}:${original.id}`
              retainedPreviews.set(id, { token, snapshot: ownWorkspaceSnapshot(snapshot, { check: () => reader.check(), async dispose() {} }), conflictId: original.id })
              comparisons.push({ id, originalId: original.id, registered: false, collision: false, historical: true, versions: versions.map(value => ({ value: value.value, documents: [...value.documents.values()] })), blobs: snapshot.state.blobs })
              seen.add(original.id)
            }
          }
        } catch (error) { originalReaders.delete(reader); await reader.dispose(); throw error }
      }
      assertActiveProfile(token)
      // Inspection returns lazy exact file bodies. Keep their encrypted reader alive through preview
      // and release it with the owning account view, not before the UI consumes those bodies
      inspectionDatabases.add(database)
      return comparisons
    } finally { if (!inspectionDatabases.has(database)) database.close() }
  }
  async function previewRetainedComparison(token: ProfileToken, id: string): Promise<GuestCopyPreview> {
    assertActiveProfile(token); assertMayActivate()
    if (busy) throw new Error('A local copy is already being prepared')
    const retained = retainedPreviews.get(id)
    if (!retained || retained.token !== token) throw new Error('Reopen the retained original in this account')
    await assertOwnedWorkspaceSnapshot(retained.snapshot)
    generation++
    if (captured) await disposeWorkspaceSnapshot(captured.snapshot)
    captured = { token, snapshot: retained.snapshot, copyId: accountLocalId() }
    // This explicit preview creates a fresh operation. Historical receipts never resume remote commands
    return previewGuestCopy(token, [privateRecordKey('conflict', retained.conflictId)])
  }
  async function continueCopiedComparisons(token: ProfileToken, copyId: string): Promise<void> {
    assertActiveProfile(token); assertMayActivate()
    if (busy) throw new Error('A local copy is already being prepared')
    busy = true
    const started = generation, database = new AccountDatabase(token.accountId)
    const owner = createAccountPreparationOwner(database, token)
    const check = () => { assertActiveProfile(token); assertMayActivate(); if (started !== generation) throw new Error('Copied comparison continuation was cancelled') }
    try {
      if (await database.outbox.count() || await database.syncState.get('publication')) throw new Error('Finish syncing the saved choice before continuing copied comparisons')
      const saved = await database.syncState.get(`${SAVED_COPY_PREFIX}${copyId}`)
      if (saved) {
        const journal = await openAccountJson(database, token, saved.ref, JournalSchema)
        if (journal.preview.copyId !== copyId || journal.preview.accountId !== token.accountId) throw new Error('Saved copy identity mismatch')
        // Managed copies publish through their durable mapping receipt; old V1 copies have no comparisons
        if (journal.version === 2) {
          if (!await hasMatchingActivation(database, token, journal)) throw new Error('The saved copy has not been added')
          if (!await readIncrementalMappedIntent(database, token, copyId, journal.intent)) { check(); return }
        }
      }
      const row = await database.migrationJournal.get(copyId)
      if (!row?.intent) throw new Error('The saved import is unavailable')
      const intentRef = row.cloudStatus === 'mapped-local' ? row.intent : await readIncrementalMappedIntent(database, token, copyId, row.intent)
      if (!intentRef) throw new Error('The saved import is unavailable')
      const original = await openAccountJson(database, token, intentRef, MappedWorkspaceIntentSchema)
      if (original.operationId !== copyId) throw new Error('Foreign saved import')
      const entries = await readCopiedConflicts(database, token, original)
      const expected = await database.profileMeta.get('active')
      if (!expected) throw new Error('The account workspace is unavailable')
      const capturedCurrent = await captureAccountSyncWorkspace(database, token, expected)
      const current = capturedCurrent.workspace
      await capturedCurrent.dispose()
      const pending = entries.filter(entry => entry.original && !current.state.conflicts.some(value => value.id === entry.id))
      if (!pending.length) return
      const id = accountLocalId()
      const registrations = await stageCopiedConflictRegistrations(database, token, id, pending.map(entry => ({ ...entry, mode: 'additive' })), owner)
      const intent = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId: id, portableGroupId: accountLocalId(), operation: 'workspace-command', mode: 'additive', original: { base: current.head, target: current.head }, base: current.head, target: current.head, localRevision: expected.headRevision + 1, changes: [], copiedConflicts: registrations.root }, owner)
      check()
      if (capturedCurrent.managed) {
        const managed = await prepareManagedAccountProjection(database, token, expected, { head: current.head, entries: current.entries, opened: current, records: registrations.records }, { id, ref: cipherRef(intent.record), records: intent.records }, true)
        try { await activateLocalAccountCommit(database, token, managed.prepared, check) }
        finally { await managed.dispose() }
      } else await activateLocalAccountCommit(database, token, { version: 1, id, expected, head: current.head, intent: cipherRef(intent.record), intentStatus: 'mapped-local', records: [...registrations.records, ...intent.records], requireSettledSync: true }, check)
      requestSync(token, 'save')
    } finally { await owner.abandon(); busy = false; database.close() }
  }
  return { previewSigninMergeReview, prepareReviewedSigninMerge, prepareSigninMerge, previewGuestCopy, previewSigninMerge: (token: ProfileToken, savedCopyId?: string) => previewGuestCopy(token, [], true, savedCopyId), commitGuestCopy, keepSavedCopyAndRepreview, listSavedGuestCopies, withSavedGuestCopy, inspectCopiedComparisons, previewRetainedComparison, continueCopiedComparisons, dispose }
}
const defaultService = createGuestCopyService(() => captureGuestWorkspaceForCopy())
export const previewGuestCopy = defaultService.previewGuestCopy
export const commitGuestCopy = defaultService.commitGuestCopy

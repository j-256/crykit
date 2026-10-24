import { guestEvidenceForCopy, type CapturedGuestEvidence } from './guest-evidence'
import { GuestCopyJournalSchema as JournalSchema, PENDING_COPY, PreviewSchema, SAVED_COPY_PREFIX, type GuestCopyJournal as Journal, type GuestCopyPreview } from './guest-copy-journal'
import { activateManagedGuestCopy, managedGuestCopyMappings, stageManagedGuestCopy } from './managed-guest-copy'
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
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { requestSync } from '../account/sync/scheduler'
import { AccountDatabase, activateLocalAccountCommit, type AccountFence } from '../persistence/account-database'
import { createBlankLocalData } from '../domain/local-data'
import { jsonEqual } from '../persistence/local-data'
import { attachBackupBodies, inheritWorkspaceSnapshot, readBackupMetadata, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
import { accountLocalId, cipherRef, openAccountJson, stageAccountJson } from './account-cache'
import { accountInheritedSources, createAccountInheritedEvidencePreparation, openAccountInheritedEvidence, type AccountInheritedEvidence } from './account-evidence-snapshots'
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
interface Authority { readonly token: ProfileToken; readonly generation: number; readonly expected: AccountFence; readonly snapshot?: WorkspaceSnapshot; readonly selected?: WorkspaceSnapshot; readonly originals?: CapturedGuestEvidence; readonly journal?: Journal }

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

async function selectSnapshot(snapshot: WorkspaceSnapshot, selection: readonly string[]) {
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
  const records = [...documents.values()].filter(document => ROOT_KINDS.has(document.kind) && !(document.kind === 'library-defaults' && snapshot.state.libraryDefaults.layers.length === 0)).map(document => describe(document, samples.has(document.key)))
  for (const consent of sampleConsents) if (!documents.has(consent.key)) records.push({ ...describe(consent.document, true), key: consent.key, label: `Original accepted sample: ${describe(consent.document).label}` })
  const inherited = !!snapshot.sourceEvidence || snapshot.version === 2 && snapshot.historicalEvidence.snapshots.length > 0
  if (inherited) records.push({ key: HISTORY_KEY, kind: 'history', label: 'Exact inherited workspace originals (all original records, including unchecked records and samples)', sample: true })
  const offered = new Set(records.map(record => record.key)), selected = new Set(selection)
  if (selected.size !== selection.length || selection.some(key => !offered.has(key))) throw new Error('Choose only records from this local copy preview')
  const included = new Set<string>(), problems: string[] = []
  const edges = await validatedWorkspaceRetentionEdges(snapshot.state)
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
    for (const dependency of resolvedDomainClosureKeys(document, documents)) include(dependency)
    for (const ref of archiveTypedReferences(document.kind, document.value)) includeBlob(blobIdentity(ref))
  }
  for (const key of selection) if (key !== HISTORY_KEY && !sampleConsents.some(consent => consent.key === key && !documents.has(key))) include(key)
  for (const consent of sampleConsents) {
    if (selected.has(consent.key) && !documents.has(consent.key) && !included.has(consent.conflictKey)) problems.push('Select the comparison for this exact original sample.')
    if (included.has(consent.conflictKey) && !selected.has(consent.key)) problems.push(`Explicitly select the required sample record: ${describe(consent.document).label}`)
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
  for (const key of included) if (samples.has(key) && offered.has(key) && !selected.has(key) && !sampleConsents.some(consent => consent.document.key === key && selected.has(consent.key) && jsonEqual(consent.document.value, base.get(key)?.value))) problems.push(`Explicitly select the required sample record: ${records.find(record => record.key === key)!.label}`)
  const state = assembleWorkspace([...base.values()], 0)
  const selectedSnapshot = ownWorkspaceSnapshot({ version: 1, snapshotId: `${snapshot.snapshotId}:selection`, capturedAt: snapshot.capturedAt, revisionVector: snapshot.revisionVector, state }, { check: () => assertOwnedWorkspaceSnapshot(snapshot), async dispose() {} })
  await validateWorkspaceSnapshot(selectedSnapshot)
  const closure = [...included].flatMap(key => { const document = documents.get(key); return document && !['blob', 'blob-reference'].includes(document.kind) ? [describe(document, samples.has(key))] : [] })
  return { records, selectedSnapshot, closure, problems: [...new Set(problems)], inherited: selected.has(HISTORY_KEY) }
}

async function additiveCopyState(previous: WorkspaceState, selected: WorkspaceSnapshot, preview: GuestCopyPreview): Promise<WorkspaceState> {
  const documents = new Map(splitWorkspace(previous).map(document => [document.key, document]))
  const incoming = new Map(splitWorkspace(selected.state).map(document => [document.key, document]))
  const blocked = new Set(preview.conflicts)
  for (const [key, chain] of personalLineageChains(selected.state.planner.localData)) if (blocked.has(key)) for (const definition of chain) blocked.add(privateRecordKey('personal-definition', definition.id))
  // A pin to an incompatible immutable value cannot become active by copying its owner separately
  // Keep that dependent group in the exact selected source until its comparison is resolved
  let expanded = true
  while (expanded) {
    expanded = false
    for (const document of incoming.values()) {
      if (blocked.has(document.key)) continue
      const buildOwner = document.kind === 'build-checkpoint' ? privateRecordKey('build', (document.value as unknown as { buildId: string }).buildId) : undefined
      if (buildOwner && blocked.has(buildOwner)) { blocked.add(document.key); expanded = true; continue }
      if (resolvedDomainClosureKeys(document, incoming).some(key => blocked.has(key))) { blocked.add(document.key); expanded = true }
    }
  }
  for (const document of incoming.values()) {
    if (blocked.has(document.key)) continue
    if (document.kind === 'conflict' || INFRASTRUCTURE.has(document.kind) || document.kind === 'library-defaults' && !preview.selectedKeys.includes(document.key)) continue
    const prior = documents.get(document.key)
    if (prior && !isBlobSource(document.value) && !jsonEqual(prior.value, document.value)) continue
    if (!prior) documents.set(document.key, document)
  }
  const assembled = assembleWorkspace([...documents.values()], previous.planner.localData.revision, previous.planner.journal)
  const planner = projectPlanner(previous.planner, assembled.planner, false)
  const state = { ...assembled, planner: { ...planner, localData: preserveLocalSelections(planner.localData, previous.planner.localData) } }
  await validateWorkspaceClosure(state)
  return state
}

export function createGuestCopyService(capture: () => Promise<WorkspaceSnapshot | GuestCopySource>, assertMayActivate: () => void = () => {}) {
  const authorities = new WeakMap<GuestCopyPreview, Authority>()
  let captured: { token: ProfileToken; snapshot: WorkspaceSnapshot; copyId: string; originals?: CapturedGuestEvidence } | undefined
  const inspectionDatabases = new Set<AccountDatabase>()
  const originalReaders = new Set<AccountInheritedEvidence>()
  const retainedPreviews = new Map<string, { token: ProfileToken; snapshot: WorkspaceSnapshot; conflictId: string }>()
  let busy = false
  let generation = 0
  const dispose = async () => { generation++; const prior = captured; captured = undefined; await Promise.all([...originalReaders].map(reader => reader.dispose())); originalReaders.clear(); retainedPreviews.clear(); for (const database of inspectionDatabases) database.close(); inspectionDatabases.clear(); if (prior) await disposeWorkspaceSnapshot(prior.snapshot) }
  async function previewGuestCopy(token: ProfileToken, selection: readonly string[] = []): Promise<GuestCopyPreview> {
    assertActiveProfile(token); assertMayActivate()
    if (busy) throw new Error('A local copy is already being prepared')
    const database = new AccountDatabase(token.accountId)
    try {
      const pending = await database.syncState.get(PENDING_COPY)
      if (pending) {
        const journal = await openAccountJson(database, token, pending.ref, JournalSchema)
        if (journal.preview.accountId !== token.accountId) throw new Error('The saved copy belongs to another account')
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
      await validateWorkspaceSnapshot(captured.snapshot)
      const chosen = await selectSnapshot(captured.snapshot, selection)
      let expected = await database.profileMeta.get('active')
      if (!expected) {
        expected = await initializeAccountWorkspace(database, token, blankState())
      }
      const target = await copyPreviewState(database, token, expected)
      const existing = new Map(splitWorkspace(target).map(document => [document.key, document]))
      const conflicts = splitWorkspace(chosen.selectedSnapshot.state).filter(document => !INFRASTRUCTURE.has(document.kind) && !isBlobSource(document.value) && !(document.kind === 'library-defaults' && !selection.includes(document.key)) && existing.has(document.key) && !jsonEqual(existing.get(document.key)!.value, document.value)).map(document => document.key)
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
      const estimatedBytes = chosen.selectedSnapshot.state.blobs.reduce((sum, blob) => sum + blob.ref.byteLength, 0) + new TextEncoder().encode(JSON.stringify({ ...chosen.selectedSnapshot.state, blobs: [] })).length + (chosen.inherited && captured.snapshot.version === 2 ? captured.snapshot.historicalEvidence.blobs.reduce((sum, ref) => sum + ref.byteLength, 0) : 0)
      const preview = frozenPreview({ copyId: captured.copyId, snapshotId: await backupMetadataDigest({ id: captured.snapshot.snapshotId, vector: captured.snapshot.revisionVector }), accountId: token.accountId, records: chosen.records, selectedKeys: [...selection], closure: chosen.closure, estimatedBytes, conflicts, problems: chosen.problems, resumable: false })
      if (started !== generation) throw new Error('Local copy preview was cancelled')
      authorities.set(preview, { token, generation, expected, snapshot: captured.snapshot, selected: chosen.selectedSnapshot, originals: captured.originals })
      assertActiveProfile(token); assertMayActivate(); return preview
    } finally { database.close() }
  }
  async function commitGuestCopy(token: ProfileToken, preview: GuestCopyPreview): Promise<GuestCopyReceipt> {
    const authority = authorities.get(preview)
    assertActiveProfile(token); assertMayActivate()
    if (!authority || authority.token !== token || authority.generation !== generation || preview.accountId !== token.accountId) throw new Error('Reopen this account copy preview before continuing')
    if (!preview.selectedKeys.length || preview.problems.length) throw new Error('Resolve the disclosed selection dependencies and identity conflicts before copying')
    if (busy) throw new Error('A local copy is already being prepared')
    const assertCopyActive = () => { assertActiveProfile(token); assertMayActivate(); if (authority.generation !== generation) throw new Error('Local copy was cancelled') }
    busy = true
    let staged: Awaited<ReturnType<typeof stageManagedGuestCopy>> | undefined
    const database = new AccountDatabase(token.accountId)
    try {
      const row = await database.syncState.get(`guest-copy:${preview.copyId}`)
      let journal = row ? await openAccountJson(database, token, row.ref, JournalSchema) : authority.journal
      if (!journal) {
        const snapshot = authority.snapshot!, selected = authority.selected!
        await assertOwnedWorkspaceSnapshot(snapshot)
        if (!jsonEqual(await database.profileMeta.get('active'), authority.expected)) throw new Error('The account changed after preview. Preview again before copying.')
        if (await isManagedAccountHead(database, token, authority.expected) && !preview.conflicts.length && !selected.state.conflicts.length) {
          const includeOriginals = preview.selectedKeys.includes(HISTORY_KEY)
          const incoming = await guestEvidenceForCopy(selected, includeOriginals ? snapshot : undefined, includeOriginals ? authority.originals : undefined)
          staged = await stageManagedGuestCopy(database, token, preview, authority.expected, incoming, before => additiveCopyState(before, selected, preview), assertCopyActive)
          journal = staged.journal
        } else {
          const capturedPrevious = await captureAccountSyncWorkspace(database, token, authority.expected)
          const previous = { ...capturedPrevious.workspace, state: { ...capturedPrevious.workspace.state, planner: capturedPrevious.operativePlanner }, inheritedEvidence: capturedPrevious.inheritedEvidence }
          await capturedPrevious.dispose()
          const state = await additiveCopyState(previous.state, selected, preview)
          const normalized = await inheritWorkspaceSnapshot(selected, preview.selectedKeys.includes(HISTORY_KEY) ? [selected, snapshot] : [selected])
          const operation = createAccountInheritedEvidencePreparation(database, token)
          const base = previous.inheritedEvidence ? await openAccountInheritedEvidence(database, token, previous.inheritedEvidence) : undefined
          try {
            const evidence = await operation.prepare({ base, additions: [normalized] })
            const prepared = await prepareAccountWorkspaceWithEvidence(database, token, state, evidence, previous)
            const source = preview.conflicts.length || selected.state.conflicts.length ? await prepareAccountWorkspaceWithEvidence(database, token, selected.state, evidence) : undefined
            const registrations = source ? await prepareCopiedConflicts(database, token, { operationId: preview.copyId, source: source.opened, destination: previous, keys: preview.conflicts.filter(key => JSON.parse(key)[0] !== 'conflict'), owner: evidence.owner, evidence, snapshot: selected, mode: 'additive' }) : undefined
            const intent = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId: preview.copyId, portableGroupId: accountLocalId(), operation: 'workspace-command', mode: 'additive', original: { base: authority.expected.head, target: prepared.head }, base: previous.head, target: prepared.head, localRevision: authority.expected.headRevision + 1, changes: mappedChanges(previous, prepared.opened), ...(registrations ? { copiedConflicts: registrations.root } : {}) }, evidence.owner)
            journal = JournalSchema.parse({ version: 1, kind: 'guest-copy', preview, expected: authority.expected, target: prepared.head, intent: cipherRef(intent.record) })
            const saved = await stageAccountJson(database, token, journal, [previous.head, prepared.head, cipherRef(intent.record)], undefined, evidence.owner)
            await assertOwnedWorkspaceSnapshot(snapshot); await evidence.handle.check(); assertCopyActive()
            // Stage one complete closure without changing the selected root. Only opaque references are plaintext
            // Reopening this journal uses the exact saved target and mappings, never a recaptured guest workspace
            await database.transaction('rw', database.tables, async () => {
              assertCopyActive()
              if (!jsonEqual(await database.profileMeta.get('active'), authority.expected) || await database.syncState.get(PENDING_COPY)) throw new Error('The account or pending copy changed during preparation')
              for (const record of new Map([...prepared.records, ...(source?.records ?? []), ...(registrations?.records ?? []), ...intent.records, saved].map(record => [record.revisionId, record])).values()) await database.encryptedRevisions.add(record)
              const ref = cipherRef(saved)
              await database.syncState.add({ id: `guest-copy:${preview.copyId}`, ref })
              await database.syncState.add({ id: PENDING_COPY, ref })
              assertCopyActive()
            })
          } finally { await operation.abandon(); await base?.dispose(); await disposeWorkspaceSnapshot(normalized) }
        }
      }
      if (journal.preview.copyId !== preview.copyId || journal.preview.accountId !== token.accountId) throw new Error('Saved copy identity mismatch')
      let mappings: readonly { readonly key: string; readonly documentId: string }[]
      if (journal.version === 2) {
        mappings = await hasMatchingActivation(database, token, journal)
          ? await managedGuestCopyMappings(database, token, journal)
          : staged ? await staged.activate() : await activateManagedGuestCopy(database, token, journal, assertCopyActive)
      } else {
        const copied = await openAccountWorkspace(database, token, journal.target)
        if (!await hasMatchingActivation(database, token, journal)) {
          if (await isManagedAccountHead(database, token, journal.expected)) {
            // Resume the saved native target under the original fence; never recapture guest data or select a native head
            const managed = await prepareManagedAccountProjection(database, token, journal.expected, { head: copied.head, entries: copied.entries, opened: copied, records: [] }, { id: preview.copyId, ref: journal.intent, records: [] })
            try { await activateLocalAccountCommit(database, token, managed.prepared, assertCopyActive) }
            finally { await managed.dispose() }
          } else await activateLocalAccountCommit(database, token, { version: 1, id: preview.copyId, expected: journal.expected, head: journal.target, intent: journal.intent, intentStatus: 'mapped-local', records: [] }, assertCopyActive)
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
    } finally { try { await staged?.dispose() } finally { busy = false; database.close() } }
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
        if (!row.intent || row.cloudStatus !== 'mapped-local') continue
        const intent = await openAccountJson(database, token, row.intent, MappedWorkspaceIntentSchema)
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
        // Managed copies have no imported comparisons; their ordinary intent owns background publication
        if (journal.version === 2) {
          if (!await hasMatchingActivation(database, token, journal)) throw new Error('The saved copy has not been added')
          check(); return
        }
      }
      const row = await database.migrationJournal.get(copyId)
      if (!row?.intent || row.cloudStatus !== 'mapped-local') throw new Error('The saved import is unavailable')
      const original = await openAccountJson(database, token, row.intent, MappedWorkspaceIntentSchema)
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
  return { previewGuestCopy, commitGuestCopy, keepSavedCopyAndRepreview, listSavedGuestCopies, withSavedGuestCopy, inspectCopiedComparisons, previewRetainedComparison, continueCopiedComparisons, dispose }
}
const defaultService = createGuestCopyService(() => captureGuestWorkspaceForCopy())
export const previewGuestCopy = defaultService.previewGuestCopy
export const commitGuestCopy = defaultService.commitGuestCopy

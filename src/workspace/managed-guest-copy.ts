import { stageManagedCopyComparisons, managedComparisonWritesEnabled } from './managed-copy-comparisons'
import type { WorkspaceSnapshot } from './snapshot'
import { accountAttachmentCheck, type AccountActivationAttachment, prepareAccountReceiptAttachment, releaseAccountActivationAttachment, type AccountSyncAttachmentValue } from '../persistence/account-activation-attachments'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { activateLocalAccountCommit, type AccountDatabase, type AccountFence, type PreparedLocalActivation } from '../persistence/account-database'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { createAccountLocalStore } from './account-local-store'
import { IncrementalWorkspaceIntentSchema } from './account-mapping-origin'
import { memoryBlob } from './blobs'
import type { WorkspaceState } from './documents'
import { mergeGuestEvidence, type CapturedGuestEvidence } from './guest-evidence'
import { ManagedGuestCopyJournalSchema, PENDING_COPY, SAVED_COPY_PREFIX, type GuestCopyPreview, type ManagedGuestCopyJournal } from './guest-copy-journal'
import { readLocalEvidence, prepareLocalEvidence } from './local-evidence'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'

export async function stageManagedGuestCopy(database: AccountDatabase, token: ProfileToken, preview: GuestCopyPreview, input: AccountFence, incoming: CapturedGuestEvidence, mergeCurrent: (before: WorkspaceState) => Promise<WorkspaceState>, assertMayActivate: () => void, preparationAttachment?: AccountActivationAttachment, selected?: WorkspaceSnapshot) {
  assertActiveProfile(token)
  if (selected && !managedComparisonWritesEnabled()) throw new Error('Managed comparison writers are not qualified')
  if (preview.accountId !== token.accountId) throw new Error('The copy belongs to another account')
  const expected = structuredClone(input), store = createAccountLocalStore(database, token), id = preview.copyId
  const check = async () => {
    assertActiveProfile(token); assertMayActivate()
    if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), expected)) throw new Error('The copy destination changed')
    assertActiveProfile(token); assertMayActivate()
  }
  let retained = false
  try {
    await check()
    const before = await admitLocalRoot(store.adapter, expected.head, store.lifetime)
    await check()
    const previous = await readLocalEvidence(store.adapter, before.root.inheritedEvidence, check)
    await incoming.check()
    const evidence = previous ? await mergeGuestEvidence(previous, incoming, previous.planner) : incoming
    const inherited = await prepareLocalEvidence(store.adapter, id, evidence)
    const state = await mergeCurrent(before.state)
    const result = await prepareLocalWorkspace(store.adapter, id, state, store.lifetime, before, inherited)
    const source = selected ? await prepareLocalWorkspace(store.adapter, id, selected.state, store.lifetime, undefined, inherited) : undefined
    const copiedComparisons = source && selected ? await stageManagedCopyComparisons(store.adapter, id, selected, source.snapshot, before, expected, preview.conflicts.filter(key => JSON.parse(key)[0] !== 'conflict'), preview.signin?.progressMappings ?? []) : undefined
    const projection = await database.syncState.get('projection')
    const intent = IncrementalWorkspaceIntentSchema.parse({ version: copiedComparisons ? 2 : 1, ...(copiedComparisons ? { copiedComparisons } : {}), kind: 'incremental-workspace-intent', operationId: id, operation: 'workspace-command', mode: 'additive', sequence: expected.headRevision + 1, before: expected.head, after: result.head, ...(projection ? { publicationBase: projection.ref } : {}) })
    const encode = (value: unknown) => memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
    const intentRef = await store.adapter.stage(id, encode(intent), [expected.head, result.head, ...(copiedComparisons ? [copiedComparisons] : []), ...(projection ? [projection.ref] : [])])
    const journal = ManagedGuestCopyJournalSchema.parse({ version: 2, kind: 'guest-copy', preview, expected, target: result.head, intent: intentRef })
    const ref = await store.adapter.stage(id, encode(journal), [expected.head, result.head, intentRef])
    await incoming.check(); await evidence.check(); await check()
    // A saved journal owns the complete encrypted target even if activation is interrupted
    // It cannot make that target active or upload it until the separate captured-head CAS succeeds
    const preparationCheck = accountAttachmentCheck(database, token, { expected, head: expected.head }, preparationAttachment)
    await store.persistOperation(id, async () => {
      await preparationCheck?.recheckAndRetireInTransaction()
      if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), expected) || await database.syncState.get(PENDING_COPY)) throw new Error('The account or pending copy changed during preparation')
      await database.syncState.add({ id: `${SAVED_COPY_PREFIX}${id}`, ref })
      await database.syncState.add({ id: PENDING_COPY, ref })
      // The durable decision and exact encrypted target become resumable together
      await preparationCheck?.installInTransaction()
    }, assertMayActivate)
    const prepared = await store.preparePersistedActivation(id, result, expected, before, intentRef, projection)
    retained = true
    return { journal, async activate(receipt?: AccountSyncAttachmentValue) {
      await activateGuestCopyWithReceipt(database, token, prepared, assertMayActivate, receipt)
      return result.snapshot.entries.map(entry => ({ key: entry.key, documentId: entry.ref.documentId }))
    }, async dispose() { await store.dispose() } }
  } finally { if (!retained) await store.dispose() }
}

export async function activateManagedGuestCopy(database: AccountDatabase, token: ProfileToken, journal: ManagedGuestCopyJournal, assertMayActivate: () => void, receipt?: AccountSyncAttachmentValue) {
  const store = createAccountLocalStore(database, token)
  try {
    const { prepared, snapshot } = await store.prepareSavedActivation(journal.preview.copyId, journal.target, journal.intent, journal.expected)
    await activateGuestCopyWithReceipt(database, token, prepared, assertMayActivate, receipt)
    return snapshot.entries.map(entry => ({ key: entry.key, documentId: entry.ref.documentId }))
  } finally { await store.dispose() }
}

export async function managedGuestCopyMappings(database: AccountDatabase, token: ProfileToken, journal: ManagedGuestCopyJournal) {
  const store = createAccountLocalStore(database, token)
  try {
    // An acknowledged saved copy can be inspected after later edits without following their selected root
    const saved = await admitLocalRoot(store.adapter, journal.target, store.lifetime)
    return saved.entries.map(entry => ({ key: entry.key, documentId: entry.ref.documentId }))
  } finally { await store.dispose() }
}

// The receipt is encrypted against the actual target, including native-to-managed projection targets
export async function activateGuestCopyWithReceipt(database: AccountDatabase, token: ProfileToken, prepared: PreparedLocalActivation, check: () => void, receipt?: AccountSyncAttachmentValue) {
  const attachment = receipt ? await prepareAccountReceiptAttachment(database, token, prepared, receipt) : undefined
  try { return await activateLocalAccountCommit(database, token, prepared, check, attachment) }
  finally { if (attachment) await releaseAccountActivationAttachment(attachment) }
}

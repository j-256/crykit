import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { activateLocalAccountCommit, type AccountDatabase, type AccountFence } from '../persistence/account-database'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { createAccountLocalStore } from './account-local-store'
import { IncrementalWorkspaceIntentSchema } from './account-mapping-origin'
import { memoryBlob } from './blobs'
import type { WorkspaceState } from './documents'
import { mergeGuestEvidence, type CapturedGuestEvidence } from './guest-evidence'
import { ManagedGuestCopyJournalSchema, PENDING_COPY, SAVED_COPY_PREFIX, type GuestCopyPreview, type ManagedGuestCopyJournal } from './guest-copy-journal'
import { readLocalEvidence, prepareLocalEvidence } from './local-evidence'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'

export async function stageManagedGuestCopy(database: AccountDatabase, token: ProfileToken, preview: GuestCopyPreview, input: AccountFence, incoming: CapturedGuestEvidence, mergeCurrent: (before: WorkspaceState) => Promise<WorkspaceState>, assertMayActivate: () => void) {
  assertActiveProfile(token)
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
    const projection = await database.syncState.get('projection')
    const intent = IncrementalWorkspaceIntentSchema.parse({ version: 1, kind: 'incremental-workspace-intent', operationId: id, operation: 'workspace-command', mode: 'additive', sequence: expected.headRevision + 1, before: expected.head, after: result.head, ...(projection ? { publicationBase: projection.ref } : {}) })
    const encode = (value: unknown) => memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
    const intentRef = await store.adapter.stage(id, encode(intent), [expected.head, result.head, ...(projection ? [projection.ref] : [])])
    const journal = ManagedGuestCopyJournalSchema.parse({ version: 2, kind: 'guest-copy', preview, expected, target: result.head, intent: intentRef })
    const ref = await store.adapter.stage(id, encode(journal), [expected.head, result.head, intentRef])
    await incoming.check(); await evidence.check(); await check()
    // A saved journal owns the complete encrypted target even if activation is interrupted
    // It cannot make that target active or upload it until the separate captured-head CAS succeeds
    await store.persistOperation(id, async () => {
      if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), expected) || await database.syncState.get(PENDING_COPY)) throw new Error('The account or pending copy changed during preparation')
      await database.syncState.add({ id: `${SAVED_COPY_PREFIX}${id}`, ref })
      await database.syncState.add({ id: PENDING_COPY, ref })
    }, assertMayActivate)
    const prepared = await store.preparePersistedActivation(id, result, expected, before, intentRef, projection)
    retained = true
    return { journal, async activate() {
      await activateLocalAccountCommit(database, token, prepared, assertMayActivate)
      return result.snapshot.entries.map(entry => ({ key: entry.key, documentId: entry.ref.documentId }))
    }, async dispose() { await store.dispose() } }
  } finally { if (!retained) await store.dispose() }
}

export async function activateManagedGuestCopy(database: AccountDatabase, token: ProfileToken, journal: ManagedGuestCopyJournal, assertMayActivate: () => void) {
  const store = createAccountLocalStore(database, token)
  try {
    const { prepared, snapshot } = await store.prepareSavedActivation(journal.preview.copyId, journal.target, journal.intent, journal.expected)
    await activateLocalAccountCommit(database, token, prepared, assertMayActivate)
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

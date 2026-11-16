import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { assertActiveProfile, captureGuestWorkspaceEpoch, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence } from '../persistence/account-database'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { accountLocalId } from './account-cache'
import { IncrementalWorkspaceIntentSchema } from './account-mapping-origin'
import { createAccountLocalStore } from './account-local-store'
import { createGuestLocalStore, type GuestManagedManifest } from './guest-local-store'
import type { GuestCoordinatorDatabase } from './guest-coordinator'
import { admitLocalRoot, prepareLocalWorkspace, type AdmittedLocalSnapshot, type LocalStoreAdapter } from './local-root'
import { captureCompactCatalogSnapshot, compactCatalogWritersEnabled } from './catalog-capture'
import { ownWorkspaceSnapshot, disposeWorkspaceSnapshot } from './snapshot'
import { readLocalEvidence, prepareLocalEvidence } from './local-evidence'
import { guestEvidenceFromFrozenCurrent, mergeGuestEvidence, compareGuestEvidence, type CapturedGuestEvidence } from './guest-evidence'
import { memoryBlob, hashBlob, blobIdentity } from './blobs'

const requireCapability = () => { if (!compactCatalogWritersEnabled()) throw new Error('Compact catalog migration requires the synthetic qualification build') }

async function prepareCatalogEvidence(adapter: LocalStoreAdapter, operationId: string, before: AdmittedLocalSnapshot, check: () => Promise<void>) {
  const old = await readLocalEvidence(adapter, before.root.inheritedEvidence, check)
  const current = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: operationId, capturedAt: before.state.planner.localData.updatedAt, revisionVector: { root: JSON.stringify(before.head) }, state: before.state }, { check, async dispose() {} })
  const compact = await captureCompactCatalogSnapshot(current)
  try {
    const addition = await guestEvidenceFromFrozenCurrent(compact)
    const evidence = old ? await mergeGuestEvidence(old, addition, old.planner) : addition
    const ref = await prepareLocalEvidence(adapter, operationId, evidence)
    return { ref, evidence, async dispose() { await disposeWorkspaceSnapshot(compact) } }
  } catch (error) { await disposeWorkspaceSnapshot(compact); throw error }
}
async function compareReadback(before: AdmittedLocalSnapshot, after: AdmittedLocalSnapshot, expected: CapturedGuestEvidence, actual: CapturedGuestEvidence | undefined) {
  const metadata = (snapshot: AdmittedLocalSnapshot) => ({ ...snapshot.state, blobs: snapshot.state.blobs.map(body => body.ref) })
  if (!guestPlannerValuesEqual(metadata(before), metadata(after))) throw new Error('Catalog migration changed workspace values')
  if (!actual) throw new Error('Catalog migration evidence is missing')
  await compareGuestEvidence(expected, actual)
  for (const body of before.state.blobs) {
    const retained = after.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))
    if (!retained || await hashBlob(body.content) !== body.ref.sha256 || await hashBlob(retained.content) !== body.ref.sha256) throw new Error('Catalog migration changed original bytes')
  }
}

// Encoding migration changes only the selected storage root and its retained evidence
// Personal revisions, timestamps, undo history, and original native bytes remain exact
export async function prepareAccountCatalogMigration(database: AccountDatabase, token: ProfileToken, input: AccountFence) {
  requireCapability()
  const expected = structuredClone(input), store = createAccountLocalStore(database, token), operationId = accountLocalId()
  const check = async () => { assertActiveProfile(token); if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), expected)) throw new Error('Catalog migration selection changed'); assertActiveProfile(token) }
  const lifetime = { check: () => assertActiveProfile(token), assertCurrent: check }
  let evidence: Awaited<ReturnType<typeof prepareCatalogEvidence>> | undefined
  try {
    await check()
    const before = await admitLocalRoot(store.adapter, expected.head, lifetime)
    evidence = await prepareCatalogEvidence(store.adapter, operationId, before, check)
    const result = await prepareLocalWorkspace(store.adapter, operationId, before.state, lifetime, before, evidence.ref, before.destinationChanges)
    const projection = await database.syncState.get('projection')
    const intent = IncrementalWorkspaceIntentSchema.parse({ version: 1, kind: 'incremental-workspace-intent', operationId, operation: 'workspace-command', mode: 'additive', sequence: expected.headRevision + 1, before: expected.head, after: result.head, ...(projection ? { publicationBase: projection.ref } : {}) })
    const intentRef = await store.adapter.stage(operationId, memoryBlob(new TextEncoder().encode(JSON.stringify(intent))), [expected.head, result.head, ...(projection ? [projection.ref] : [])])
    // Persist inert staging before a fresh read; no outbox, decision, journal, or selected pointer is created here
    await store.persistOperation(operationId, async () => {}, () => assertActiveProfile(token))
    const reopened = await admitLocalRoot(store.adapter, result.head, lifetime)
    await compareReadback(before, reopened, evidence.evidence, await readLocalEvidence(store.adapter, reopened.root.inheritedEvidence, check))
    await check()
    const prepared = await store.preparePersistedActivation(operationId, { head: result.head, snapshot: reopened }, expected, before, intentRef, projection)
    return { prepared, async dispose() { await evidence?.dispose(); await store.dispose() } }
  } catch (error) { await evidence?.dispose(); await store.dispose(); throw error }
}

export async function migrateGuestCatalogs(database: GuestCoordinatorDatabase, expected: GuestManagedManifest, assertRetainedReady: () => void): Promise<GuestManagedManifest> {
  requireCapability()
  const epoch = captureGuestWorkspaceEpoch(), operationId = crypto.randomUUID()
  const alive = () => { epoch.assertCurrent(); assertRetainedReady() }
  const store = createGuestLocalStore(database, alive)
  const check = async () => { alive(); await store.assertCurrent(expected); alive() }
  const lifetime = { check: alive, assertCurrent: check }
  await check()
  const before = await admitLocalRoot(store.adapter, expected.root, lifetime)
  const evidence = await prepareCatalogEvidence(store.adapter, operationId, before, check)
  try {
    const result = await prepareLocalWorkspace(store.adapter, operationId, before.state, lifetime, before, evidence.ref, before.destinationChanges)
    await store.flush(operationId)
    const reader = createGuestLocalStore(database, alive)
    const reopened = await admitLocalRoot(reader.adapter, result.head, { check: alive, assertCurrent: check })
    await compareReadback(before, reopened, evidence.evidence, await readLocalEvidence(reader.adapter, reopened.root.inheritedEvidence, check))
    await check()
    try { return (await store.activate(operationId, result.head, expected, alive, before)).target }
    catch (error) {
      // Resolve an ambiguous response only from the exact durable receipt and selected target
      // Never retry activation or delete staged fallback bodies based on the exception alone
      const receipt = await store.receipt(operationId), selected = await database.active.get('active')
      if (receipt && guestPlannerValuesEqual(receipt.expected, expected) && guestPlannerValuesEqual(receipt.target.root, result.head) && guestPlannerValuesEqual(selected?.manifest, receipt.target)) return receipt.target
      throw error
    }
  } finally { await evidence.dispose() }
}

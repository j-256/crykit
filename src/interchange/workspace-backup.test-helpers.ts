import { installProfile, invalidateProfile } from '../account/profile'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { changedLocalData, historyEntry } from '../persistence/local-data'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace } from '../workspace/account-graph'
import { captureAccountSnapshot } from '../workspace/account-snapshot'
import { editorClosureFixture } from '../workspace/test-helpers'
import { disposeWorkspaceSnapshot, snapshotMetadata, type WorkspaceSnapshotV1 } from '../workspace/snapshot'
import { exportWorkspaceBackup } from './workspace-backup'

async function freeze(snapshot: WorkspaceSnapshotV1) {
  const chunks = []
  for await (const bytes of exportWorkspaceBackup(snapshot)) chunks.push(bytes.slice())
  return { archive: Buffer.concat(chunks).toString('base64'), metadata: snapshotMetadata(snapshot) }
}

// Build launch archives through real encrypted capture so annex assertions use authenticated units
// Cached immutable wire bytes are reopened independently by every test and never borrow profile keys
async function createFixtures() {
  const fixture = await editorClosureFixture()
  const file = { ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { zeta: '\ud800', alpha: 'a' } } }
  const before = fixture.state.planner.localData
  const localData = changedLocalData(before, before, 'fixture-history', before.updatedAt)
  const checkpoint = historyEntry(before, localData, 'fixture-history', localData.updatedAt)
  const planner = { ...fixture.state.planner, localData, history: [checkpoint], savedChanges: localData.changes, journal: { version: 1 as const, changes: localData.changes, checkpoints: [checkpoint], undoable: true } }
  const guest: WorkspaceSnapshotV1 = { dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'launch-guest', capturedAt: '2026-11-13', revisionVector: { source: 'fixture' }, state: { ...fixture.state, planner, editorDocuments: [file] } }
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  let snapshot: Awaited<ReturnType<typeof captureAccountSnapshot>> | undefined
  try {
    const prepared = await prepareAccountWorkspace(database, token, guest.state)
    const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    snapshot = await captureAccountSnapshot(prepared.opened, fence, async () => {})
    if (snapshot.version !== 1) throw new Error('Expected direct account fixture')
    return [await freeze(guest), await freeze(snapshot)]
  } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); invalidateProfile(); await database.delete() }
}
let fixtures: ReturnType<typeof createFixtures> | undefined
export function launchBackupFixtures() { return fixtures ??= createFixtures() }

import { captureAccountSyncWorkspace, isManagedAccountHead } from './account-sync-capture'
import { prepareManagedAccountProjection } from './account-managed-projection'
import { migratePlanner250 } from './planner-journal'
import { prepareCopiedConflicts } from './copied-conflicts'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { activateLocalAccountCommit, AccountDatabase, type AccountFence, type CipherRef, type PreparedLocalActivation } from '../persistence/account-database'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { accountLocalId, cipherRef } from './account-cache'
import { createAccountInheritedEvidencePreparation, openAccountInheritedEvidence, type AccountInheritedEvidence, type AccountInheritedEvidencePreparation } from './account-evidence-snapshots'
import { openAccountWorkspace, prepareAccountWorkspaceWithEvidence } from './account-graph'
import { mappedChanges, stageMappedWorkspaceIntent } from './account-intents'
import { assertOwnedWorkspaceSnapshot, disposeWorkspaceSnapshot, validateWorkspaceSnapshot, type WorkspaceSnapshot, type WorkspaceSnapshotV2 } from './snapshot'

export interface AccountRestorePreview {
  readonly target: 'account'
  readonly selectedProfileId: string
  readonly categories: Readonly<Record<'planner' | 'editor' | 'save' | 'asset' | 'history', number>>
  readonly privateBytes: number
  readonly effect: 'replace-selected-profile'
}
export interface AccountRestoreStage { readonly id: string; readonly targetHead: CipherRef }
interface PreviewAuthority {
  readonly database: AccountDatabase
  readonly token: ProfileToken
  readonly snapshot: WorkspaceSnapshot
  readonly expected: AccountFence
}
interface StageAuthority extends PreviewAuthority {
  readonly normalized: WorkspaceSnapshotV2
  readonly operation: AccountInheritedEvidencePreparation
  readonly base?: AccountInheritedEvidence
  readonly prepared: PreparedLocalActivation
  readonly evidence: AccountInheritedEvidence
  readonly managed?: Awaited<ReturnType<typeof prepareManagedAccountProjection>>
}
const previews = new WeakMap<AccountRestorePreview, PreviewAuthority>()
const stages = new WeakMap<AccountRestoreStage, StageAuthority>()

async function assertSettled(database: AccountDatabase, token: ProfileToken): Promise<void> {
  assertActiveProfile(token)
  if (await database.outbox.count() || await database.syncState.get('publication')) throw new Error('Finish syncing before restoring this account')
  assertActiveProfile(token)
}

export async function previewAccountWorkspaceRestore(database: AccountDatabase, token: ProfileToken, snapshot: WorkspaceSnapshot): Promise<AccountRestorePreview> {
  await assertOwnedWorkspaceSnapshot(snapshot)
  await validateWorkspaceSnapshot(snapshot)
  if (database.accountId !== token.accountId) throw new Error('Foreign account restore target')
  await assertSettled(database, token)
  const expected = await database.profileMeta.get('active')
  if (!expected) throw new Error('The selected account workspace is unavailable')
  if (await isManagedAccountHead(database, token, expected)) {
    const captured = await captureAccountSyncWorkspace(database, token, expected)
    await captured.dispose()
  } else await openAccountWorkspace(database, token, expected.head)
  await assertOwnedWorkspaceSnapshot(snapshot)
  const state = snapshot.state
  const preview: AccountRestorePreview = Object.freeze({
    target: 'account', selectedProfileId: token.accountId,
    categories: Object.freeze({ planner: 1, editor: state.editorDocuments.length, save: state.saveDocuments.length, asset: state.assets.length, history: state.planner.history.length + (snapshot.version === 2 ? snapshot.historicalEvidence.snapshots.length : 0) + 1 }),
    privateBytes: state.blobs.reduce((sum, blob) => sum + blob.ref.byteLength, 0) + (snapshot.version === 2 ? snapshot.historicalEvidence.blobs.reduce((sum, ref) => sum + ref.byteLength, 0) : 0),
    effect: 'replace-selected-profile',
  })
  previews.set(preview, { database, token, snapshot, expected })
  return preview
}

export function releaseAccountWorkspaceRestorePreview(preview: AccountRestorePreview): void { previews.delete(preview) }

export async function stageAccountWorkspaceRestore(preview: AccountRestorePreview): Promise<AccountRestoreStage> {
  const authority = previews.get(preview)
  if (!authority) throw new Error('A validated account restore preview is required')
  const { database, token, snapshot, expected } = authority
  assertActiveProfile(token)
  await assertOwnedWorkspaceSnapshot(snapshot)
  await assertSettled(database, token)
  if (JSON.stringify(await database.profileMeta.get('active')) !== JSON.stringify(expected)) throw new Error('The selected account workspace changed after restore preview')
  // Retain the backup's current originals as inert history even when destination graph IDs differ
  // A later account export can then reproduce every exact original across devices
  const normalized = await inheritWorkspaceSnapshot(snapshot, [snapshot])
  const operation = createAccountInheritedEvidencePreparation(database, token)
  let base: AccountInheritedEvidence | undefined
  let captured: Awaited<ReturnType<typeof captureAccountSyncWorkspace>> | undefined
  let managed: Awaited<ReturnType<typeof prepareManagedAccountProjection>> | undefined
  try {
    captured = await captureAccountSyncWorkspace(database, token, expected)
    const previous = captured.workspace
    if (captured.inheritedEvidence) base = await openAccountInheritedEvidence(database, token, captured.inheritedEvidence)
    const evidence = await operation.prepare({ base, additions: [normalized] })
    // Source comparisons remain exact inherited originals until destination publication establishes
    // an accepted branch. Replacement authority changes records, never the meaning of source parents
    const workspace = await prepareAccountWorkspaceWithEvidence(database, token, { ...snapshot.state, planner: migratePlanner250(snapshot.state.planner), conflicts: [] }, evidence, previous)
    const id = accountLocalId()
    const source = snapshot.state.conflicts.length ? await prepareAccountWorkspaceWithEvidence(database, token, snapshot.state, evidence) : undefined
    const registrations = source ? await prepareCopiedConflicts(database, token, { operationId: id, source: source.opened, destination: previous, keys: [], evidence, snapshot, owner: evidence.owner, mode: 'replace' }) : undefined
    const intent = await stageMappedWorkspaceIntent(database, token, {
      version: 1, kind: 'mapped-workspace-intent', operationId: id, portableGroupId: accountLocalId(), operation: 'workspace-command', mode: 'replace',
      original: { base: expected.head, target: workspace.head }, base: previous.head, target: workspace.head, localRevision: expected.headRevision + 1,
      changes: mappedChanges(previous, workspace.opened), ...(registrations ? { copiedConflicts: registrations.root } : {}),
    }, evidence.owner)
    await assertOwnedWorkspaceSnapshot(snapshot)
    await evidence.handle.check()
    assertActiveProfile(token)
    const records = [...new Map([...workspace.records, ...(source?.records ?? []), ...(registrations?.records ?? [])].map(record => [record.revisionId, record])).values()]
    if (captured.managed) managed = await prepareManagedAccountProjection(database, token, expected, { ...workspace, records }, { id, ref: cipherRef(intent.record), records: intent.records }, true)
    const prepared: PreparedLocalActivation = managed?.prepared ?? { version: 1, id, expected, head: workspace.head, intent: cipherRef(intent.record), intentStatus: 'mapped-local', records: [...records, ...intent.records], validatedEvidence: evidence.handle, requireSettledSync: true }
    const stage: AccountRestoreStage = Object.freeze({ id, targetHead: prepared.head })
    stages.set(stage, { ...authority, normalized, operation, base, prepared, evidence: evidence.handle, ...(managed ? { managed } : {}) })
    return stage
  } catch (error) {
    await managed?.dispose()
    await operation.abandon()
    await base?.dispose()
    await disposeWorkspaceSnapshot(normalized)
    throw error
  } finally { await captured?.dispose() }
}

export async function activateAccountWorkspaceRestore(stage: AccountRestoreStage, assertMayActivate: () => void = () => {}): Promise<AccountFence> {
  const authority = stages.get(stage)
  if (!authority) throw new Error('A staged account restore is required')
  await assertOwnedWorkspaceSnapshot(authority.snapshot)
  await assertOwnedWorkspaceSnapshot(authority.normalized)
  await authority.evidence.check()
  assertActiveProfile(authority.token)
  return activateLocalAccountCommit(authority.database, authority.token, authority.prepared, assertMayActivate)
}

export async function releaseAccountWorkspaceRestoreStage(stage: AccountRestoreStage): Promise<void> {
  const authority = stages.get(stage)
  if (!authority) return
  stages.delete(stage)
  const results = await Promise.allSettled([authority.managed?.dispose(), authority.operation.abandon(), authority.base?.dispose(), disposeWorkspaceSnapshot(authority.normalized)])
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'Account restore staging cleanup failed')
}

import { registerWorkspaceCapture } from './snapshot'
import { WorkspaceBackupError } from '../interchange/workspace-backup-schema'
import { reconcilableFileOutcome, registerOwnedFileCommitter, ownedFileReceipt, assertFileCommandResult, type OwnedFileCommand, type OwnedFileReceipt } from './owned-file-command'
import type { AccountFence } from '../persistence/account-database'
import type { ConflictResolutionIntent } from './conflict-authority'
import { afterLocalCommand, undoCheckpoint, migratePlanner250 } from './planner-journal'
import { requestSync } from '../account/sync/scheduler'
import { exportAccountPlannerSnapshot } from './account-planner-export'
import { prepareWorkspaceImport, prepareWorkspaceModSetup } from './import-commands'
import Dexie from 'dexie'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import { createBlankLocalData } from '../domain/local-data'
import type { LocalData } from '../domain/types'
import { assertActiveProfile, profileSignal, registerProfileCleanup, type ProfileToken } from '../account/profile'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { changedLocalData, historyEntry, jsonEqual, localDataForSave, prepareModCatalogs, validateLocalDataForStorage } from '../persistence/local-data'
import { previewImport } from '../interchange/import'
import type { LoadedLocalData, LocalDataNotification, SourceArchiveRecord } from '../interchange/types'
import { nowTimestamp, sha256 } from '../interchange/util'
import { NATIVE_BACKUP_ARCHIVE_LIMITS } from '../interchange/zip'
import { accountLocalId, cipherRef } from './account-cache'
import { openAccountWorkspace, prepareAccountWorkspace, prepareAccountWorkspaceWithEvidence } from './account-graph'
import { validateWorkspaceClosure } from './closure'
import { openOrMapAccountWorkspace, stageMappedWorkspaceIntent, mappedChanges } from './account-intents'
import { retainPendingUnits } from './pending-content'
import { blobIdentity, readBlob } from './blobs'
import type { WorkspaceState } from './documents'
import { WorkspaceError, type WorkspaceRepository } from './repository'

// Fresh accounts need current definitions, not unused historical app catalogs in every private backup
// Existing selected workspaces retain their complete captured catalog sets without filtering
const INITIAL_ACCOUNT_CATALOGS = Object.freeze(BUNDLED_CATALOGS.filter(catalog => catalog === CURRENT_CATALOG))
const accountRepositoryDisposers = new WeakMap<WorkspaceRepository, () => void>()
async function readOwnedAccountReceipt<T>(token: ProfileToken, read: (database: AccountDatabase) => Promise<T>): Promise<T> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  try { const result = await read(database); assertActiveProfile(token); return result }
  finally { database.close() }
}
function loadedState(state: WorkspaceState): LoadedLocalData {
  const { localData, lineage, catalogs, evidence } = state.planner
  return { localData, lineage, catalogs, evidence, revision: localData.revision, canUndo: !!undoCheckpoint(state.planner) }
}
export async function openAccountRepository(token: ProfileToken): Promise<WorkspaceRepository> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  try {
    const { isManagedAccountHead } = await import('./account-sync-capture')
    const { openAccountManagedRepository } = await import('./account-managed-repository')
    let selected = await database.profileMeta.get('active')
    if (!selected) {
      // Fresh profiles prepare the managed layout before editing, without manufacturing a legacy source
      const { initializeAccountWorkspace } = await import('./account-initialization')
      const localData = createBlankLocalData()
      const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: INITIAL_ACCOUNT_CATALOGS, evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
      selected = await initializeAccountWorkspace(database, token, state)
    }
    if (!selected) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'No active encrypted workspace is available.')
    if (!await isManagedAccountHead(database, token, selected)) {
      // Existing native/domain migration retains its own intent and original evidence before local-layout migration
      // A failed preparation leaves that valid selected native graph available for explicit recovery or retry
      const legacy = await accountRepository(token, false)
      try { await legacy.load() } finally { accountRepositoryDisposers.get(legacy)?.() }
      selected = (await database.profileMeta.get('active'))!
      if (!await isManagedAccountHead(database, token, selected)) {
        const { prepareAccountManagedMigration } = await import('./account-managed-migration')
        const migration = await prepareAccountManagedMigration(database, token, selected)
        try {
          try { selected = await activateLocalAccountCommit(database, token, migration.prepared) }
          catch (error) {
            if (!(error instanceof WorkspaceError && error.code === 'LOCAL_REVISION_CONFLICT')) throw error
            const winner = await database.profileMeta.get('active')
            if (!winner || !await isManagedAccountHead(database, token, winner)) throw error
            selected = winner
          }
        } finally { await migration.dispose() }
      }
    }
    assertActiveProfile(token)
    return await openAccountManagedRepository(database, token, selected)
  } catch (error) { database.close(); throw error }
}
async function accountRepository(token: ProfileToken, initialize: boolean): Promise<WorkspaceRepository> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  try {
    const selected = await database.profileMeta.get('active')
    if (selected) {
      const { readAccountBytes } = await import('./account-cache')
      const bytes = await readAccountBytes(database, token, selected.head)
      try {
        const root: unknown = JSON.parse(new TextDecoder().decode(bytes))
        if (root && typeof root === 'object' && 'kind' in root && root.kind === 'incremental-local-workspace') {
          const { openAccountManagedRepository } = await import('./account-managed-repository')
          return openAccountManagedRepository(database, token, selected)
        }
      } finally { bytes.fill(0) }
    }
  } catch (error) { database.close(); throw error }
  let retired = false
  const assertRepositoryCurrent = () => { assertActiveProfile(token); if (retired) throw new Error('This account repository was retired by its owned successor') }
  const listeners = new Set<(event: LocalDataNotification) => void>()
  let channel: BroadcastChannel | undefined
  let observedFence = -1
  let latestRemote: LocalDataNotification | undefined
  const readFences = new WeakMap<WorkspaceState, AccountFence>()
  const applied = () => { void refreshHint() }
  if (typeof window !== 'undefined') window.addEventListener('crykit-account-sync-applied', applied)
  let unregisterCleanup = () => {}
  const dispose = () => {
    retired = true
    listeners.clear(); channel?.close(); database.close(); unregisterCleanup()
    if (typeof window !== 'undefined') window.removeEventListener('crykit-account-sync-applied', applied)
  }
  unregisterCleanup = registerProfileCleanup(token, dispose)
  try {
    if (!await database.profileMeta.get('active')) {
      if (!initialize) throw new Error('The saved account workspace is unavailable')
      const localData = createBlankLocalData()
      const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: INITIAL_ACCOUNT_CATALOGS, evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
      const prepared = await prepareAccountWorkspace(database, token, state)
      try { await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records, intentStatus: 'mapped-local' }) }
      catch (error) { if (!(error instanceof WorkspaceError && error.code === 'LOCAL_REVISION_CONFLICT')) throw error }
    }
    observedFence = (await capture()).fence.headRevision
  } catch (error) { dispose(); throw error }
  async function capture() {
    assertRepositoryCurrent()
    try {
      const fence = await database.profileMeta.get('active')
      if (!fence) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'No active encrypted workspace is available.')
      const selected = await openOrMapAccountWorkspace(database, token, fence)
      assertRepositoryCurrent()
      if (String(selected.workspace.state.planner.localData.schemaVersion) === '2.4.0') {
        await migrateDomain(selected.fence, selected.workspace)
        return capture()
      }
      return selected
    } catch (error) {
      // Closing a retired handle can reject an earlier read before its ordinary final check
      assertRepositoryCurrent()
      throw error
    }
  }
  async function migrateDomain(fence: AccountFence, before: import('./account-graph').OpenAccountWorkspace): Promise<void> {
    const { captureAccountSnapshot } = await import('./account-snapshot')
    const { inheritWorkspaceSnapshot } = await import('../interchange/workspace-backup-evidence')
    const { disposeWorkspaceSnapshot } = await import('./snapshot')
    const { createAccountInheritedEvidencePreparation, openAccountInheritedEvidence } = await import('./account-evidence-snapshots')
    const check = async () => { assertRepositoryCurrent(); if (!jsonEqual(await database.profileMeta.get('active'), fence)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The account changed during domain migration'); assertRepositoryCurrent() }
    const snapshot = await captureAccountSnapshot(before, fence, check, { database, token })
    const operation = createAccountInheritedEvidencePreparation(database, token)
    let inherited: Awaited<ReturnType<typeof openAccountInheritedEvidence>> | undefined
    let normalized: Awaited<ReturnType<typeof inheritWorkspaceSnapshot>> | undefined
    try {
      normalized = await inheritWorkspaceSnapshot(snapshot, [snapshot])
      if (before.inheritedEvidence) inherited = await openAccountInheritedEvidence(database, token, before.inheritedEvidence)
      const evidence = await operation.prepare({ base: inherited, additions: [normalized] })
      const state = { ...before.state, planner: migratePlanner250(before.state.planner) }
      const prepared = await prepareAccountWorkspaceWithEvidence(database, token, state, evidence, before)
      const operationId = accountLocalId()
      const intent = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId, portableGroupId: accountLocalId(), operation: 'workspace-command', mode: 'additive', original: { base: before.head, target: prepared.head }, base: before.head, target: prepared.head, localRevision: fence.headRevision + 1, changes: mappedChanges(before, prepared.opened) }, evidence.owner)
      await check(); await evidence.handle.check()
      // This cache/intention successor preserves C and its exact encrypted bodies; ordinary sync publishes the additive change
      await activateLocalAccountCommit(database, token, { version: 1, id: operationId, expected: fence, head: prepared.head, intent: cipherRef(intent.record), intentStatus: 'mapped-local', records: [...prepared.records, ...intent.records], validatedEvidence: evidence.handle }, assertRepositoryCurrent)
    } finally {
      await operation.abandon()
      await inherited?.dispose()
      if (normalized) await disposeWorkspaceSnapshot(normalized)
      await disposeWorkspaceSnapshot(snapshot)
    }
  }
  async function sources(state?: WorkspaceState): Promise<SourceArchiveRecord[]> {
    const selected = state ?? (await capture()).workspace.state
    const total = selected.planner.sources.reduce((sum, source) => sum + source.original.byteLength, 0)
    if (total > NATIVE_BACKUP_ARCHIVE_LIMITS.maxTotalUncompressedBytes) throw new WorkspaceError('LOCAL_MATERIALIZATION_LIMIT', 'These sources require a streamed full-workspace backup.')
    const registry = new Map(selected.blobs.map(blob => [blobIdentity(blob.ref), blob.content]))
    const result: SourceArchiveRecord[] = []
    try {
      for (const { original, ...metadata } of selected.planner.sources) {
        const content = registry.get(blobIdentity(original))
        if (!content) throw new Error('An exact source body is unavailable')
        const bytes = await readBlob(content, original.byteLength)
        result.push({ ...metadata, bytes })
        if (await sha256(bytes) !== metadata.digest) throw new Error('An exact source digest does not match')
        assertRepositoryCurrent()
      }
      assertRepositoryCurrent()
      return result
    } catch (error) { for (const source of result) source.bytes.fill(0); throw error }
  }
  async function commit(next: WorkspaceState | LocalData | undefined, expectedRevision: number, operation: 'save' | 'undo' | 'workspace-command' | 'import' | 'mod-setup', mode: 'additive' | 'replace' = 'additive', conflictResolution?: ConflictResolutionIntent, owned?: { command: OwnedFileCommand; before: WorkspaceState; onPrepared: (state: WorkspaceState, fence: AccountFence) => void }): Promise<LoadedLocalData> {
    const { fence, workspace: before } = await capture()
    if (owned) {
      owned.command.assertMayActivate()
      if (JSON.stringify(readFences.get(owned.before)) !== JSON.stringify(fence)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The captured account file base changed')
      assertFileCommandResult(owned.before, before.state)
    }
    const previous = before.state.planner.localData
    if (previous.revision !== expectedRevision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'This account changed in another tab. Reload before saving.')
    const timestamp = nowTimestamp()
    const complete = next && 'planner' in next ? next : before.state
    // Retained imports can include another planner's history, which never grants undo authority
    const last = undoCheckpoint(before.state.planner)
    if (!next && !last) throw new WorkspaceError('ACCOUNT_CAPABILITY_UNAVAILABLE', 'There is no saved change to undo.')
    const prepared = operation === 'save' ? localDataForSave(previous, next as LocalData, expectedRevision, timestamp) : { localData: changedLocalData(previous, next ? complete.planner.localData : last!.before, operation === 'undo' ? `undo:${last!.command}` : 'workspace-command', timestamp), command: operation === 'undo' ? `undo:${last!.command}` : 'workspace-command' }
    const catalogs = await prepareModCatalogs(prepared.localData, complete.planner.catalogs)
    validateLocalDataForStorage(prepared.localData, catalogs)
    const history = new Map(before.state.planner.history.map(entry => [entry.id, entry]))
    for (const entry of complete.planner.history) {
      const saved = history.get(entry.id)
      if (saved && !jsonEqual(saved, entry)) throw new Error('Historical planner identity conflicts')
      history.set(entry.id, entry)
    }
    const entry = historyEntry(previous, prepared.localData, prepared.command, timestamp)
    history.set(entry.id, entry)
    const state: WorkspaceState = { ...complete, planner: afterLocalCommand(before.state.planner, { ...complete.planner, localData: prepared.localData, catalogs, history: [...history.values()] }, entry) }
    const semantic = await prepareAccountWorkspace(database, token, state, before)
    const operationId = owned?.command.id ?? accountLocalId(), portableGroupId = accountLocalId()
    const changes = mappedChanges(before, semantic.opened)
    const retained = await retainPendingUnits(state, before, semantic.opened, portableGroupId, changes)
    const target = await prepareAccountWorkspace(database, token, retained, semantic.opened)
    const intent = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId, portableGroupId, operation, mode, original: { base: before.head, target: target.head }, base: before.head, target: target.head, localRevision: fence.headRevision + 1, changes, ...(conflictResolution ? { conflictResolution } : {}) })
    owned?.onPrepared(retained, { key: 'active', headRevision: fence.headRevision + 1, head: target.head })
    const active = await activateLocalAccountCommit(database, token, { version: 1, id: operationId, expected: fence, head: target.head, intent: cipherRef(intent.record), records: [...semantic.records, ...target.records, ...intent.records], intentStatus: 'mapped-local' }, () => { assertRepositoryCurrent(); owned?.command.assertMayActivate() })
    assertRepositoryCurrent()
    observedFence = active.headRevision
    latestRemote = undefined
    const event: LocalDataNotification = { localDataId: state.planner.localData.id, revision: state.planner.localData.revision, reason: operation === 'undo' ? 'undo' : 'save' }
    for (const listener of listeners) listener(event)
    channel?.postMessage({ headRevision: active.headRevision })
    requestSync(token, 'quiet')
    return loadedState(state)
  }
  async function refreshHint() {
    try {
      const { fence, workspace } = await capture()
      assertRepositoryCurrent()
      if (fence.headRevision <= observedFence) return
      observedFence = fence.headRevision
      // A pull may finish before App mounts its subscription; retain the authenticated hint
      // so the newer encrypted head is still offered for explicit loading
      latestRemote = { localDataId: workspace.state.planner.localData.id, revision: workspace.state.planner.localData.revision, reason: 'sync' }
      for (const listener of listeners) listener(latestRemote)
    } catch { /* Hints confer no authority; explicit reads surface failures */ }
  }
  const repository: WorkspaceRepository = {
    kind: 'account',
    readWorkspace: async () => {
      const selected = await capture()
      const state = selected.workspace.state
      const actual = await database.profileMeta.get('active')
      assertRepositoryCurrent()
      if (JSON.stringify(actual) !== JSON.stringify(selected.fence)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The workspace changed during capture. Retry the complete read.')
      readFences.set(state, selected.fence)
      return state
    },
    commitWorkspace: (state, revision, options) => commit(state, revision, 'workspace-command', 'additive', options?.conflictResolution),
    load: async () => { const captured = await capture(); assertRepositoryCurrent(); return loadedState(captured.workspace.state) },
    save: (data, revision) => commit(data, revision, 'save'), undo: revision => commit(undefined, revision, 'undo'),
    previewImport: async (bytes, filename) => { assertRepositoryCurrent(); const result = await previewImport(bytes, filename); assertRepositoryCurrent(); return result },
    commitImport: async (preview, options) => {
      const before = (await capture()).workspace.state, prepared = await prepareWorkspaceImport(before, preview, options)
      return commit(prepared.state, before.planner.localData.revision, 'import', prepared.mode)
    },
    commitModSetup: async (previews, revision, skip) => {
      const before = (await capture()).workspace.state
      return commit(await prepareWorkspaceModSetup(before, previews, revision, skip), revision, 'mod-setup')
    },
    prepareModCatalogs: async (data, catalogs) => { assertRepositoryCurrent(); const result = await prepareModCatalogs(data, catalogs); assertRepositoryCurrent(); return result },
    readSources: async () => { const result = await sources(); assertRepositoryCurrent(); return result }, readHistory: async () => { const planner = (await capture()).workspace.state.planner; assertRepositoryCurrent(); return [...new Map([...planner.history, ...(planner.journal?.checkpoints ?? [])].map(entry => [entry.id, entry])).values()] },
    readModSource: async pin => {
      const { state } = (await capture()).workspace
      const catalog = state.planner.catalogs.find(value => value.id === pin.catalogId && value.revisionId === pin.catalogRevisionId)
      if (!catalog || catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The exact saved mod revision is unavailable.')
      const source = state.planner.sources.find(value => value.digest === catalog.checksum.replace(/^sha256:/, ''))
      const body = source && state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(source.original))
      if (!source || !body) throw new Error('The exact original mod source is unavailable')
      const bytes = await readBlob(body.content, source.original.byteLength)
      try { assertRepositoryCurrent(); return { filename: source.filename, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } }
      finally { bytes.fill(0) }
    },
    exportPlannerBackup: async override => {
      const { state } = (await capture()).workspace
      const originals = await sources(state)
      try {
        const bytes = await exportAccountPlannerSnapshot(state.planner, originals, override)
        try { assertRepositoryCurrent(); return bytes } catch (error) { bytes.fill(0); throw error }
      } finally { for (const source of originals) source.bytes.fill(0) }
    },
    subscribe: listener => {
      assertRepositoryCurrent()
      if (!channel && typeof BroadcastChannel !== 'undefined') { channel = new BroadcastChannel(`crykit-account-${token.accountId}`); channel.addEventListener('message', () => { void refreshHint() }) }
      listeners.add(listener)
      if (latestRemote) listener(latestRemote)
      return () => { listeners.delete(listener) }
    },
  }
  registerOwnedFileCommitter(repository, async (before, next, command) => {
    const oldFence = readFences.get(before)
    let expected: WorkspaceState | undefined, target: AccountFence | undefined, error: unknown
    let savedReceipt: OwnedFileReceipt | undefined, verifiedSuccessor: WorkspaceRepository | undefined
    let resolving: Promise<unknown> = Promise.resolve()
    try {
      await commit(next, before.planner.localData.revision, 'workspace-command', 'additive', undefined, { command, before, onPrepared: (state, fence) => { expected = state; target = fence } })
    } catch (reason) { error = reason }
    const reconcile = async (): Promise<import('./owned-file-command').OwnedFileOutcome> => {
      try {
        assertActiveProfile(token)
        const { journal, active } = await readOwnedAccountReceipt(token, async reader => ({ journal: await reader.migrationJournal.get(command.id), active: await reader.profileMeta.get('active') }))
        assertActiveProfile(token)
        if (target && expected && journal?.localStatus === 'active' && JSON.stringify(journal.head) === JSON.stringify(target.head) && journal.headRevision === target.headRevision) {
          const result = expected, fence = target
          savedReceipt ??= ownedFileReceipt(command, () => {
            // Serialize overlapping retries, but independently reread every barrier and complete result
            const attempt = resolving.then(async () => {
              const assertCurrent = async () => {
                assertActiveProfile(token)
                const actual = await readOwnedAccountReceipt(token, reader => reader.profileMeta.get('active'))
                assertActiveProfile(token)
                if (JSON.stringify(actual) !== JSON.stringify(fence)) throw new Error('The saved account file successor is no longer selected')
              }
              command.assertMayActivate()
              await assertCurrent()
              const successor = verifiedSuccessor ?? await openAccountRepository(token)
              try {
                await assertCurrent()
                command.assertMayActivate()
                // Reusing a connection never reuses completeness or continuation authority from a prior resolution
                const state = await successor.readWorkspace()
                await assertCurrent()
                command.assertMayActivate()
                assertFileCommandResult(result, state)
                verifiedSuccessor = successor
                // Token generations can survive owned remounts; close the old instance and unregister its cleanup
                dispose()
                return { repository: successor, state, assertCurrent }
              } catch (error) {
                if (!verifiedSuccessor) accountRepositoryDisposers.get(successor)?.()
                throw error
              }
            })
            resolving = attempt.catch(() => {})
            return attempt
          }, () => readOwnedAccountReceipt(token, async reader => {
            const assertSaved = async () => {
              assertActiveProfile(token)
              const journal = await reader.migrationJournal.get(command.id), active = await reader.profileMeta.get('active')
              assertActiveProfile(token)
              if (journal?.localStatus !== 'active' || JSON.stringify(journal.head) !== JSON.stringify(fence.head) || journal.headRevision !== fence.headRevision || JSON.stringify(active) !== JSON.stringify(fence)) throw new Error('The saved account file result is no longer selected')
            }
            await assertSaved()
            const { state } = await openAccountWorkspace(reader, token, fence.head)
            await validateWorkspaceClosure(state)
            assertFileCommandResult(result, state)
            await assertSaved()
          }))
          return { status: 'saved', receipt: savedReceipt, ...(error ? { error } : {}) }
        }
        return reconcilableFileOutcome({ status: oldFence && JSON.stringify(active) === JSON.stringify(oldFence) ? 'not-saved' : 'uncertain', error: error ?? new Error('The file command needs recovery') }, reconcile)
      } catch (reason) { return reconcilableFileOutcome({ status: 'uncertain', error: reason }, reconcile) }
    }
    return reconcile()
  })
  registerWorkspaceCapture(repository, async () => {
    const selected = await capture()
    const { captureAccountSnapshot } = await import('./account-snapshot')
    return captureAccountSnapshot(selected.workspace, selected.fence, async () => {
      assertRepositoryCurrent()
      const actual = await database.profileMeta.get('active')
      assertRepositoryCurrent()
      if (!jsonEqual(actual, selected.fence)) throw new WorkspaceBackupError('SNAPSHOT_CHANGED', 'The account workspace changed during backup. Retry the export.')
    }, { database, token })
  })
  accountRepositoryDisposers.set(repository, dispose)
  return repository
}

// S01 supplies real removal prerequisites; complete workspace export remains B03-owned
export async function accountPendingWork(token: ProfileToken): Promise<boolean> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  try { const pending = await database.outbox.count(); assertActiveProfile(token); return pending > 0 }
  finally { database.close() }
}
export async function removeEncryptedAccountData(token: ProfileToken, expected?: AccountFence, assertMayRemove: () => void = () => {}): Promise<void> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  const signal = profileSignal(token)
  let transaction: import('dexie').Transaction | undefined
  const abort = () => transaction?.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    // Keep the named shell: a deleteDatabase request cannot be cancelled after a profile switch
    // Clearing ciphertext and the active fence together also rejects previously prepared writers
    await database.transaction('rw', database.tables, async () => {
      transaction = Dexie.currentTransaction ?? undefined
      assertActiveProfile(token)
      assertMayRemove()
      if (expected && !jsonEqual(await database.profileMeta.get('active'), expected)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'Saved data changed after removal review. Review this device copy again.')
      for (const table of database.tables) await table.clear()
      assertMayRemove()
      assertActiveProfile(token)
    })
    assertActiveProfile(token)
  } finally { signal.removeEventListener('abort', abort); database.close() }
}

export async function readAccountSaveRecovery(token: ProfileToken, expected: import('./documents').SaveWorkspaceDocument) {
  const fresh = await accountRepository(token, false)
  try {
    const state = await fresh.readWorkspace()
    await validateWorkspaceClosure(state)
    const file = state.saveDocuments.find(value => value.id === expected.id)
    if (JSON.stringify(file) !== JSON.stringify(expected)) throw new Error('The saved recovery file changed')
    const { readSaveContent } = await import('./save-repository')
    return await readSaveContent(state, expected)
  } finally { accountRepositoryDisposers.get(fresh)?.() }
}

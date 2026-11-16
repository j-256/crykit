import Dexie from 'dexie'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import type { AccountDatabase } from '../persistence/account-database'
import { jsonEqual } from '../persistence/local-data'
import { cipherRef, stageAccountBytes } from './account-cache'
import { createAccountPreparationOwner } from './account-prepared-records'
import { holdAccountPreparation, type AccountPreparationLease } from './account-preparation-registry'
import { createGuestCopyService, type GuestCopyPreview } from './guest-copy'
import type { GuestCoordinatorDatabase } from './guest-coordinator'
import { captureManagedGuestSnapshot } from './guest-managed-snapshot'
import { compareManagedGuestRetained } from './guest-managed-retained'
import { stableWorkspaceSnapshotIdentity } from './reviewed-replacement'
import { backupMetadataDigest } from './snapshot'
import { encodeSigninMergeManifest, SigninMergeManifestSchema, type SigninMergeLocator, type SigninMergeFence, type SigninMergeTicket, type SigninMergeProgress } from './signin-merge-protocol'
import { clearMergeCiphertext, collectMergeClosure, observeMergeCiphertext, uniqueMergeRecords } from './signin-merge-observations'

// This worker-owned object is never transferred; only its opaque review handle and encrypted ticket leave
export async function createSigninMergePreparation(database: AccountDatabase, token: ProfileToken, operationId: string, locator: SigninMergeLocator, fence: SigninMergeFence, progress: (value: SigninMergeProgress) => void) {
  const source = new Dexie(locator.databaseName, { autoOpen: false, allowEmptyDB: false })
  let closed = false, disposed = false, lease: AccountPreparationLease | undefined
  let stage: Awaited<ReturnType<ReturnType<typeof createGuestCopyService>['stageReadonlySigninMerge']>> | undefined
  let manifestOwner: ReturnType<typeof createAccountPreparationOwner> | undefined
  let preview: GuestCopyPreview | undefined
  let sourceIdentity: Awaited<ReturnType<typeof stableWorkspaceSnapshotIdentity>> | undefined
  const handle = crypto.randomUUID()
  const check = () => { assertActiveProfile(token); if (closed || !source.isOpen()) throw new Error('SIGNIN_SOURCE_CHANGED') }
  source.on('versionchange', () => { closed = true; source.close({ disableAutoOpen: true }); return false })
  const checkSource = async () => {
    check()
    if (!jsonEqual((await source.table('active').get('active'))?.manifest, locator.manifest)) throw new Error('SIGNIN_SOURCE_CHANGED')
    if (!jsonEqual(await database.profileMeta.get('active'), fence.selected) || !jsonEqual(await database.syncState.get('projection'), fence.projection)) throw new Error('LOCAL_REVISION_CONFLICT')
    check()
  }
  const service = createGuestCopyService(async () => {
    await checkSource()
    progress({ stage: 'reading-source' })
    if ((await compareManagedGuestRetained(locator.databaseName, locator.manifest, profileSignal(token))).length) throw new Error('SIGNIN_SOURCE_CHANGED')
    const snapshot = await captureManagedGuestSnapshot(source as GuestCoordinatorDatabase, locator.manifest, check)
    sourceIdentity = await stableWorkspaceSnapshotIdentity(snapshot)
    await checkSource(); return { snapshot }
  }, check)
  const dispose = async () => {
    if (disposed) return
    disposed = true; closed = true
    try { await stage?.dispose(); await manifestOwner?.abandon(); await service.dispose() }
    finally { source.close({ disableAutoOpen: true }); await lease?.release() }
  }
  try {
    await source.open()
    const names = ['active', 'captures', 'journal', 'managedChunks', 'managedMigrations', 'managedOperations', 'managedRecords', 'records']
    if (source.verno !== 3 || !jsonEqual(source.tables.map(table => table.name).sort(), names)) throw new Error('SIGNIN_SOURCE_CHANGED')
    // Dynamic opening discovers an existing schema without declaring upgrade or initialization authority
    Object.assign(source, { active: source.table('active'), captures: source.table('captures'), records: source.table('records') })
    await checkSource()
    progress({ stage: 'comparing-records' })
    preview = await service.previewReadonlySigninMerge(database, token)
    await checkSource()
    return { handle, preview, async prepare(reviewHandle: string): Promise<SigninMergeTicket> {
      if (reviewHandle !== handle || stage) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      await checkSource()
      lease = await holdAccountPreparation(token, operationId, profileSignal(token))
      progress({ stage: 'preparing-merge' })
      stage = await service.stageReadonlySigninMerge(database, token, preview!, lease)
      await stage.check(); await checkSource()
      const output = uniqueMergeRecords(stage.records), outputIds = new Set(output.map(record => record.revisionId))
      const rowMap = new Map<string, typeof stage.sourceRows[number]>()
      for (const row of stage.sourceRows) { if (rowMap.has(row.id) && !jsonEqual(rowMap.get(row.id), row)) throw new Error('SIGNIN_RECEIPT_MISMATCH'); rowMap.set(row.id, row) }
      const sourceRows = [...rowMap.values()]
      const roots = [...stage.sourceRoots, fence.projection.ref, ...sourceRows.flatMap(row => row.expected ? [row.expected.ref] : [])]
      const closure = await collectMergeClosure(database, token, [...roots, ...output.map(cipherRef)], [...output, ...stage.consumed], check)
      const consumed = closure.filter(record => !outputIds.has(record.revisionId))
      const observations = await observeMergeCiphertext(database, token, closure, check).catch(error => { progress({ stage: 'preparing-merge', observations: { status: 'failed' } }); throw error })
      progress({ stage: 'preparing-merge', observations: { status: 'complete', records: observations.length, bytes: observations.reduce((sum, value) => sum + value.chunks.reduce((total, chunk) => total + chunk.bytes.length, 0), 0) } })
      // This additional physical pass binds descriptors to actual complete ciphertext, not resolved metadata
      // Main repeats the pass and retains its own bytes; worker arrays are cleared immediately
      clearMergeCiphertext(observations)
      await stage.check(); await checkSource()
      const manifest = SigninMergeManifestSchema.parse({ version: 1, kind: 'signin-merge-manifest', accountId: token.accountId, operationId, copyId: preview!.copyId,
        source: locator, sourceIdentity, destination: fence, previewDigest: await backupMetadataDigest(preview), journal: stage.ref, journalTarget: stage.journal.target,
        selectedTarget: stage.target, intent: stage.journal.intent, intentStatus: stage.intentStatus, mappingOrigin: stage.mappingOrigin,
        output, consumed, sourceRoots: stage.sourceRoots, sourceRows })
      const bytes = encodeSigninMergeManifest(manifest)
      manifestOwner = createAccountPreparationOwner(database, token, lease)
      // The transient encrypted manifest is outside persistent closure and has no persistent dependencies
      let record
      try { record = await stageAccountBytes(database, token, bytes, [], undefined, manifestOwner) } finally { bytes.fill(0) }
      await stage.check(); await checkSource(); lease.check()
      return { version: 1, operationId, copyId: preview!.copyId, manifest: record }
    }, check: checkSource, dispose }
  } catch (error) { await dispose(); throw error }
}

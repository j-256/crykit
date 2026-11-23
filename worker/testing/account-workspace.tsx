import { readLiveSigninSyncDiagnostics, enableSigninMergeDiagnostics, readSigninMergeDiagnostics, recordSigninMergeBoundary, stopSigninMergeDiagnostics } from '../../src/workspace/signin-merge-diagnostics'
import { signInProfile } from '../../src/account/lifecycle'
import { writeDeviceSelection } from '../../src/workspace/device-selection'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../../src/account/profile'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/App'
import { decodeCrystalSave, encodeCrystalSave } from '../../src/interchange/crystal-save'
import { editSave } from '../../src/domain/save-editor'
import { SAVE_EDITOR_CATALOG } from '../../src/catalog/save-editor'
import { WorkspaceProvider, useWorkspace } from '../../src/ui/WorkspaceProvider'
import { currentProfileToken, profileAccess, withAccountKey } from '../../src/account/profile'
import { listCachedProfiles, readDeviceProfile } from '../../src/account/device-store'
import { previewImport } from '../../src/interchange/import'
import { createPersonalDefinition, createCharacter, createScenario } from '../../src/domain'
import { createPlaythroughWithSetup } from '../../src/domain/game-setups'
import { AccountDatabase } from '../../src/persistence/account-database'
import { seedManagedWorkspace } from '../../src/persistence/managed-sync.test-helpers'
import { memoryBlob } from '../../src/workspace/blobs'
import { disposeWorkspaceSnapshot } from '../../src/workspace/snapshot'
import { sha256 } from '../../src/interchange/util'
import { accountLocalId } from '../../src/workspace/account-cache'
import { createBlankLocalData } from '../../src/domain/local-data'
import { captureEmailCapability } from '../../src/account/email-capability'
import '../../src/styles.css'

// Match the real entry's email-link intake before App navigation can retain the capability
captureEmailCapability()
window.addEventListener('hashchange', () => { if (captureEmailCapability()) window.dispatchEvent(new Event('account-email-link')) })

// Local-only observability drives the actual App/provider and recovery boundary, never production assets
type PublicSharingFixture = { readonly effect: string; readonly filename: string; readonly artwork: string; readonly source: string; readonly allocation: string; readonly note: string }
async function teamFixtureData(publicSharing?: PublicSharingFixture) {
  const { addTestBuild, addTestDefinition, addTestTeam, createTestLocalData, HAND_SLOT, personalRef, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } = await import('../../src/domain/test-helpers')
  const { addGameSetupRevision } = await import('../../src/domain/local-data')
  let data = addTestDefinition(addTestDefinition(createTestLocalData(), 'Synthetic class', { kind: 'class' }), 'Synthetic sword')
  data = addTestBuild(data, 'Synthetic source', '', { [HAND_SLOT]: { ref: personalRef('Synthetic sword') } }, { primaryClass: personalRef('Synthetic class') })
  data = addTestTeam(data).localData
  data = addGameSetupRevision(data, { ...data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!, id: 'other-team-setup' as never, label: 'Other shared rules', ppLimit: { state: 'known', value: 9 }, activate: false })
  const { saveBuildRevision } = await import('../../src/domain/builds')
  data = saveBuildRevision(data, { buildId: 'Synthetic source' as never, id: 'other-source-revision' as never, gameSetupRevisionId: 'other-team-setup' as never, content: data.buildRevisions['Synthetic source-revision']!.content })
  data = { ...data, teams: { mixed: { id: 'mixed' as never, kind: 'legacy-mixed', title: 'Legacy mixed Team', slots: ['Synthetic source-revision' as never, null, 'other-source-revision' as never, null], revision: 4, createdAt: TEST_NOW, updatedAt: TEST_NOW }, legacy: { id: 'legacy' as never, kind: 'legacy-mixed', title: 'Legacy empty Team', slots: [null, null, null, null], revision: 0, createdAt: TEST_NOW, updatedAt: TEST_NOW } }, modSetup: { version: 1, state: 'skipped' } }
  if (publicSharing) {
    const { saveSharedTeam } = await import('../../src/domain/team-checkpoints')
    const definition = data.personalDefinitions['Synthetic sword']!
    const revision = data.buildRevisions['Synthetic source-revision']!
    data = { ...data, personalDefinitions: { ...data.personalDefinitions, [definition.id]: { ...definition, rawDescription: publicSharing.effect, fields: { secret: { state: 'known', value: { filename: publicSharing.filename, artworkId: publicSharing.artwork, sourceArchive: publicSharing.source } } } } }, buildRevisions: { ...data.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, equipment: { hand: { ref: personalRef(definition.id), allocationId: publicSharing.allocation }, 'second-hand': { ref: personalRef(definition.id), allocationId: publicSharing.allocation } }, rotationNotes: publicSharing.note, contextAssumptions: [] } } } }
    data = saveSharedTeam(data, { id: 'public-team' as never, title: 'Portable Team', gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, slots: [revision.id, null, revision.id, null] })
  }
  return data
}

async function signinProgressFixture(label: string, marker: string) {
  const { progress } = await import('../../src/workspace/signin-merge.test-helpers')
  const state = progress(marker), localData = state.planner.localData
  return { ...state, planner: { ...state.planner, localData: { ...localData, playthroughs: { ...localData.playthroughs, play: { ...localData.playthroughs.play, label } } } } }
}

// Bootstrap proofs touch only synthetic account storage before the planner is mounted
// Public startup accepts only managed launch roots, so fixture admission must finish before mounting
const accountBootstrapProof = {
  // Fixture-only composition preserves the real auth choice while seeding before provider admission
  signIn: signInProfile,
  readLiveSigninSyncDiagnostics,
  enableSigninMergeDiagnostics,
  signinMergeDiagnostics: readSigninMergeDiagnostics,
  recordSigninMergeBoundary,
  stopSigninMergeDiagnostics,
  async qualificationScan() { return (await import('./signin-merge-qualification')).qualificationScan() },
  async seedCurrentOnlyResourceDestination() {
    if (mounted) throw new Error('Resource qualification requires an unmounted fixture')
    return (await import('./signin-resource-qualification')).seedCurrentOnlyResourceDestination()
  },
  async currentOnlyResourceEvidence() { return (await import('./signin-resource-qualification')).currentOnlyResourceEvidence() },
  async resourceProjectionAuthority() { return (await import('./signin-resource-qualification')).resourceProjectionAuthority() },
  async seedSelectedNativeAccount() {
    if (mounted) throw new Error('Native startup qualification requires an unmounted fixture')
    return (await import('./signin-merge-qualification')).seedSelectedNativeAccount()
  },
  async seedCompactCatalogDestination() {
    const { CURRENT_CATALOG } = await import('../../src/catalog/bundled')
    const { editorClosureFixture } = await import('../../src/workspace/test-helpers')
    const fixture = await editorClosureFixture(), token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try { await seedManagedWorkspace(database, token, { ...fixture.state, planner: { ...fixture.state.planner, catalogs: [CURRENT_CATALOG] } }) } finally { database.close() }
  },
  async initializeCatalogDevice() {
    const { openAccountRepository } = await import('../../src/workspace/account-repository')
    await openAccountRepository(currentProfileToken()!)
  },
  async catalogPublicationState() {
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    const { openAccountJson } = await import('../../src/workspace/account-cache')
    const { z } = await import('zod')
    try {
      const rows = await database.syncState.toArray()
      const decode = async (row: { id: string; ref: { documentId: string; revisionId: string } }) => ({ ...row, value: await openAccountJson(database, token, row.ref, z.unknown()) })
      return { fence: await database.profileMeta.get('active'), rows: await Promise.all(rows.filter(row => ['projection', 'remote', 'publication'].includes(row.id) || row.id.startsWith('incremental-') || row.id.startsWith('accepted:')).map(decode)), outbox: await Promise.all((await database.outbox.toArray()).map(decode)) }
    } finally { database.close() }
  },
  async syncCatalogOnce() {
    const { runSyncIteration, registerSyncProjectionGuard } = await import('../../src/account/sync/outbox')
    const token = currentProfileToken()!
    // This isolated fixture has no draft owners; use the same explicit adoption gate as the provider
    const draftFree = () => !mounted && new URLSearchParams(location.search).has('fixture-setup') && currentProfileToken() === token
    if (!draftFree()) throw new Error('Catalog sync proof requires the unmounted owning synthetic profile')
    const release = registerSyncProjectionGuard(token, draftFree)
    try { return await runSyncIteration(token, profileSignal(token)) } catch (error) {
      const { CommitProgress } = await import('../../src/account/sync/commit-progress')
      if (error instanceof CommitProgress) return { state: 'syncing', moreWork: true }
      throw error
    } finally { release() }
  },
  async migrateCatalogFixture() {
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    const { prepareAccountCatalogMigration } = await import('../../src/workspace/catalog-migration')
    const { activateLocalAccountCommit } = await import('../../src/persistence/account-database')
    try {
      const expected = (await database.profileMeta.get('active'))!
      const migration = await prepareAccountCatalogMigration(database, token, expected)
      try { return await activateLocalAccountCommit(database, token, migration.prepared) } finally { await migration.dispose() }
    } finally { database.close() }
  },
  async compactCatalogEvidence() {
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    const { captureManagedAccountSnapshot } = await import('../../src/workspace/account-managed-snapshot')
    const { capturedBackupEvidence } = await import('../../src/interchange/workspace-backup-evidence')
    const { hashBlob } = await import('../../src/workspace/blobs')
    try {
      const snapshot = await captureManagedAccountSnapshot(database, token, (await database.profileMeta.get('active'))!)
      try {
        const evidence = capturedBackupEvidence(snapshot)
        return { version: snapshot.version, currentCatalogs: snapshot.state.planner.catalogs.map(value => ({ id: value.id, revisionId: value.revisionId, checksum: value.checksum })), members: snapshot.version !== 1 ? snapshot.historicalEvidence?.snapshots : [], metadata: await Promise.all([...evidence.historical].map(async ([id, content]) => ({ id, digest: await hashBlob(content) }))), native: await Promise.all(evidence.blobs.map(async body => ({ ref: body.ref, digest: await hashBlob(body.content) }))), catalogs: await Promise.all((evidence.catalogBodies ?? []).map(async body => ({ ref: body.ref, digest: await hashBlob(body.content) }))) }
      } finally { await disposeWorkspaceSnapshot(snapshot) }
    } finally { database.close() }
  },
  async compactCatalogArchive() {
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    const { captureManagedAccountSnapshot } = await import('../../src/workspace/account-managed-snapshot')
    const { exportWorkspaceBackup } = await import('../../src/interchange/workspace-backup')
    try {
      const snapshot = await captureManagedAccountSnapshot(database, token, (await database.profileMeta.get('active'))!)
      try { const chunks: Uint8Array[] = []; for await (const bytes of exportWorkspaceBackup(snapshot)) chunks.push(bytes); const result = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.length, 0)); let offset = 0; for (const bytes of chunks) { result.set(bytes, offset); offset += bytes.length } return Array.from(result) }
      finally { await disposeWorkspaceSnapshot(snapshot) }
    } finally { database.close() }
  },
  async comparisonSyncDiagnostic() {
    const token = currentProfileToken()!
    try { return { outcome: await (await import('../../src/account/sync/outbox')).runSyncIteration(token, profileSignal(token)) } }
    catch (error) {
      // Only a one-way error fingerprint leaves this synthetic fixture, never arbitrary error text
      const message = error instanceof Error ? error.message : 'Unknown failure'
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)))
      return { failureFingerprint: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') }
    }
  },
  async signinPreparationState(input: unknown) {
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    const { SigninMergeTicketSchema, SigninMergeManifestSchema, SIGNIN_MERGE_LIMITS } = await import('../../src/workspace/signin-merge-protocol')
    const { readAccountRecordBytes, cipherRef } = await import('../../src/workspace/account-cache')
    const { validateMergeInstallation } = await import('../../src/workspace/signin-merge-installation')
    try {
      const ticket = SigninMergeTicketSchema.parse(input)
      const bytes = await readAccountRecordBytes(database, token, cipherRef(ticket.manifest), ticket.manifest, SIGNIN_MERGE_LIMITS.manifestBytes)
      let manifest
      try { manifest = SigninMergeManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) } finally { bytes.fill(0) }
      if (manifest.accountId !== token.accountId || manifest.operationId !== ticket.operationId || manifest.copyId !== ticket.copyId) throw new Error('Synthetic ticket identity changed')
      // Read-only structural validation cannot issue the installer's private receipt
      await validateMergeInstallation(database, token, manifest)
      const expected = [...manifest.output.map(record => record.payloadId), ticket.manifest.payloadId].sort()
      const reserved = (await database.preparationPayloads.where('operationId').equals(ticket.operationId).toArray()).map(row => row.payloadId).sort()
      const installedOutput = await database.encryptedRevisions.bulkGet(manifest.output.map(record => record.revisionId))
      return { exactReservationSet: JSON.stringify(expected) === JSON.stringify(reserved), outputCount: manifest.output.length, installedOutputs: installedOutput.filter(Boolean).length, savedJournal: await database.syncState.get(`guest-copy:${ticket.copyId}`) }
    } finally { database.close() }
  },
  async signinMergeAcceptance() {
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      const { openAccountJson } = await import('../../src/workspace/account-cache')
      const { RemoteStateSchema } = await import('../../src/account/sync/pull')
      const { SyncClient } = await import('../../src/account/sync/client')
      const row = await database.syncState.get('remote')
      const remote = row ? await openAccountJson(database, token, row.ref, RemoteStateSchema) : undefined
      if (!remote) return { accepted: false }
      const service = await new SyncClient(token, profileSignal(token)).changes(remote.cursor)
      assertActiveProfile(token)
      const pending = await database.outbox.count()
      return { accepted: pending === 0 && remote.initialComplete && !remote.projectionPending && !service.hasMore && service.watermark === remote.watermark && service.publicationEpoch === remote.publicationEpoch,
        pending, localWatermark: remote.watermark, serviceWatermark: service.watermark, localEpoch: remote.publicationEpoch, serviceEpoch: service.publicationEpoch, hasMore: service.hasMore }
    } finally { database.close() }
  },
  async seedManagedComparisonDestination() {
    const { progress } = await import('../../src/workspace/signin-merge.test-helpers')
    const { editorClosureFixture } = await import('../../src/workspace/test-helpers')
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId), fixture = await editorClosureFixture()
    try {
      if (await database.profileMeta.get('active')) throw new Error('Comparison qualification requires fresh synthetic storage')
      await seedManagedWorkspace(database, token, { ...progress('account', true), editorDocuments: [fixture.file], blobs: fixture.blobs })
    } finally { database.close() }
  },
  async stageManagedComparisonFixture() {
    const { managedComparisonWritesEnabled } = await import('../../src/workspace/managed-copy-comparisons')
    if (!managedComparisonWritesEnabled()) throw new Error('Synthetic comparison capability is disabled')
    const { progress, now } = await import('../../src/workspace/signin-merge.test-helpers')
    const { editorClosureFixture } = await import('../../src/workspace/test-helpers')
    const { ownWorkspaceSnapshot } = await import('../../src/workspace/snapshot')
    const { createGuestCopyService } = await import('../../src/workspace/guest-copy')
    const { openAccountJson } = await import('../../src/workspace/account-cache')
    const { IncrementalWorkspaceIntentSchema } = await import('../../src/workspace/account-mapping-origin')
    const fixture = await editorClosureFixture(), text = await fixture.add(new Uint8Array([66, 0]), 'incoming-text', 'utf16le')
    const state = { ...progress('local', false), editorDocuments: [{ ...fixture.file, filename: 'incoming.json', unfinished: { ...fixture.file.unfinished, text } }], blobs: fixture.blobs }
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    const snapshot = ownWorkspaceSnapshot({ dataGeneration: state.planner.localData.dataGeneration, version: 1, snapshotId: 'managed-comparison-qualification-original', capturedAt: now, revisionVector: {}, state }, { async check() { assertActiveProfile(token) }, async dispose() {} })
    const service = createGuestCopyService(async () => snapshot)
    try {
      const preview = await service.previewSigninMerge(token)
      // Refuse incomplete synthetic setup before creating a durable copy without the intended comparisons
      const conflicts = preview.conflicts, progressMappings = preview.signin?.progressMappings ?? []
      if (!['["progress","play","account"]', '["editor","editor-1"]'].every(key => conflicts.includes(key))
        || !progressMappings.some(mapping => mapping.sourceKey === '["progress","play","local"]' && mapping.destinationKey === '["progress","play","account"]' && !mapping.equivalent)) throw new Error('Synthetic comparison fixture is missing its destination disagreements')
      const receipt = await service.commitGuestCopy(token, preview)
      const row = (await database.outbox.get(receipt.copyId))!
      return { copyId: receipt.copyId, version: (await openAccountJson(database, token, row.ref, IncrementalWorkspaceIntentSchema)).version, status: row.status, conflicts, progressMappings }
    } finally { await service.dispose(); await disposeWorkspaceSnapshot(snapshot); database.close() }
  },
  async comparisonStorageDigests() {
    const database = new AccountDatabase(currentProfileToken()!.accountId)
    try {
      return Object.fromEntries(await Promise.all(database.tables.map(async table => [table.name, await sha256(new TextEncoder().encode(JSON.stringify(await table.toArray(), (_key, value) => value instanceof Uint8Array ? Array.from(value) : value)))])))
    } finally { database.close() }
  },
  async qualifyOldIntentSchema(path: string, exportName: string, copyId: string) {
    if (!/^\/__accounts-proof\/assets\/account-graph-[a-zA-Z0-9_-]+\.js$/.test(path)) throw new Error('Expected an immutable local graph asset')
    const old = await import(/* @vite-ignore */ path)
    const schema = old[exportName] as { safeParse(value: unknown): { success: boolean; error?: { issues: { code: string; path: (string | number)[] }[] } } }
    if (typeof schema?.safeParse !== 'function') throw new Error('Expected the original intent schema export')
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      const { openAccountJson } = await import('../../src/workspace/account-cache')
      const { IncrementalWorkspaceIntentSchema } = await import('../../src/workspace/account-mapping-origin')
      const row = (await database.outbox.get(copyId))!
      const intent = await openAccountJson(database, token, row.ref, IncrementalWorkspaceIntentSchema)
      if (intent.version !== 2) throw new Error('Expected the candidate comparison intent')
      const { copiedComparisons: _copiedComparisons, ...previous } = intent
      const oldResult = schema.safeParse(intent), control = schema.safeParse({ ...previous, version: 1 })
      return { copyId, candidateAccepted: true, oldAccepted: oldResult.success, oldV1ControlAccepted: control.success, issues: oldResult.error?.issues.map(issue => ({ code: issue.code, path: issue.path })) }
    } finally { database.close() }
  },
  async qualifyOldComparisonWorker(path: string, copyId: string) {
    if (!/^\/__accounts-proof\/assets\/account-local-mapping-worker-[a-zA-Z0-9_-]+\.js$/.test(path)) throw new Error('Expected an immutable local mapping worker asset')
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId), incarnation = crypto.randomUUID(), id = crypto.randomUUID()
    const worker = new Worker(path, { type: 'module' })
    try {
      const row = await database.outbox.get(copyId)
      if (!row) throw new Error('Missing synthetic comparison intent')
      const result = new Promise<string>((resolve, reject) => {
        worker.onmessage = event => { if (event.data.incarnation === incarnation && event.data.id === id) resolve(event.data.status) }
        worker.onerror = () => reject(new Error('Immutable worker did not start'))
      })
      await withAccountKey(token, async key => { const bytes = key.slice(); worker.postMessage({ kind: 'initialize', incarnation, accountId: token.accountId, key: bytes }, [bytes.buffer]) })
      worker.postMessage({ kind: 'map', incarnation, id, row })
      return await result
    } finally { worker.postMessage({ kind: 'cancel', incarnation }); worker.terminate(); database.close() }
  },
  async managedComparisonOriginals() {
    const { openAccountRepository } = await import('../../src/workspace/account-repository')
    const { captureWorkspaceSnapshot, openHistoricalSnapshot } = await import('../../src/workspace/snapshot')
    const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../../src/interchange/workspace-backup')
    const { inspectWorkspaceClosure } = await import('../../src/workspace/closure')
    const { blobIdentity, readBlob } = await import('../../src/workspace/blobs')
    const repository = await openAccountRepository(currentProfileToken()!), captured = await captureWorkspaceSnapshot(repository)
    const backup = await readWorkspaceBackup(exportWorkspaceBackup(captured))
    try {
      const originals = []
      if (backup.version !== 1 && backup.historicalEvidence) for (const member of backup.historicalEvidence.snapshots) {
        const original = await openHistoricalSnapshot(backup, member.id)
        try {
          if (original.snapshotId !== 'managed-comparison-qualification-original') continue
          originals.push({ id: member.id, state: { ...original.state, blobs: await Promise.all(original.state.blobs.map(async body => ({ ref: body.ref, digest: await sha256(await readBlob(body.content, body.ref.byteLength)) }))) } })
        } finally { await disposeWorkspaceSnapshot(original) }
      }
      const branches = await Promise.all(backup.state.conflicts.filter(conflict => conflict.disposition.kind === 'unresolved').map(async conflict => ({ key: conflict.unit.privateKey, branches: await Promise.all(conflict.branches.map(async branch => {
        const inspected = await inspectWorkspaceClosure(backup.state, branch.closure)
        const value = inspected.value as unknown as { unfinished?: { text: import('../../src/workspace/documents').WorkspaceBlobRef } }
        const body = value?.unfinished && backup.state.blobs.find(body => blobIdentity(body.ref) === blobIdentity(value.unfinished!.text))
        return { value, ...(body ? { bytes: Array.from(await readBlob(body.content, body.ref.byteLength)) } : {}) }
      })) })))
      return { originals, branches }
    } finally { await disposeWorkspaceSnapshot(backup); await disposeWorkspaceSnapshot(captured) }
  },
  async seedEmptyGuestControl() {
    if (mounted) throw new Error('Empty control requires an unmounted fresh guest')
    const { GuestCoordinatorDatabase } = await import('../../src/workspace/guest-coordinator')
    const { createGuestLocalStore } = await import('../../src/workspace/guest-local-store')
    const { prepareLocalWorkspace } = await import('../../src/workspace/local-root')
    const database = new GuestCoordinatorDatabase()
    try {
      if (await database.active.get('active')) throw new Error('Empty control cannot replace an existing guest')
      const store = createGuestLocalStore(database, () => {}), operationId = crypto.randomUUID()
      const state = await signinProgressFixture('Synthetic empty-catalog control', 'from-device')
      const prepared = await prepareLocalWorkspace(store.adapter, operationId, state, { check() {}, async assertCurrent() {} })
      await store.flush(operationId)
      await store.activate(operationId, prepared.head, undefined, () => {})
    } finally { database.close() }
    window.history.replaceState(null, '', `${window.location.pathname}#/settings/account`)
    mountWorkspaceProof()
  },
  async mount() {
    const token = currentProfileToken()!
    await writeDeviceSelection({ key: 'selected', version: 1, kind: 'guest' }, () => assertActiveProfile(token))
    fixtureAdmission = token
    // Normal hash navigation must not drop a fixture query and accidentally reload an unremembered profile
    window.history.replaceState(null, '', `${window.location.pathname}#/builds`)
    mountWorkspaceProof()
  },
  async accountStorage() {
    const token = currentProfileToken()!
    const database = new AccountDatabase(token.accountId)
    try {
      const { openAccountJson } = await import('../../src/workspace/account-cache')
      const { AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema } = await import('../../src/workspace/account-graph')
      const { LocalWorkspaceRootV3Schema } = await import('../../src/workspace/local-root')
      const { assertActiveProfile } = await import('../../src/account/profile')
      const before = await database.profileMeta.get('active')
      if (!before) throw new Error('Missing selected account root')
      const root = await openAccountJson(database, token, before.head, LocalWorkspaceRootV3Schema.or(AccountWorkspaceRootV1Schema).or(AccountWorkspaceRootV2Schema))
      const pending = await database.outbox.toArray()
      if (JSON.stringify(await database.profileMeta.get('active')) !== JSON.stringify(before)) throw new Error('Account changed during storage observation')
      assertActiveProfile(token)
      return { rootVersion: root.version, fence: before, pending }
    } finally { database.close() }
  },
  async seedSaveConflictFixture() {
    const { editorClosureFixture } = await import('../../src/workspace/test-helpers')
    const { openAccountRepository } = await import('../../src/workspace/account-repository')
    const { createSaveRepository } = await import('../../src/workspace/save-repository')
    const { createSaveEditorFixture } = await import('../../src/domain/save-editor.fixture')
    const fixture = await editorClosureFixture(), token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Save conflict fixture requires fresh account storage')
      await seedManagedWorkspace(database, token, { ...fixture.state, retainedContent: [], blobs: [] })
      await createSaveRepository(await openAccountRepository(token)).importFile('binary-conflict.sav', encodeCrystalSave(createSaveEditorFixture()))
    } finally { database.close() }
  },
  async seedConflictFixture() {
    const { editorClosureFixture } = await import('../../src/workspace/test-helpers')
    const fixture = await editorClosureFixture()
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Conflict fixture requires fresh account storage')
      await seedManagedWorkspace(database, token, { ...fixture.state, editorDocuments: [fixture.file], retainedContent: [], blobs: fixture.blobs.filter(blob => blob.ref.encoding === 'utf16le') })
    } finally { database.close() }
  },
  async seedSigninProgress(label: string) {
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Sign-in fixture requires fresh account storage')
      await seedManagedWorkspace(database, token, await signinProgressFixture(label, 'from-account'))
    } finally { database.close() }
  },
  async seedRecoveryProgress(label: string) {
    const { createAccountRecoveryService } = await import('../../src/workspace/account-recovery')
    const { ownWorkspaceSnapshot, disposeWorkspaceSnapshot } = await import('../../src/workspace/snapshot')
    const { accountLocalId } = await import('../../src/workspace/account-cache')
    const { LAUNCH_DATA_GENERATION } = await import('../../src/domain/data-generation')
    const token = currentProfileToken()!, pointId = accountLocalId()
    const snapshot = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'synthetic-recovery', capturedAt: '2026-11-14T00:00:00.000Z', revisionVector: { guest: pointId, managedRevision: '1' }, state: await signinProgressFixture(label, 'recovered') }, { async check() { assertActiveProfile(token) }, async dispose() {} })
    try { await createAccountRecoveryService(token).prepare(pointId, snapshot); return pointId }
    finally { await disposeWorkspaceSnapshot(snapshot) }
  },
  async recoveryDecision(pointId: string) {
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      const { openAccountJson } = await import('../../src/workspace/account-cache')
      const { SigninDecisionSchema } = await import('../../src/workspace/signin-reconciliation')
      const { GuestCopyJournalSchema } = await import('../../src/workspace/guest-copy-journal')
      const row = await database.syncState.get(`signin-receipt:recovery:${pointId}`)
      const decision = row && await openAccountJson(database, token, row.ref, SigninDecisionSchema)
      const saved = decision?.copyId && await database.syncState.get(`guest-copy:${decision.copyId}`)
      const journal = saved ? await openAccountJson(database, token, saved.ref, GuestCopyJournalSchema) : undefined
      return { decision, journalVersion: journal?.version, projection: await database.syncState.get('projection'), active: await database.profileMeta.get('active'), pending: await database.outbox.toArray(), activation: decision?.copyId ? await database.migrationJournal.get(decision.copyId) : undefined, copies: (await database.syncState.where('id').startsWith('guest-copy:').toArray()).filter(value => value.id !== 'guest-copy:pending').map(value => value.id) }
    } finally { database.close() }
  },
  async seedSelectionFixture() {
    let data = createBlankLocalData()
    for (const label of ['First local journey', 'Second local journey']) {
      data = createPlaythroughWithSetup(data, { label, catalogLock: {} })
      const playthroughId = data.selectedPlaythroughId!
      for (let index = 0; index < 4; index++) data = createCharacter(data, { playthroughId, name: `${label} member ${index}` })
      const memberIds = Object.keys(data.playthroughs[playthroughId].characters) as import('../../src/domain/types').CharacterId[]
      for (const label of ['First local scenario', 'Second local scenario']) data = createScenario(data, { playthroughId, label, memberIds, gameSetupRevisionId: data.playthroughs[playthroughId].currentGameSetupRevisionId! })
    }
    // Synthetic baseline construction precedes the first account open; it creates no fictional authored command history
    const localData = { ...data, revision: 0, changes: [], updatedAt: data.createdAt, modSetup: { version: 1 as const, state: 'skipped' as const } }
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Selection fixture requires fresh account storage')
      await seedManagedWorkspace(database, token, { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } })
      return localData
    } finally { database.close() }
  },
  async seedTeamFixture(account = true, publicSharing?: PublicSharingFixture) {
    if (!account) throw new Error('Guest fixture requires the mounted workspace proof')
    const data = await teamFixtureData(publicSharing)
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Team fixture requires fresh account storage')
      const localData = { ...data, revision: 0, changes: [] }
      await seedManagedWorkspace(database, token, { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } })
    } finally { database.close() }
  },
}
Object.assign(window, { accountBootstrapProof })

let stopSaveRecoveryInjection: (() => void) | undefined
let releaseQueued: (() => void) | undefined
let queuedResult: Promise<string> | undefined
let capturedEditorAuthority: (() => { sameProfile: boolean; repositoryCurrent: boolean; viewRetired: boolean }) | undefined
function WorkspaceProof() {
  const workspace = useWorkspace()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    Object.assign(window, { workspaceProof: {
      ...accountBootstrapProof,
      saveDiagnostics: () => ({ canTransfer: workspace.saveSession.controller.canTransfer(), hydration: !!workspace.saveSession.hydration, recovery: workspace.saveSession.recovery?.outcome.status, focus: workspace.saveSession.controller.snapshot().focus, fields: workspace.saveSession.controller.snapshot().input?.fields, dirty: workspace.saveSession.controller.snapshot().dirty, phase: workspace.saveSession.phase, pending: workspace.fileCommandPending(), current: workspace.isCurrent(), kind: workspace.repository.kind }),
      saveContent: async () => {
        const state = await workspace.repository.readWorkspace()
        const { readSaveContent, saveExportStatus } = await import('../../src/workspace/save-repository')
        return Promise.all(state.saveDocuments.map(async file => { const content = await readSaveContent(state, file); return { file, original: Array.from(content.originalBytes), working: Array.from(content.workingBytes), exportStatus: await saveExportStatus(state, file) } }))
      },
      editorContent: async () => {
        const state = await workspace.repository.readWorkspace(), file = state.editorDocuments[0]
        if (!file) return undefined
        const content = await (await import('../../src/workspace/editor-document')).readEditorContent(state, file)
        return { original: Array.from(content.originalBytes), appliedText: content.lastAppliedText, unfinishedText: content.unfinishedText, fieldState: file.unfinished.fieldState, editedPath: file.unfinished.editedPath, validation: file.unfinished.validation, revision: file.revision }
      },
      async seedDefaultGuestProgress() {
        if (workspace.repository.kind !== 'guest') throw new Error('Default fixture requires the device workspace')
        const { createPlaythrough } = await import('../../src/domain/local-data')
        const { upsertProgress } = await import('../../src/domain/characters')
        const before = await workspace.repository.load()
        const definition = createPersonalDefinition(before.localData, { kind: 'class', name: 'Synthetic performance class' })
        const definitionId = Object.keys(definition.personalDefinitions).find(id => !before.localData.personalDefinitions[id])!
        const playthrough = createPlaythrough(definition, { label: 'Synthetic default-workspace Progress' })
        // Ordinary planner save preserves the initialized sample catalogs, source, and retained history
        await workspace.repository.save(upsertProgress(playthrough, { subject: { kind: 'personal', definitionId: definitionId as never }, displayName: 'Synthetic performance class', unlocked: { state: 'known', value: true } }), before.revision)
      },
      async signinMergeFixtureSizes() {
        const state = await workspace.repository.readWorkspace()
        let blobBytes = 0
        for (const blob of state.blobs) for await (const chunk of blob.content.open()) blobBytes += chunk.byteLength
        return { catalogs: state.planner.catalogs.length, catalogJsonBytes: new TextEncoder().encode(JSON.stringify(state.planner.catalogs)).byteLength,
          history: state.planner.history.length, historyJsonBytes: new TextEncoder().encode(JSON.stringify(state.planner.history)).byteLength, sources: state.planner.sources.length, blobs: state.blobs.length, blobBytes,
          progress: Object.values(state.planner.localData.playthroughs).reduce((sum, value) => sum + Object.keys(value.progress).length, 0),
          conflicts: state.conflicts.length }
      },
      async seedQualificationChoices(baseline: 'default' | 'retained') { return (await import('./signin-merge-qualification')).seedQualificationChoices(workspace.repository, baseline) },
      async qualificationEvidence() { return (await import('./signin-merge-qualification')).qualificationEvidence(workspace.repository) },
      async qualifyOldPublishedProgress() { return (await import('./signin-merge-qualification')).qualifyOldPublishedProgress(workspace.repository) },
      async seedGuestProgress(label: string) {
        if (workspace.repository.kind !== 'guest') throw new Error('Guest fixture requires the device workspace')
        const before = await workspace.repository.load()
        await workspace.repository.commitWorkspace(await signinProgressFixture(label, 'from-device'), before.revision)
      },
      async seedGuestEditor(input: { id: string; filename: string; originalText: string; draftText: string }) {
        if (workspace.repository.kind !== 'guest') throw new Error('This fixture requires the local workspace')
        const { editorBlob, encodeEditorText } = await import('../../src/workspace/editor-document')
        const before = await workspace.repository.readWorkspace()
        const original = await editorBlob(new TextEncoder().encode(input.originalText), 'utf8')
        const unfinished = await editorBlob(encodeEditorText(input.draftText), 'utf16le')
        const file = { version: 1 as const, id: input.id, revision: 0, filename: input.filename, referenceId: 'synthetic-reference', original: original.ref, originalByteIdentity: 'exact' as const, lastApplied: original.ref, unfinished: { text: unfinished.ref, editedPath: [], fieldState: {}, baseRevision: 0, validation: 'unchecked' as const }, createdAt: '2026-10-13', updatedAt: '2026-10-13' }
        await workspace.repository.commitWorkspace({ ...before, editorDocuments: [...before.editorDocuments, file], blobs: [...before.blobs, original, unfinished] }, before.planner.localData.revision)
      },
      artworkContent: async () => {
        const state = await workspace.repository.readWorkspace()
        const { blobIdentity, readBlob } = await import('../../src/workspace/blobs')
        return Promise.all(state.assets.filter(asset => asset.sourceKey.startsWith('private-mod-artwork-v1:')).map(async asset => {
          const body = state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(asset.original))
          if (!body) throw new Error('Missing private artwork original')
          return { id: asset.id, bytes: Array.from(await readBlob(body.content, asset.original.byteLength)) }
        }))
      },
      captureEditorAuthority: () => {
        const token = currentProfileToken(), view = workspace.editorSession.transferView!
        capturedEditorAuthority = () => {
          let viewRetired = false
          try { workspace.editorSession.controller.assertView(view) } catch { viewRetired = true }
          return { sameProfile: currentProfileToken() === token, repositoryCurrent: workspace.isCurrent(), viewRetired }
        }
      },
      inspectCapturedEditorAuthority: () => capturedEditorAuthority?.(),
      editorDiagnostics: () => ({ canTransfer: workspace.editorSession.controller.canTransfer(), phase: workspace.editorSession.phase, pending: workspace.fileCommandPending(), dirty: workspace.editorSession.controller.snapshot().dirty, revision: workspace.editorSession.controller.snapshot().revision, hydration: !!workspace.editorSession.hydration, current: workspace.isCurrent(), kind: workspace.repository.kind }),
      // Sample the captured repository after durable UI acknowledgement without exporting an archive
      savedPlanner: async () => (await workspace.repository.load()).localData,
      async readBackupPlanner(file: File) {
        const { readWorkspaceBackup } = await import('../../src/interchange/workspace-backup')
        const snapshot = await readWorkspaceBackup(memoryBlob(new Uint8Array(await file.arrayBuffer())).open())
        // Full archive validation precedes this small projection; reading never activates an imported workspace
        // Release the native encrypted staging before returning assertions to the driver
        try { return snapshot.state.planner.localData }
        finally { await disposeWorkspaceSnapshot(snapshot) }
      },
      async inspect(includeBackup = true) {
        const token = currentProfileToken()
        const response = await fetch('/api/v1/account')
        const principal = response.ok ? await response.json() : undefined
        const loaded = await workspace.repository.load()
        // Identity-only observations do not need to serialize and validate every retained catalog
        const backup = includeBackup ? await workspace.repository.previewImport(await workspace.repository.exportPlannerBackup(), 'proof.zip') : undefined
        return { playthroughs: Object.values(loaded.localData.playthroughs).map(value => ({ label: value.label, characters: Object.keys(value.characters).length, inventory: Object.keys(value.inventory).length, progress: Object.keys(value.progress).length, scenarios: Object.keys(value.scenarios).length })), kind: workspace.repository.kind, token, principal: principal?.accountId, access: token ? profileAccess(token) : undefined, digest: token ? await withAccountKey(token, async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).join(',')) : undefined, titles: Object.values(loaded.localData.builds).map(build => build.title), backupTitles: backup ? Object.values(backup.proposed.localData.builds).map(build => build.title) : undefined, definitions: Object.values(loaded.localData.personalDefinitions).map(value => value.name), backupDefinitions: backup ? Object.values(backup.proposed.localData.personalDefinitions).map(value => value.name) : undefined }
      },
      localDefinitions: async () => Object.values((await workspace.repository.load()).localData.personalDefinitions).map(value => value.name),
      async probeGuestRestoreCollisions(bytes: number[]) {
        if (workspace.repository.kind !== 'guest') throw new Error('Guest restore proof requires the selected local workspace')
        const { openGuestBindings } = await import('../../src/workspace/guest-workspace')
        const { CryKitDatabase } = await import('../../src/persistence/database')
        const { createBlankLocalData } = await import('../../src/domain/local-data')
        const { readWorkspaceBackup } = await import('../../src/interchange/workspace-backup')
        const { previewGuestWorkspaceRestore, beginGuestWorkspaceRestore, stageGuestWorkspaceRestore, releaseGuestWorkspaceRestorePreview } = await import('../../src/workspace/restore')
        // Collision proofs exercise the detached native restore engine without reopening unsupported public storage
        const detached = new CryKitDatabase(`restore-collision-proof-${crypto.randomUUID()}`)
        const localData = createBlankLocalData()
        await detached.localDatas.put({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
        const binding = await openGuestBindings(detached)
        const snapshot = await readWorkspaceBackup(memoryBlob(new Uint8Array(bytes)).open())
        let preview: Awaited<ReturnType<typeof previewGuestWorkspaceRestore>> | undefined
        try {
          preview = await previewGuestWorkspaceRestore(binding, snapshot)
          const cases = [
            { kind: 'planner', occupancy: 'same', version: 60 },
            { kind: 'inspector', occupancy: 'older', version: 1 },
            { kind: 'files', occupancy: 'future', version: 30 },
          ] as const
          const probes = []
          for (const probe of cases) {
            const selectedBefore = (await binding.coordinator.active.get('active'))?.manifest
            const journal = await beginGuestWorkspaceRestore(preview)
            const name = journal.target[probe.kind], marker = crypto.randomUUID()
            const occupied = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(name, probe.version)
              request.onupgradeneeded = () => request.result.createObjectStore('sentinel')
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            })
            await new Promise<void>((resolve, reject) => {
              const transaction = occupied.transaction('sentinel', 'readwrite')
              transaction.objectStore('sentinel').put(marker, 'proof')
              transaction.oncomplete = () => resolve()
              transaction.onabort = () => reject(transaction.error)
            })
            occupied.close()
            let denied = false, error = ''
            try { await stageGuestWorkspaceRestore(preview, journal.id) }
            catch (reason) { denied = true; error = String(reason) }
            const retained = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(name)
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            })
            try {
              const retainedMarker = await new Promise<unknown>((resolve, reject) => {
                const request = retained.transaction('sentinel').objectStore('sentinel').get('proof')
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
              })
              probes.push({ ...probe, denied, error, selectedBefore, selectedAfter: (await binding.coordinator.active.get('active'))?.manifest,
                marker, retainedMarker, retainedVersion: retained.version, stores: Array.from(retained.objectStoreNames) })
            } finally { retained.close() }
          }
          return probes
        } finally {
          if (preview) await releaseGuestWorkspaceRestorePreview(preview)
          await disposeWorkspaceSnapshot(snapshot)
          binding.planner.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close()
        }
      },
      teamState: async () => (await workspace.repository.load()).localData,
      async seedPublicComposition(composition: import('../../src/domain/types').ModComposition) {
        const before = await workspace.repository.readWorkspace()
        const { addGameSetupRevision } = await import('../../src/domain')
        const { prepareModComposition, composeModCatalog, expandModCatalogs } = await import('../../src/domain/mod-layers')
        const localData = addGameSetupRevision(before.planner.localData, { label: 'Synthetic explicit sharing composition', modComposition: prepareModComposition(composition, before.planner.catalogs), activate: false })
        const setup = Object.values(localData.gameSetups).find(value => !before.planner.localData.gameSetups[value.id])!
        const catalogs = expandModCatalogs([...before.planner.catalogs, composeModCatalog(setup, before.planner.catalogs)!])
        await workspace.repository.commitWorkspace({ ...before, planner: { ...before.planner, localData, catalogs } }, before.planner.localData.revision)
        if (workspace.repository.kind === 'account') await workspace.reopenAccount()
      },
      publicSharingState: async () => {
        const state = await workspace.repository.readWorkspace()
        return { localData: state.planner.localData, catalogPins: state.planner.catalogs.map(value => [value.id, value.revisionId]), sources: state.planner.sources.map(value => value.digest), defaults: state.libraryDefaults, assets: state.assets }
      },
      publishPublicFixture: async (snapshot: import('../../src/interchange/public-share-schema').PublicSnapshot) => {
        const { publishSnapshot } = await import('../../src/account/shares-client')
        return publishSnapshot(currentProfileToken()!, { mutationId: accountLocalId(), snapshot, includeAttribution: false })
      },
      buildInputState: () => ({ dirty: workspace.buildInputSession.controller.snapshot().dirty, scope: workspace.buildInputSession.scope, pending: workspace.buildInputSession.phase, values: workspace.buildInputSession.view ? workspace.buildInputSession.controller.recoveryInput(workspace.buildInputSession.view) : undefined }),
      async seedTeamFixture(account = false, publicSharing?: PublicSharingFixture) {
        if (account) return accountBootstrapProof.seedTeamFixture(true, publicSharing)
        const data = await teamFixtureData(publicSharing)
        const before = await workspace.repository.load()
        const { updateLocalData } = await import('../../src/domain/core')
        const { TEST_NOW } = await import('../../src/domain/test-helpers')
        const next = updateLocalData(before.localData, { gameSetups: data.gameSetups, builds: data.builds, buildRevisions: data.buildRevisions, personalDefinitions: data.personalDefinitions, playthroughs: data.playthroughs, selectedPlaythroughId: data.selectedPlaythroughId, planningGameSetupRevisionId: data.planningGameSetupRevisionId, teams: data.teams, teamRevisions: data.teamRevisions, modSetup: data.modSetup }, 'synthetic.team.seed', ['teams'], TEST_NOW)
        return workspace.repository.save(next, before.revision)
      },
      async selectionSnapshot() {
        const { localData } = await workspace.repository.load()
        return { selectedPlaythroughId: localData.selectedPlaythroughId, planningGameSetupRevisionId: localData.planningGameSetupRevisionId, scenarios: Object.fromEntries(Object.entries(localData.playthroughs).map(([id, value]) => [id, value.activeScenarioId])), definitions: Object.values(localData.personalDefinitions).map(value => value.name), characters: Object.values(localData.playthroughs).flatMap(value => Object.values(value.characters).map(value => value.name)) }
      },
      flushSync: workspace.flushSync,
      async editSaveConflict(currency: number) {
        const { createSaveRepository, readSaveContent } = await import('../../src/workspace/save-repository')
        const state = await workspace.repository.readWorkspace(), file = state.saveDocuments[0]
        const content = await readSaveContent(state, file), save = decodeCrystalSave(content.workingBytes)
        await createSaveRepository(workspace.repository, { intent: 'saveApply' }).saveWorking(file.id, encodeCrystalSave(editSave(save, SAVE_EDITOR_CATALOG, { type: 'currency', value: currency }, new Date('2026-01-02T03:04:05.000Z'))), { version: 99, inertConflictChoice: currency }, file.revision)
      },
      async saveConflictSnapshot() {
        const { inspectWorkspaceClosure } = await import('../../src/workspace/closure')
        const { readSaveContent } = await import('../../src/workspace/save-repository')
        const state = await workspace.repository.readWorkspace()
        const inspect = async (file: import('../../src/workspace/documents').SaveWorkspaceDocument) => {
          const content = await readSaveContent(state, file)
          return { file, original: Array.from(content.originalBytes), working: Array.from(content.workingBytes) }
        }
        return { files: await Promise.all(state.saveDocuments.map(inspect)), conflicts: await Promise.all(state.conflicts.map(async conflict => ({ id: conflict.id, disposition: conflict.disposition.kind, versions: await Promise.all(conflict.branches.map(async branch => ({ role: branch.role, ...await inspect((await inspectWorkspaceClosure(state, branch.closure)).value as import('../../src/workspace/documents').SaveWorkspaceDocument) }))) }))) }
      },
      async armSaveStrictRecovery() {
        const { getDatabase } = await import('../../src/persistence/database')
        const name = `${getDatabase().name}-coordinator`
        const view = workspace.saveSession.transferView!, controller = workspace.saveSession.controller
        stopSaveRecoveryInjection?.()
        const put = IDBObjectStore.prototype.put
        // Managed file publication has no bulk activation event; inject only after the exact pointer transaction commits
        const restore = () => { if (IDBObjectStore.prototype.put === watch) IDBObjectStore.prototype.put = put; if (stopSaveRecoveryInjection === restore) stopSaveRecoveryInjection = undefined }
        function watch(this: IDBObjectStore, ...args: Parameters<typeof put>) {
          if (this.name === 'active' && this.transaction.db.name === name && args[0]?.manifest?.version === 3) {
            restore()
            this.transaction.addEventListener('complete', () => controller.present(view, 'query', 'later recovery input'), { once: true })
          }
          return put.apply(this, args)
        }
        IDBObjectStore.prototype.put = watch
        stopSaveRecoveryInjection = restore
      },
      async editConflictFile(filename: string, unrelated = false, draftCodeUnit = 0xd800) {
        const before = await workspace.repository.readWorkspace()
        const file = before.editorDocuments.find(value => value.id === 'editor-1')!
        const bytes = new Uint8Array([draftCodeUnit & 255, draftCodeUnit >> 8])
        const ref = { documentId: accountLocalId(), revisionId: accountLocalId(), byteLength: bytes.length, sha256: await sha256(bytes), encoding: 'utf16le' as const }
        return workspace.repository.commitWorkspace({ ...before, blobs: [...before.blobs, { ref, content: memoryBlob(bytes) }], editorDocuments: [{ ...file, revision: file.revision + 1, filename, unfinished: { ...file.unfinished, text: ref } }, ...(unrelated ? [{ ...file, id: 'independent-file', filename: 'Unrelated saved file.json' }] : before.editorDocuments.filter(value => value.id !== file.id))] }, before.planner.localData.revision)
      },
      async saveUnrelatedConflictFile() {
        const before = await workspace.repository.readWorkspace()
        return workspace.repository.commitWorkspace({ ...before, editorDocuments: before.editorDocuments.map(file => file.id === 'independent-file' ? { ...file, revision: file.revision + 1, filename: 'Additional unrelated progress.json' } : file) }, before.planner.localData.revision)
      },
      async conflictSnapshot() {
        const { inspectWorkspaceClosure } = await import('../../src/workspace/closure')
        const { readBlob, blobIdentity } = await import('../../src/workspace/blobs')
        const state = await workspace.repository.readWorkspace()
        return { files: state.editorDocuments.map(value => value.filename), conflicts: await Promise.all(state.conflicts.map(async conflict => ({ id: conflict.id, disposition: conflict.disposition.kind, versions: await Promise.all(conflict.branches.map(async branch => {
          const inspected = await inspectWorkspaceClosure(state, branch.closure)
          const file = inspected.value as import('../../src/workspace/documents').EditorWorkspaceDocument
          return { role: branch.role, filename: file.filename, validation: file.unfinished.validation, draftBytes: Array.from(await readBlob(state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(file.unfinished.text))!.content, file.unfinished.text.byteLength)) }
        })) }))) }
      },
      async chooseSelectors(index: number) {
        const before = await workspace.repository.load(), data = before.localData
        const selected = Object.values(data.playthroughs).find(value => value.label === (index === 0 ? 'First local journey' : 'Second local journey'))!
        const playthroughs = Object.fromEntries(Object.entries(data.playthroughs).map(([id, value]) => [id, { ...value, activeScenarioId: Object.values(value.scenarios).find(value => value.label === (index === 0 ? 'First local scenario' : 'Second local scenario'))!.id }]))
        return workspace.repository.save({ ...data, selectedPlaythroughId: selected.id, planningGameSetupRevisionId: selected.currentGameSetupRevisionId, playthroughs }, before.revision)
      },
      cached: listCachedProfiles,
      pending: async (accountId: string) => (await readDeviceProfile(accountId))?.pendingRevocations,
      async saveDefinition(name: string) {
        const before = await workspace.repository.load()
        const saved = await workspace.repository.save(createPersonalDefinition(before.localData, { name, kind: 'item' }), before.revision)
        // The restart oracle needs the exact saved planner; unused catalogs must not enter the browser protocol and trace
        return { localData: saved.localData }
      },
      async queueDefinition(name: string) {
        const captured = workspace.repository
        const before = await captured.load()
        const wait = new Promise<void>(resolve => { releaseQueued = resolve })
        queuedResult = wait.then(() => captured.save(createPersonalDefinition(before.localData, { name, kind: 'item' }), before.revision)).then(() => 'saved', error => error.code ?? error.message)
      },
      releaseQueued: async () => { releaseQueued?.(); return queuedResult },
      previewBackup: async (bytes: number[]) => previewImport(new Uint8Array(bytes), 'recovery.zip'),
      crash: () => setFailed(true),
    } })
    return () => { stopSaveRecoveryInjection?.(); delete (window as unknown as { workspaceProof?: unknown }).workspaceProof }
  }, [workspace])
  if (failed) throw new Error('Synthetic render failure')
  return <App/>
}
let fixtureAdmission: ProfileToken | undefined
function FixtureAdmission() {
  const workspace = useWorkspace()
  useEffect(() => {
    if (!fixtureAdmission) return
    const token = fixtureAdmission
    fixtureAdmission = undefined
    void workspace.openAccount(token)
  }, [workspace])
  return workspace.repository.kind === 'account' || !new URLSearchParams(location.search).has('fixture-setup') ? <WorkspaceProof/> : <p role="status">Opening synthetic fixture...</p>
}
let mounted = false
function mountWorkspaceProof() {
  if (mounted) throw new Error('Workspace proof already mounted')
  mounted = true
  createRoot(document.getElementById('root')!, { onCaughtError: () => {} }).render(<WorkspaceProvider><FixtureAdmission/></WorkspaceProvider>)
}
if (!new URLSearchParams(location.search).has('fixture-setup')) mountWorkspaceProof()

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createServiceFixture } from '../../worker/testing/service-fixture'
import { accountLocalId } from '../workspace/account-cache'
import type { ServiceFixture } from '../../worker/testing/service-fixture'
import { AccountDatabase } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { openAccountRepository } from '../workspace/account-repository'
import { registerSyncProjectionGuard, runSyncIteration } from '../account/sync/outbox'
import { SyncError } from '../account/sync/client'

import { prepareManagedSync, seedManagedWorkspace } from './managed-sync.test-helpers'

import { customer } from './sync-customer.test-helpers'

// Each file owns its profile and database lifetime; the shared sign-in helper retains no state
let service: ServiceFixture | undefined
afterEach(async () => { vi.unstubAllGlobals(); invalidateProfile(); await service?.dispose() })
it('unionsDisjointHistoricalOriginalsAndReexportsThemOnBothDevices', async () => {
  const { activateLocalAccountCommit } = await import('./account-database')
  const { openAccountWorkspace, prepareAccountWorkspaceWithEvidence } = await import('../workspace/account-graph')
  const { createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { inheritWorkspaceSnapshot } = await import('../interchange/workspace-backup-evidence')
  const { stageMappedWorkspaceIntent, mappedChanges } = await import('../workspace/account-intents')
  const { cipherRef } = await import('../workspace/account-cache')
  const { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot } = await import('../workspace/snapshot')
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { readBlob } = await import('../workspace/blobs')
  const { prepareIncrementalBaseline, activateIncrementalBaseline, readIncrementalMappedRoot } = await import('../workspace/account-local-mapping')
  const { prepareManagedAccountProjection } = await import('../workspace/account-managed-projection')
  const key = crypto.getRandomValues(new Uint8Array(32)), originalFactory = Dexie.dependencies.indexedDB
  const factories = [new IDBFactory(), new IDBFactory()], databases: AccountDatabase[] = []
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'history_devices')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const device = async (index: number) => {
    invalidateProfile(); Dexie.dependencies.indexedDB = factories[index]
    const token = installProfile(session.accountId, key.slice(), session)
    const db = new AccountDatabase(token.accountId); databases.push(db)
    let repo = await openAccountRepository(token)
    const fence = (await db.profileMeta.get('active'))!
    // Node runs the actual mapper preparation and activation; browser tests own its Worker transport
    if (!await readIncrementalMappedRoot(db, token, fence)) await activateIncrementalBaseline(db, token, await prepareIncrementalBaseline(db, token, fence))
    registerSyncProjectionGuard(token, () => true)
    const settle = async () => {
      for (let turn = 0; turn < 160; turn++) {
        try {
          const result = await runSyncIteration(token, new AbortController().signal)
          if (result.state === 'synced') { repo = await openAccountRepository(token); return }
          if (!result.moreWork) throw new Error(`Unexpected ${result.state}`)
        }
        catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      }
      throw new Error('Historical sync did not settle')
    }
    return { token, db, get repo() { return repo }, settle }
  }
  const stageHistory = async (selected: Awaited<ReturnType<typeof device>>, label: string) => {
    const fence = (await selected.db.profileMeta.get('active'))!, mapped = (await readIncrementalMappedRoot(selected.db, selected.token, fence))!
    const source = await openAccountWorkspace(selected.db, selected.token, mapped)
    const fixture = await editorClosureFixture()
    const current = { version: 1 as const, snapshotId: `current-${label}`, capturedAt: '2026-10-13', revisionVector: {}, state: fixture.state }
    const historical = { ...current, snapshotId: `historical-${label}`, state: { ...fixture.state, editorDocuments: [{ ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { original: `\ud800${label}` } } }] } }
    const inherited = await inheritWorkspaceSnapshot(current, [historical])
    const operation = createAccountInheritedEvidencePreparation(selected.db, selected.token)
    try {
      const evidence = await operation.prepare({ additions: [inherited] })
      const successor = await prepareAccountWorkspaceWithEvidence(selected.db, selected.token, source.state, evidence, source)
      const id = accountLocalId(), intent = await stageMappedWorkspaceIntent(selected.db, selected.token, {
        version: 1, kind: 'mapped-workspace-intent', operationId: id, portableGroupId: accountLocalId(), operation: 'workspace-command', mode: 'replace',
        original: { base: source.head, target: successor.head }, base: source.head, target: successor.head, localRevision: fence.headRevision + 1,
        changes: mappedChanges(source, successor.opened),
      })
      const projection = await prepareManagedAccountProjection(selected.db, selected.token, fence, successor, { id, ref: cipherRef(intent.record), records: intent.records })
      try { await activateLocalAccountCommit(selected.db, selected.token, projection.prepared) }
      finally { await projection.dispose() }
    } finally { await operation.abandon(); await disposeWorkspaceSnapshot(inherited) }
  }
  const assertExport = async (selected: Awaited<ReturnType<typeof device>>) => {
    const snapshot = await captureWorkspaceSnapshot(selected.repo)
    try {
      expect(snapshot.version).toBe(2)
      if (snapshot.version !== 2) throw new Error('Missing historical evidence')
      expect(snapshot.historicalEvidence.snapshots).toHaveLength(2)
      const metadata = []
      for (const member of snapshot.historicalEvidence.snapshots) {
        const historical = await openHistoricalSnapshot(snapshot, member.id)
        try {
          const body = historical.state.blobs.find(blob => blob.ref.documentId === 'text')!
          expect(await readBlob(body.content, body.ref.byteLength)).toEqual(new Uint8Array([0x00, 0xd8]))
          metadata.push(historical.state.editorDocuments[0].unfinished.fieldState)
        } finally { await disposeWorkspaceSnapshot(historical) }
      }
      expect(metadata).toEqual(expect.arrayContaining([{ original: '\ud800A' }, { original: '\ud800B' }]))
      const exported = await readWorkspaceBackup(exportWorkspaceBackup(snapshot))
      try { expect(exported.version).toBe(2); if (exported.version === 2) expect(exported.historicalEvidence).toEqual(snapshot.historicalEvidence) }
      finally { await disposeWorkspaceSnapshot(exported) }
    } finally { await disposeWorkspaceSnapshot(snapshot) }
  }
  try {
    let a = await device(0)
    await a.settle()
    let b = await device(1)
    await b.settle()
    a = await device(0)
    await stageHistory(a, 'A')
    b = await device(1)
    await stageHistory(b, 'B')
    a = await device(0)
    await a.settle()
    b = await device(1)
    await b.settle()
    a = await device(0)
    await a.settle()
    await assertExport(a)
    b = await device(1)
    await assertExport(b)
  } finally { invalidateProfile(); for (const db of databases) await db.delete(); Dexie.dependencies.indexedDB = originalFactory }
}, 180_000)

it('publishesRestoredHistoricalOriginalsForExactReexportOnAnotherDevice', async () => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot } = await import('../workspace/snapshot')
  const { previewAccountWorkspaceRestore, stageAccountWorkspaceRestore, activateAccountWorkspaceRestore, releaseAccountWorkspaceRestorePreview, releaseAccountWorkspaceRestoreStage } = await import('../workspace/account-restore')
  const { readBlob } = await import('../workspace/blobs')
  const key = crypto.getRandomValues(new Uint8Array(32)), originalFactory = Dexie.dependencies.indexedDB
  const factories = [new IDBFactory(), new IDBFactory()], databases: AccountDatabase[] = []
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'restore_devices')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const device = async (index: number) => {
    invalidateProfile(); Dexie.dependencies.indexedDB = factories[index]
    const token = installProfile(session.accountId, key.slice(), session)
    const db = new AccountDatabase(token.accountId); databases.push(db)
    let repo = await openAccountRepository(token)
    registerSyncProjectionGuard(token, () => true)
    const settle = async () => {
      await prepareManagedSync(db, token)
      for (let turn = 0; turn < 160; turn++) {
        try { const result = await runSyncIteration(token, new AbortController().signal); if (result.state === 'synced') { repo = await openAccountRepository(token); return } if (!result.moreWork) throw new Error(`Unexpected ${result.state}`) }
        catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      }
      throw new Error('Restored history did not settle')
    }
    return { token, db, get repo() { return repo }, settle }
  }
  try {
    const a = await device(0)
    await a.settle()
    const fixture = await editorClosureFixture()
    const source = { version: 1 as const, snapshotId: 'restored-on-a', capturedAt: '2026-10-13', revisionVector: {}, state: { ...fixture.state, editorDocuments: [{ ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { original: '\ud800restored' } } }] } }
    const backup = await readWorkspaceBackup(exportWorkspaceBackup(source))
    try {
      const preview = await previewAccountWorkspaceRestore(a.db, a.token, backup)
      try {
        const stage = await stageAccountWorkspaceRestore(preview)
        try { await activateAccountWorkspaceRestore(stage) }
        finally { await releaseAccountWorkspaceRestoreStage(stage) }
      } finally { releaseAccountWorkspaceRestorePreview(preview) }
    } finally { await disposeWorkspaceSnapshot(backup) }
    await a.settle()
    const b = await device(1)
    await b.settle()
    const captured = await captureWorkspaceSnapshot(b.repo)
    try {
      expect(captured.version).toBe(2)
      if (captured.version !== 2) throw new Error('Restored original was not carried to device B')
      expect(captured.historicalEvidence.snapshots).toHaveLength(1)
      const historical = await openHistoricalSnapshot(captured, captured.historicalEvidence.snapshots[0].id)
      try {
        expect(historical.state.editorDocuments[0].unfinished.fieldState).toEqual({ original: '\ud800restored' })
        const original = historical.state.blobs.find(blob => blob.ref.documentId === 'text')!
        expect(await readBlob(original.content, original.ref.byteLength)).toEqual(new Uint8Array([0x00, 0xd8]))
      } finally { await disposeWorkspaceSnapshot(historical) }
      const exported = await readWorkspaceBackup(exportWorkspaceBackup(captured))
      try { expect(exported.version).toBe(2); if (exported.version === 2) expect(exported.historicalEvidence).toEqual(captured.historicalEvidence) }
      finally { await disposeWorkspaceSnapshot(exported) }
    } finally { await disposeWorkspaceSnapshot(captured) }
  } finally { invalidateProfile(); for (const db of databases) await db.delete(); Dexie.dependencies.indexedDB = originalFactory }
}, 120_000)

it('publishes the first pending copy once and preserves every original on a fresh second device', async () => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { createGuestCopyService } = await import('../workspace/guest-copy')
  const { ownWorkspaceSnapshot, captureWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { blobIdentity, readBlob } = await import('../workspace/blobs')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'first_copy'), key = crypto.getRandomValues(new Uint8Array(32))
  const originalFactory = Dexie.dependencies.indexedDB, databases: AccountDatabase[] = [], publications = new Set<string>()
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    const response = await service!.request(path, { ...init, headers })
    if (path.endsWith('/commits') && response.ok) {
      const command = JSON.parse(init.body as string) as { mutationId: string; heads: unknown[] }
      if (command.heads.length) publications.add(command.mutationId)
    }
    return response
  })
  const fixture = await editorClosureFixture(), blank = { ...fixture.state, blobs: [], retainedContent: [] }
  const source = ownWorkspaceSnapshot({ version: 1, snapshotId: 'first-copy-original', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: { ...fixture.state, editorDocuments: [fixture.file] } }, { check: async () => {}, dispose: async () => {} })
  const copy = createGuestCopyService(async () => source)
  const openDevice = async () => {
    invalidateProfile(); Dexie.dependencies.indexedDB = new IDBFactory()
    const token = installProfile(session.accountId, key.slice(), session), db = new AccountDatabase(token.accountId)
    databases.push(db); await seedManagedWorkspace(db, token, blank); registerSyncProjectionGuard(token, () => true)
    return { token, db }
  }
  const settle = async ({ token, db }: Awaited<ReturnType<typeof openDevice>>) => {
    await prepareManagedSync(db, token)
    for (let turn = 0; turn < 160; turn++) {
      try { const result = await runSyncIteration(token, new AbortController().signal); if (result.state === 'synced') return; expect(result.moreWork).toBe(true) }
      catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
    }
    throw new Error('Initial copy did not settle')
  }
  try {
    const first = await openDevice()
    await copy.commitGuestCopy(first.token, await copy.previewGuestCopy(first.token, ['["editor","editor-1"]']))
    const localSelection = await first.db.profileMeta.get('active'), liveRepository = await openAccountRepository(first.token)
    await settle(first)
    expect(await first.db.profileMeta.get('active')).toEqual(localSelection)
    expect((await liveRepository.readWorkspace()).editorDocuments).toEqual([fixture.file])
    expect(publications.size).toBe(1)
    expect(await first.db.outbox.count()).toBe(0)
    const saved = await captureWorkspaceSnapshot(await openAccountRepository(first.token))
    let originalIds: string[]
    try {
      if (saved.version !== 2) throw new Error('Originals are missing')
      originalIds = saved.historicalEvidence.snapshots.map(member => member.id)
    } finally { await disposeWorkspaceSnapshot(saved) }
    const second = await openDevice()
    await settle(second)
    expect(publications.size).toBe(1)
    const received = await captureWorkspaceSnapshot(await openAccountRepository(second.token))
    try {
      expect(received.state.editorDocuments).toEqual([fixture.file])
      if (received.version !== 2) throw new Error('Synced originals are missing')
      expect(received.historicalEvidence.snapshots.map(member => member.id)).toEqual(originalIds)
      for (const member of received.historicalEvidence.snapshots) {
        const child = await openHistoricalSnapshot(received, member.id)
        try {
          for (const body of fixture.state.blobs) expect(await readBlob(child.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
        } finally { await disposeWorkspaceSnapshot(child) }
      }
    } finally { await disposeWorkspaceSnapshot(received) }
  } finally { await copy.dispose(); await disposeWorkspaceSnapshot(source); invalidateProfile(); for (const db of databases) await db.delete(); Dexie.dependencies.indexedDB = originalFactory; key.fill(0) }
})

import { accountConnectivity, prepareAccountProofCache } from './network-fixture'
import { WORKSPACE_STARTUP_MARK } from '../../src/diagnostics/workspace-startup'
import { assertAccountStorageRecovery } from './storage-recovery'
import 'fake-indexeddb/auto'
import { readFile, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from './test-fixture'

// Independent synthetic cases retain the real limiter within each journey
test.beforeEach(async ({ request }) => { expect((await request.post('/__accounts/control/reset-rate-counters', { data: {} })).ok()).toBe(true) })
import { exportWorkspaceBackup, readWorkspaceBackup } from '../../src/interchange/workspace-backup'
import { blobIdentity, hashBlob, memoryBlob, readBlob } from '../../src/workspace/blobs'
import { backupMetadataDigest, disposeWorkspaceSnapshot, openHistoricalSnapshot } from '../../src/workspace/snapshot'
import { selectedGuestPlannerName } from '../local-data-helpers'
import { readManagedGuestPlanner } from '../guest-planner-reader'
import type { LocalDataRecord } from '../../src/persistence/database'
import type { PersistedHistoryEntry } from '../../src/interchange/types'
import { BUNDLED_CATALOGS } from '../../src/catalog/bundled'
import type { CatalogSnapshot, PersonalDefinition } from '../../src/domain/types'
import { retainFileRevision } from '../../src/workspace/file-history'
import { retainEditorRevision } from '../../src/workspace/editor-document'
import { inspectWorkspaceClosure } from '../../src/workspace/closure'
import type { EditorWorkspaceDocument, SaveWorkspaceDocument, WorkspaceState } from '../../src/workspace/documents'

const app = '/__accounts-proof/account-workspace.html'
const JOURNEY_BUDGET_MS = 600_000
const privateOriginal = 'PRIVATE_O05_HISTORICAL_ORIGINAL'
const STARTUP_CONSOLE_PREFIX = 'workspace-startup '
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
async function fixture() {
  const fixtures = JSON.parse(await readFile(new URL('../../src/interchange/workspace-backup-v1.fixtures.json', import.meta.url), 'utf8')) as { archive: string }[]
  const snapshot = await readWorkspaceBackup(memoryBlob(Buffer.from(fixtures[2].archive, 'base64')).open())
  try {
    const original = memoryBlob(new TextEncoder().encode(privateOriginal))
    const ref = { documentId: 'historical-original', revisionId: 'historical-original-1', byteLength: original.byteLength, sha256: await hashBlob(original), encoding: 'bytes' as const }
    const historicSave = { ...snapshot.state.saveDocuments[0]!, original: ref, working: ref, filename: 'historical-only.sav' }
    const historicEditor = { ...snapshot.state.editorDocuments[0]!, original: ref, originalByteIdentity: 'exact' as const, filename: 'historical-only.json' }
    let state: WorkspaceState = { ...snapshot.state, saveDocuments: [historicSave], editorDocuments: [historicEditor], blobs: [...snapshot.state.blobs, { ref, content: original }] }
    state = await retainFileRevision(state, historicSave, 'protected')
    state = await retainEditorRevision(state, historicEditor, 'protected')
    // The original exists only in retained history, so testing current files alone cannot satisfy this proof
    state = { ...state, saveDocuments: snapshot.state.saveDocuments, editorDocuments: snapshot.state.editorDocuments }
    return await collect(exportWorkspaceBackup({ ...snapshot, state }))
  } finally { await disposeWorkspaceSnapshot(snapshot) }
}
async function signIn(page: Page, email: string, password: string, migrateNative = false) {
  await page.goto(`${app}#/settings/account`)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Remember this device').first().check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  if (migrateNative) {
    await expect(page.getByRole('button', { name: 'Open account workspace', exact: true })).toBeVisible()
    const original = await page.evaluate(() => (window as any).accountBootstrapProof.seedSelectionFixture())
    expect((await page.evaluate(() => (window as any).accountBootstrapProof.accountStorage())).rootVersion).toBe(1)
    // Inspect native admission before cloud publication can advance the selected root
    // Release the actual requests afterward; all later cloud and offline recovery proofs still run
    const syncRequests = '**/api/v1/sync/**'
    let releasePublication!: () => void
    const publicationGate = new Promise<void>(resolve => { releasePublication = resolve })
    await page.route(syncRequests, async route => { await publicationGate; await route.continue() })
    try {
      await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
      expect((await page.evaluate(() => (window as any).workspaceProof.accountStorage())).rootVersion).toBe(3)
      expect(await page.evaluate(() => (window as any).workspaceProof.savedPlanner())).toEqual(original)
    } finally {
      releasePublication()
      // Complete held continuations before removing their interception
      await page.unrouteAll({ behavior: 'wait' })
    }
    return
  }
  await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
}
async function downloadBackup(page: Page) {
  // Document load can precede workspace initialization; route changes must follow the same readiness as user actions
  await page.waitForFunction(() => !!(window as any).workspaceProof)
  await page.evaluate(() => { location.hash = '#/settings/data' })
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  return readFile((await (await download).path())!)
}
async function catalogDigests(catalogs: readonly CatalogSnapshot[]) {
  return Object.fromEntries(await Promise.all(catalogs.map(async catalog => [JSON.stringify([catalog.id, catalog.revisionId, catalog.checksum]), await backupMetadataDigest(catalog)])))
}
async function privateContent(bytes: Uint8Array, authoredDefinition?: PersonalDefinition) {
  const snapshot = await readWorkspaceBackup(memoryBlob(bytes).open())
  try {
    const originals = new Map<string, string>()
    let authoredPending = 0
    async function inspect(state: WorkspaceState, current = false) {
      async function file(value: Pick<EditorWorkspaceDocument, 'original'>) {
        const blob = state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(value.original))
        if (!blob) throw new Error('Missing historical original')
        const content = await readBlob(blob.content, value.original.byteLength)
        expect(await hashBlob(memoryBlob(content))).toBe(value.original.sha256)
        originals.set(value.original.sha256, Buffer.from(content).toString('base64'))
      }
      for (const value of [...state.editorDocuments, ...state.saveDocuments, ...state.planner.sources, ...state.assets]) await file(value)
      for (const retained of state.retainedContent) {
        if (retained.kind === 'file-history') await file((await inspectWorkspaceClosure(state, retained.content)).value as EditorWorkspaceDocument | SaveWorkspaceDocument)
        else if (current && authoredDefinition && retained.unit.privateKey === JSON.stringify(['personal-definition', authoredDefinition.id])) {
          // Publication acceptance alone cannot discard this separately retained local preparation
          expect(retained.unit).toEqual({ kind: 'record', privateKey: JSON.stringify(['personal-definition', authoredDefinition.id]) })
          expect(retained.base).toEqual({ kind: 'absent' })
          expect(retained.id).toBe(`${retained.groupId}:${retained.unit.privateKey}`)
          const target = await inspectWorkspaceClosure(state, retained.target)
          expect(target.root.kind).toBe('personal-definition')
          expect(target.root.key).toBe(retained.unit.privateKey)
          expect(target.value).toEqual(authoredDefinition)
          authoredPending++
        } else {
          // The frozen fixture's pending editor target shares original bytes with current content
          // Include them in exact cross-device equality so filtering local-only roots cannot hide byte loss
          expect(retained.unit).toEqual({ kind: 'record', privateKey: '["editor","editor-1"]' })
          await file((await inspectWorkspaceClosure(state, retained.target)).value as EditorWorkspaceDocument)
          if (retained.base.kind === 'present') await file((await inspectWorkspaceClosure(state, retained.base.closure)).value as EditorWorkspaceDocument)
        }
      }
    }
    await inspect(snapshot.state, true)
    expect(authoredPending).toBe(authoredDefinition ? 1 : 0)
    if (snapshot.version === 2) for (const evidence of snapshot.historicalEvidence.snapshots) {
      const history = await openHistoricalSnapshot(snapshot, evidence.id)
      try { await inspect(history.state) } finally { await disposeWorkspaceSnapshot(history) }
    }
    const { blobs: _blobs, ...metadata } = snapshot.state
    return { metadata: { ...metadata, retainedContent: [...metadata.retainedContent].sort((a, b) => a.id.localeCompare(b.id)), planner: { ...metadata.planner, catalogs: await catalogDigests(metadata.planner.catalogs) } }, originals: Object.fromEntries([...originals].sort(([a], [b]) => a.localeCompare(b))) }
  } finally { await disposeWorkspaceSnapshot(snapshot) }
}

test('twoDevicesRestoreCompleteWorkspaceWithoutLeakingToViewerOrAdmin', async ({ browser, accountRuntime, ignoreHTTPSErrors }, testInfo) => {
  // This finite budget bounds the test process, not a product publication latency promise
  test.setTimeout(JOURNEY_BUDGET_MS)
  const network = await accountConnectivity(accountRuntime.origin, accountRuntime.certificate)
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ baseURL: network.origin, ignoreHTTPSErrors })))
  const [owner, second, viewer] = await Promise.all(contexts.map(context => context.newPage()))
  const startup: { navigationId: string; phase: string; elapsedMilliseconds: number }[] = []
  owner.on('console', message => { if (message.text().startsWith(STARTUP_CONSOLE_PREFIX)) startup.push(JSON.parse(message.text().slice(STARTUP_CONSOLE_PREFIX.length))) })
  await owner.addInitScript(({ mark, prefix }) => {
    const navigationId = crypto.randomUUID()
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.name === mark) console.info(prefix + JSON.stringify({ navigationId, phase: (entry as PerformanceMark).detail.phase, elapsedMilliseconds: entry.startTime }))
    }).observe({ entryTypes: ['mark'] })
  }, { mark: WORKSPACE_STARTUP_MARK, prefix: STARTUP_CONSOLE_PREFIX })
  const backup = await fixture(), expected = await privateContent(backup)
  const username = `full_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`, password = 'synthetic complete workspace password'
  const statuses: Record<string, number> = {}, started = Date.now()
  const runtimeBefore = await (await owner.request.get('/__accounts/measurement')).json()
  owner.on('response', response => { if (response.url().includes('/api/v1/sync/')) { const key = `${new URL(response.url()).pathname.replace(/(\/uploads|\/mutations)\/[^/]+/g, '$1/:id')}:${response.status()}`; statuses[key] = (statuses[key] ?? 0) + 1 } })
  try {
    for (const page of [owner, second]) await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
    await owner.goto('/__accounts-proof/')
    await prepareAccountProofCache(owner)
    await expect(owner.locator('#status')).toHaveText('Browser worker and offline cache ready')
    await owner.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await owner.request.post('/__accounts/jobs')
    const emails = await (await owner.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
    await owner.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(row => row.recipient === email)!.capability)
    await signIn(owner, email, password, true)
    const status = owner.getByRole('complementary', { name: 'Account sync' }).getByRole('status')
    await expect(status).toHaveText('Synced', { timeout: 60_000 })
    await owner.evaluate(() => { location.hash = '#/settings/data' })
    const panel = owner.getByRole('dialog', { name: 'Data & settings', exact: true })
    await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'complete.crykit', mimeType: 'application/octet-stream', buffer: backup })
    await expect(panel.getByText('Complete workspace preview', { exact: true })).toBeVisible()
    await panel.getByLabel('Confirm complete workspace replacement').check()
    const reopened = owner.waitForEvent('load')
    await panel.getByRole('button', { name: 'Replace saved workspace', exact: true }).click()
    await reopened
    const restored = await privateContent(await downloadBackup(owner))
    expect(restored.originals).toEqual(expected.originals)
    expect(restored.metadata.editorDocuments).toEqual(expected.metadata.editorDocuments)
    expect(restored.metadata.saveDocuments).toEqual(expected.metadata.saveDocuments)
    expect(restored.metadata.assets).toEqual(expected.metadata.assets)
    expect(restored.metadata.planner.history).toEqual(expected.metadata.planner.history)
    expect(restored.metadata.planner.catalogs).toEqual(expected.metadata.planner.catalogs)
    expect(restored.metadata.planner.sources).toEqual(expected.metadata.planner.sources)
    expect(restored.metadata.planner.evidence).toEqual(expected.metadata.planner.evidence)
    expect(restored.metadata.libraryDefaults).toEqual(expected.metadata.libraryDefaults)
    expect(restored.metadata.retainedContent).toEqual(expected.metadata.retainedContent)

    // A real local command is durable before its encrypted projection is mapped
    // Restart must reopen that exact local head and retain every original while cloud work is pending
    // Disconnect the owned listener while preserving the upstream Worker and its storage
    // WebKit's protocol offline emulation rejects navigation before its cached ServiceWorker response
    await network.stop()
    expect(await owner.evaluate(() => fetch('/api/v1/account?uncached=1', { cache: 'no-store' }).then(() => false, () => true))).toBe(true)
    const saved = await owner.evaluate(() => (window as any).workspaceProof.saveDefinition('Synthetic pending restart definition'))
    const pending = await owner.evaluate(() => (window as any).workspaceProof.accountStorage())
    expect(pending.rootVersion).toBe(3)
    expect(pending.pending.some((row: { status: string }) => row.status === 'unmapped-local')).toBe(true)
    await owner.reload()
    await owner.waitForFunction(() => !!(window as any).workspaceProof)
    expect(await owner.evaluate(() => (window as any).workspaceProof.savedPlanner())).toEqual(saved.localData)
    expect(await owner.evaluate(() => (window as any).workspaceProof.accountStorage())).toEqual(pending)
    const restarted = await privateContent(await downloadBackup(owner))
    expect(restarted.originals).toEqual(restored.originals)
    for (const key of ['editorDocuments', 'saveDocuments', 'assets', 'libraryDefaults', 'retainedContent'] as const) expect(restarted.metadata[key]).toEqual(restored.metadata[key])
    for (const key of ['catalogs', 'sources', 'evidence'] as const) expect(restarted.metadata.planner[key]).toEqual(restored.metadata.planner[key])
    expect(restarted.metadata.planner.localData).toEqual(saved.localData)
    expect(restarted.metadata.planner.history.slice(0, restored.metadata.planner.history.length)).toEqual(restored.metadata.planner.history)
    const authored = restarted.metadata.planner.history.slice(restored.metadata.planner.history.length)
    expect(authored).toHaveLength(1)
    expect(authored[0].command).toBe('personalDefinition.create')
    expect(authored[0].before).toEqual(restored.metadata.planner.localData)
    expect(authored[0].after).toEqual(saved.localData)
    const authoredDefinitions = Object.values(saved.localData.personalDefinitions as Record<string, PersonalDefinition>).filter(value => !restored.metadata.planner.localData.personalDefinitions[value.id])
    expect(authoredDefinitions).toHaveLength(1)
    await network.start()
    await panel.getByRole('button', { name: 'Close dialog' }).click()
    await owner.evaluate(() => { location.hash = '#/settings/account' })
    await owner.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect(owner.getByText('Online access reconnected.', { exact: true })).toBeVisible()
    await expect(status).toHaveText('Synced', { timeout: JOURNEY_BUDGET_MS / 2 })
    const drainedAt = Date.now()
    await signIn(second, email, password)
    await expect(second.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: JOURNEY_BUDGET_MS / 2 })
    // Remote activation retires the captured view; adopt it through the existing guarded user action
    await second.getByRole('button', { name: 'Load updated data', exact: true }).click()
    await expect(second.getByRole('button', { name: 'Load updated data', exact: true })).toHaveCount(0)
    const secondDeviceWorkspace = await privateContent(await downloadBackup(second))
    expect(secondDeviceWorkspace.originals).toEqual(expected.originals)
    expect(secondDeviceWorkspace.metadata.editorDocuments).toEqual(restored.metadata.editorDocuments)
    expect(secondDeviceWorkspace.metadata.saveDocuments).toEqual(restored.metadata.saveDocuments)
    expect(secondDeviceWorkspace.metadata.assets).toEqual(restored.metadata.assets)
    expect(secondDeviceWorkspace.metadata.planner.history).toEqual(restarted.metadata.planner.history)
    expect(secondDeviceWorkspace.metadata.planner.catalogs).toEqual(restored.metadata.planner.catalogs)
    expect(secondDeviceWorkspace.metadata.planner.sources).toEqual(restored.metadata.planner.sources)
    expect(secondDeviceWorkspace.metadata.planner.evidence).toEqual(restored.metadata.planner.evidence)
    expect(secondDeviceWorkspace.metadata.libraryDefaults).toEqual(restored.metadata.libraryDefaults)
    // Pending recovery is portable local content, not an implicitly activated cloud head
    expect(secondDeviceWorkspace.metadata.retainedContent).toEqual(restored.metadata.retainedContent.filter(value => value.kind === 'file-history'))
    await owner.reload()
    const finalOwner = await privateContent(await downloadBackup(owner), authoredDefinitions[0])
    const authoredPending = finalOwner.metadata.retainedContent.filter(value => value.kind === 'pending-content' && value.unit.privateKey === JSON.stringify(['personal-definition', authoredDefinitions[0].id]))
    expect(authoredPending).toHaveLength(1)
    expect(finalOwner.metadata.retainedContent).toEqual([...restored.metadata.retainedContent, ...authoredPending].sort((a, b) => a.id.localeCompare(b.id)))
    expect(finalOwner.originals).toEqual(expected.originals)
    for (const key of ['gameSetups', 'builds', 'buildRevisions', 'teams', 'teamRevisions', 'personalDefinitions', 'playthroughs'] as const) expect(secondDeviceWorkspace.metadata.planner.localData[key]).toEqual(restarted.metadata.planner.localData[key])
    expect(secondDeviceWorkspace.metadata.planner.localData.selectedPlaythroughId).toBeUndefined()
    expect(secondDeviceWorkspace.metadata.planner.localData.planningGameSetupRevisionId).toBeUndefined()

    const artifacts = await Promise.all(['/api/v1/account', '/api/v1/sync/head', '/admin', '/api/admin/v1/accounts'].map(async path => {
      const response = await viewer.request.get(path)
      // This fixture has no configured Access operator; authenticated-admin artifacts have their own suite
      const admin = path.startsWith('/admin') || path.startsWith('/api/admin/')
      expect(response.status()).toBe(admin ? 503 : 401)
      expect((await response.json()).error.code).toBe(admin ? 'SERVICE_UNAVAILABLE' : 'AUTH_REQUIRED')
      return response.text()
    }))
    const ownerPrivateSentinelsInAnonymousOrAdminArtifacts = artifacts.filter(value => value.includes(privateOriginal))
    expect(ownerPrivateSentinelsInAnonymousOrAdminArtifacts).toEqual([])
    if (browser.browserType().name() !== 'chromium') {
      // This journey already proves physical offline restart and exact two-device publication
      // Reuse that account for native storage recovery instead of repeating the status journey
      await owner.evaluate(() => { location.hash = '#/settings/account' })
      // Reload preserves local access while online operations require explicit session reconnection
      await owner.getByRole('button', { name: 'Reconnect', exact: true }).click()
      await expect(owner.getByText('Online access reconnected.', { exact: true })).toBeVisible()
      await expect(status).toHaveText('Synced', { timeout: 60_000 })
      await expect(owner.getByRole('region', { name: 'Storage and recovery' })).toBeVisible()
      const updated = owner.getByRole('button', { name: 'Load updated data', exact: true })
      if (await updated.isVisible()) await updated.click()
      await expect(updated).toBeHidden()
      await assertAccountStorageRecovery(owner, testInfo)
    }
    const receipt = testInfo.outputPath('complete-workspace-drain.json')
    await writeFile(receipt, JSON.stringify({ engine: browser.browserType().name(), elapsedToDrainMs: drainedAt - started, totalMs: Date.now() - started, statuses, originalDigests: Object.keys(expected.originals), trustedBy: 'isolated context ignoreHTTPSErrors; Chromium dedicated process --ignore-certificate-errors for ServiceWorker; no OS trust changes', realWorkerStorage: true, eventBytesExcludeRequestIds: true, runtimeBefore, runtimeAfter: await (await owner.request.get('/__accounts/measurement')).json() }, null, 2))
    await testInfo.attach('complete-workspace-drain', { path: receipt, contentType: 'application/json' })
  } finally {
    // Record the owned page before cleanup; the default page fixture is unused in this multi-context journey
    // Console events survive a stalled await without another browser evaluation during failure cleanup
    try { await testInfo.attach('workspace-startup', { body: JSON.stringify(startup), contentType: 'application/json' }) }
    finally { try { await Promise.all(contexts.map(context => context.close())) } finally { await network.dispose() } }
  }
})

test('failureRecoveryPreservesUnknownsPinsAndDrafts', async ({ page }) => {
  test.setTimeout(JOURNEY_BUDGET_MS)
  const backup = await fixture(), expectedPrivateWorkspace = await privateContent(backup)
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
  await page.goto(`${app}#/builds`)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const managed = await readManagedGuestPlanner(page)
  const guestBefore = managed ? { localData: managed.localData, lineage: managed.lineage, history: managed.history } : await page.evaluate(name => new Promise<{ localData: LocalDataRecord['localData']; lineage: LocalDataRecord['lineage']; history: PersistedHistoryEntry[] }>((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, transaction = db.transaction(['localDatas', 'history'], 'readonly')
      const root = transaction.objectStore('localDatas').get('local-data-record'), history = transaction.objectStore('history').getAll()
      transaction.oncomplete = () => { db.close(); resolve({ localData: root.result.localData, lineage: root.result.lineage, history: history.result }) }
      transaction.onabort = () => { db.close(); reject(transaction.error) }
    }
  }), await selectedGuestPlannerName(page))
  await page.evaluate(() => { location.hash = '#/settings/data' })
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'complete.crykit', mimeType: 'application/octet-stream', buffer: backup })
  await expect(panel.getByText('Complete workspace preview', { exact: true })).toBeVisible()
  await panel.getByLabel('Confirm complete workspace replacement').check()
  const reopened = page.waitForEvent('load')
  await panel.getByRole('button', { name: 'Replace saved workspace', exact: true }).click()
  await reopened
  const backupRestoredWorkspace = await privateContent(await downloadBackup(page))
  expect(backupRestoredWorkspace.originals).toEqual(expectedPrivateWorkspace.originals)
  expect(backupRestoredWorkspace.metadata.editorDocuments).toEqual(expectedPrivateWorkspace.metadata.editorDocuments)
  expect(backupRestoredWorkspace.metadata.saveDocuments).toEqual(expectedPrivateWorkspace.metadata.saveDocuments)
  // Guest capture materializes exact packaged catalogs in addition to every imported snapshot
  expect(backupRestoredWorkspace.metadata.planner.catalogs).toEqual({ ...await catalogDigests(BUNDLED_CATALOGS), ...expectedPrivateWorkspace.metadata.planner.catalogs })
  const inherited = [...guestBefore.history, ...expectedPrivateWorkspace.metadata.planner.history]
  expect(backupRestoredWorkspace.metadata.planner.history.filter(entry => inherited.some(source => source.id === entry.id))).toEqual(inherited)
  const transitions = backupRestoredWorkspace.metadata.planner.history.filter(entry => !inherited.some(source => source.id === entry.id))
  expect(transitions).toHaveLength(1)
  expect(transitions[0].command).toBe('guest-restore')
  expect(transitions[0].localDataId).toBe(guestBefore.localData.id)
  expect(transitions[0].previousRevision).toBe(guestBefore.localData.revision)
  expect(transitions[0].nextRevision).toBe(backupRestoredWorkspace.metadata.planner.localData.revision)
  expect(backupRestoredWorkspace.metadata.planner.lineage).toMatchObject({ rootLocalDataId: guestBefore.lineage.rootLocalDataId, parentLocalDataId: guestBefore.localData.id, sourceLocalDataId: expectedPrivateWorkspace.metadata.planner.localData.id, sourceRevision: expectedPrivateWorkspace.metadata.planner.localData.revision })
  expect(transitions[0].before).toEqual(guestBefore.localData)
  expect(transitions[0].after).toEqual(backupRestoredWorkspace.metadata.planner.localData)
  expect(backupRestoredWorkspace.metadata.retainedContent).toEqual(expectedPrivateWorkspace.metadata.retainedContent)
  await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'corrupt.crykit', mimeType: 'application/octet-stream', buffer: backup.subarray(0, backup.length - 1) })
  await expect(panel.getByText('Backup could not be opened', { exact: true })).toBeVisible()
  expect(await privateContent(await downloadBackup(page))).toEqual(backupRestoredWorkspace)
})

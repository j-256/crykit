import { createHash } from 'node:crypto'
import { loadAccountUpdate } from './workspace-updates'
import { accountTableDigests, mergeInstallationBoundary } from './signin-qualification-storage'
import { observeMappingQualificationExceptions } from './signin-mapping-exception-probe'
import { expect, test, type Page } from './test-fixture'
import { beginSeededAccount, mountSeededAccount, finishAccountSignin, ACCOUNT_PREPARATION_TIMEOUT_MS } from './signin-helpers'
import { assertOldCompactAdmissionRefusal, captureOldSyncTerminal, OldSyncRefusal } from './catalog-writer-terminal'

const app = '/__accounts-proof/account-workspace.html'
const oldApp = '/__accounts-proof/old-account-workspace.html'
const password = 'synthetic catalog qualification password'

// These exact immutable exports belong to the retained deployed baseline, not candidate source
// Changing these paths requires a fresh binary manifest and qualification report
function alterFallback(input: number[], remove: boolean): number[] {
  const bytes = Buffer.from(input), magic = Buffer.from('CRYKIT-WORKSPACE/2\n')
  const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const word = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
  let offset = magic.length, chain = '0'.repeat(64), changed = false
  const frames: Buffer[] = [], documents = new Map<number, number>()
  while (offset < bytes.length) {
    const size = bytes.readUInt32LE(offset); offset += 4
    const header = JSON.parse(bytes.subarray(offset, offset + size).toString()); offset += size
    const length = bytes.readUInt32LE(offset); offset += 4
    const payload = Buffer.from(bytes.subarray(offset, offset + length)); offset += length
    if (header.kind === 'manifest') {
      if (!changed) throw new Error('The qualification archive lacks its fallback')
      const terminal = Buffer.from(JSON.stringify({ ...header, chain, frames: frames.length, documents: documents.size, bytes: magic.length + frames.reduce((sum, frame) => sum + frame.length, 0) }))
      return Array.from(Buffer.concat([magic, ...frames, word(terminal.length), terminal, word(0)]))
    }
    if (header.key.startsWith('catalog-body:')) {
      if (remove) { changed = true; continue }
      if (!changed) { payload[payload.length - 1] ^= 1; changed = true }
    }
    if (!documents.has(header.document)) documents.set(header.document, documents.size)
    const encoded = Buffer.from(JSON.stringify({ ...header, document: documents.get(header.document), digest: digest(payload) }))
    const frame = Buffer.concat([word(encoded.length), encoded, word(payload.length), payload])
    chain = digest(Buffer.concat([Buffer.from(chain), frame])); frames.push(frame)
  }
  throw new Error('Incomplete qualification archive')
}

async function oldAction(page: Page, action: 'prepare' | 'save' | 'sync' | 'export' | 'digests' | 'editor') {
  return page.evaluate(async action => {
    if (!(window as any).oldCatalogFetchObserved) {
      const original = window.fetch.bind(window)
      window.fetch = async (...args) => {
        const response = await original(...args)
        if (response.url.endsWith('/api/v1/sync/commits')) (window as any).oldCatalogCommitResponse = { status: response.status, body: await response.clone().json() }
        return response
      }
      ;(window as any).oldCatalogFetchObserved = true
    }
    const load = (name: string) => import(/* @vite-ignore */ `/__accounts-proof/assets/${name}`)
    const profile = await load('profile-CFNkEXtD.js'), token = profile.o()
    const { t: Database } = await load('account-database-yErrwvoT.js')
    const database = new Database(token.accountId)
    try {
      if (action === 'sync') return await (await load('pull-Dw9BPiKE.js')).u(token, profile.p(token))
      if (action === 'digests') {
        await database.open()
        return { version: database.backendDB().version, tables: Object.fromEntries(await Promise.all(database.tables.map(async (table: any) => {
          const bytes = new TextEncoder().encode(JSON.stringify(await table.toArray(), (_key, value) => value instanceof Uint8Array ? Array.from(value) : value))
          return [table.name, Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')]
        }))) }
      }
      if (action === 'save') {
        const queued = (window as any).oldCatalogQueued
        await queued.repository.save(queued.loaded.localData, queued.loaded.revision)
        return { saved: true }
      }
      const { openAccountManagedRepository } = await load('account-managed-repository-CKK6oBee.js')
      const repository = await openAccountManagedRepository(database, token, await database.profileMeta.get('active'))
      if (action === 'editor') {
        const state = await repository.readWorkspace(), file = state.editorDocuments.find((file: any) => file.id === 'editor-1')
        if (!file) throw new Error('Missing shared synthetic native document')
        const bytes = async (ref: any) => {
          if (ref.byteLength > 1024) throw new Error('Unexpected synthetic editor body size')
          const body = state.blobs.find((body: any) => body.ref.documentId === ref.documentId && body.ref.revisionId === ref.revisionId)
          if (!body) throw new Error('Missing shared synthetic original')
          const output: number[] = []
          for await (const chunk of body.content.open()) output.push(...chunk)
          return output
        }
        return { file, original: await bytes(file.original), draft: await bytes(file.unfinished.text) }
      }
      if (action === 'prepare') { (window as any).oldCatalogQueued = { repository, loaded: await repository.load(), database }; return { prepared: true } }
      const snapshot = await (await load('snapshot-DPL1MswI.js')).i(repository)
      await (await load('snapshot-DPL1MswI.js')).a(snapshot)
      return { exported: true }
    } catch (error) {
      const value = error as { code?: string; name?: string; issues?: { path: unknown; code: string }[] }
      return { failed: value.code ?? value.name ?? 'unknown', message: error instanceof Error ? error.message.slice(0, 500) : undefined, cachedCommitResponse: (window as any).oldCatalogCommitResponse, issues: value.issues?.map(issue => ({ path: issue.path, code: issue.code })) }
    } finally { if (action !== 'prepare') database.close() }
  }, action)
}
async function register(page: Page) {
  await page.goto('/__accounts-proof/')
  await page.waitForFunction(() => !!(window as any).accountAuth)
  const username = `catalog_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`
  await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json()
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find((value: { recipient: string }) => value.recipient === email).capability)
  return email
}
async function settle(page: Page, old = false) {
  const progress = new Map<string, number>()
  for (let step = 0; step < 200; step++) {
    const result = old ? await oldAction(page, 'sync') : await page.evaluate(() => (window as any).accountBootstrapProof.syncCatalogOnce())
    // The frozen service advances bounded certificate work through retriable 503 responses
    const continuation = result.cachedCommitResponse?.body?.error?.continuation
    if (result.failed === 'SERVICE_UNAVAILABLE' && continuation && continuation.processed > (progress.get(continuation.workId) ?? 0)) { progress.set(continuation.workId, continuation.processed); continue }
    if (result.failed) throw new OldSyncRefusal(result)
    if (!result.moreWork) return result
  }
  throw new Error('Synthetic publication exceeded its bounded iteration count')
}

test('fences an old same-profile save and refuses compact export after Dexie unversioned reopen', async ({ page, context, browser, accountOrigin }, testInfo) => {
  test.skip(process.env.CRYKIT_COMPACT_CATALOG_QUALIFICATION !== '1', 'Requires immutable synthetic compact writer inputs')
  test.setTimeout(180_000)
  const email = await register(page)
  await beginSeededAccount(page, app, email, password)
  await page.evaluate(() => (window as any).accountBootstrapProof.seedCompactCatalogDestination())
  // A synthetic schema bump reproduces Dexie's unversioned reopen after VersionError
  await page.evaluate(async () => {
    const entry = (await indexedDB.databases()).find(value => value.name?.startsWith('crykit-account-v1-'))!
    await new Promise<void>((resolve, reject) => { const request = indexedDB.open(entry.name!, 30); request.onsuccess = () => { request.result.close(); resolve() }; request.onerror = () => reject(request.error) })
  })
  const old = await context.newPage()
  await beginSeededAccount(old, oldApp, email, password)
  expect(await oldAction(old, 'prepare')).toEqual({ prepared: true })
  const target = await page.evaluate(() => (window as any).accountBootstrapProof.migrateCatalogFixture())
  const before = await page.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())
  const stale = await oldAction(old, 'save')
  expect(stale.failed).toBeTruthy()
  expect(await page.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())).toEqual(before)
  const exported = await oldAction(old, 'export')
  expect(exported.failed).toBeTruthy()
  const reopened = await oldAction(old, 'digests')
  expect(reopened.version).toBe(30)
  expect(await page.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())).toEqual(before)
  const evidence = await page.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence())
  expect(evidence.catalogs).toHaveLength(1)
  const archive = await page.evaluate(() => (window as any).accountBootstrapProof.compactCatalogArchive())
  await testInfo.attach('self-contained-compact-archive', { body: Buffer.from(archive), contentType: 'application/octet-stream' })
  const readerContext = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  try {
    const reader = await readerContext.newPage(), requests: string[] = []
    await reader.goto('/__accounts-proof/catalog-reader/index.html')
    await reader.waitForFunction(() => !!(window as any).catalogReader)
    expect(await reader.evaluate(() => (window as any).catalogReader.writer)).toBe(false)
    expect(await reader.evaluate(() => (window as any).catalogReader.packaged)).not.toContain(evidence.currentCatalogs[0].id)
    await readerContext.setOffline(true)
    reader.on('request', request => requests.push(request.url()))
    const restored = await reader.evaluate(bytes => (window as any).catalogReader.restore(bytes), archive)
    expect(restored.stored[0].kind).toBe('retained-catalog-reference')
    const { stored: _stored, ...restoredEvidence } = restored
    expect(restoredEvidence).toEqual(evidence)
    // Recompute valid outer framing so each negative control reaches the fallback admission boundary
    await expect(reader.evaluate(bytes => (window as any).catalogReader.restore(bytes), alterFallback(archive, true))).rejects.toThrow()
    await expect(reader.evaluate(bytes => (window as any).catalogReader.restore(bytes), alterFallback(archive, false))).rejects.toThrow()
    expect(requests).toEqual([])
    await testInfo.attach('physical-package-removal-offline-read', { body: JSON.stringify({ packaged: await reader.evaluate(() => (window as any).catalogReader.packaged), restoredEvidence, requests, missingAndCorruptFallbacksRefused: true, archiveSha256: createHash('sha256').update(Buffer.from(archive)).digest('hex') }), contentType: 'application/json' })
  } finally { await readerContext.close() }
  await testInfo.attach('frozen-local-catalog-qualification', { body: JSON.stringify({ target, stale, exported, reopened, before, allCandidateTablesUnchanged: true, scope: 'same origin and profile, actual frozen exported functions; no claim about full old UI startup' }), contentType: 'application/json' })
})

for (const boundary of ['before upload', 'before commit', 'after lost acknowledgment'] as const) test(`preserves compact evidence when old saved transport resumes ${boundary}`, async ({ page, browser, accountOrigin }, testInfo) => {
  test.skip(process.env.CRYKIT_COMPACT_CATALOG_QUALIFICATION !== '1', 'Requires immutable synthetic compact writer inputs')
  test.setTimeout(180_000)
  const lostAcknowledgment = boundary === 'after lost acknowledgment'
  const email = await register(page)
  await beginSeededAccount(page, oldApp, email, password)
  await page.evaluate(() => (window as any).accountBootstrapProof.seedSigninProgress('Synthetic old baseline'))
  await settle(page, true)
  const nextContext = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  try {
    const candidate = await nextContext.newPage()
    await beginSeededAccount(candidate, app, email, password)
    await candidate.evaluate(() => (window as any).accountBootstrapProof.initializeCatalogDevice())
    await settle(candidate)
    expect((await candidate.evaluate(() => (window as any).accountBootstrapProof.signinMergeAcceptance())).accepted).toBe(true)
    expect(await oldAction(page, 'prepare')).toEqual({ prepared: true })
    expect(await oldAction(page, 'save')).toEqual({ saved: true })
    let paused: { request: any; release: () => void; response?: any } | undefined
    let heldUpload = false, uploadsReleased = false
    let releaseUploads!: () => void
    const uploadGate = new Promise<void>(resolve => { releaseUploads = resolve })
    const requests: { path: string; method: string; status?: number; heads?: number; epoch?: number }[] = []
    await page.route('**/api/v1/sync/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      const input = path.endsWith('/commits') ? request.postDataJSON() : undefined
      if (boundary === 'before upload' && request.method() === 'POST' && !uploadsReleased) {
        // Hold the actual durable command before its first upload reaches the service
        // Candidate format publication must complete before this request is forwarded
        if (!paused) { heldUpload = path.endsWith('/uploads'); paused = { request: request.postDataJSON(), release() { uploadsReleased = true; releaseUploads() } } }
        // Parallel upload requests belong to the same held command and must share its boundary
        await uploadGate
        const response = await route.fetch()
        requests.push({ path, method: request.method(), status: response.status() })
        await route.fulfill({ response })
      } else if (input?.heads.length && !paused && lostAcknowledgment) {
        const response = await route.fetch()
        if (response.status() === 200) { paused = { request: input, release() {}, response: { status: response.status(), body: await response.json() } }; await route.abort('failed') }
        else await route.fulfill({ response })
      } else if (input?.heads.length && !paused) {
        await new Promise<void>(resolve => { paused = { request: input, release: resolve } })
        const response = await route.fetch()
        paused!.response = { status: response.status(), body: await response.json() }
        requests.push({ path, method: request.method(), status: response.status(), heads: input.heads.length, epoch: input.expectedPublicationEpoch })
        await route.fulfill({ response })
      } else if (input?.heads.length && paused && !lostAcknowledgment) {
        const response = await route.fetch()
        paused.response = { status: response.status(), body: await response.json() }
        requests.push({ path, method: request.method(), status: response.status(), heads: input.heads.length, epoch: input.expectedPublicationEpoch })
        await route.fulfill({ response })
      } else { requests.push({ path, method: request.method(), heads: input?.heads.length }); await route.continue() }
    })
    const pending = captureOldSyncTerminal(() => settle(page, true))
    await expect.poll(() => !!paused, { timeout: 60_000 }).toBe(true)
    if (boundary === 'before upload') { expect(heldUpload).toBe(true); expect(requests.filter(request => request.method === 'POST')).toEqual([]) }
    const before = await oldAction(page, 'digests')
    if (lostAcknowledgment) { await pending; await settle(candidate) }
    const beforeMigration = await candidate.evaluate(() => (window as any).accountBootstrapProof.catalogPublicationState())
    expect(beforeMigration.rows.find((row: any) => row.id === 'projection')).toBeTruthy()
    expect(beforeMigration.rows.find((row: any) => row.id === 'remote').value.projectionPending).toBe(false)
    expect(beforeMigration.outbox).toEqual([])
    await candidate.evaluate(() => (window as any).accountBootstrapProof.migrateCatalogFixture())
    try { await settle(candidate) } catch (error) {
      await testInfo.attach('candidate-migration-publication-failure', { body: JSON.stringify({ beforeMigration, afterMigration: await candidate.evaluate(() => (window as any).accountBootstrapProof.catalogPublicationState()), oldPausedRequest: paused!.request }), contentType: 'application/json' })
      paused!.release(); await pending; throw error
    }
    const published = await candidate.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence())
    expect(published.members.some((member: any) => member.format === 'compact-v2')).toBe(true)
    const accepted = await candidate.evaluate(() => (window as any).accountBootstrapProof.signinMergeAcceptance())
    expect(accepted.accepted).toBe(true)
    const publishedSelection = await candidate.evaluate(() => (window as any).accountBootstrapProof.catalogPublicationState())
    const selectedTables = await candidate.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())
    paused!.release()
    let terminal = await pending
    if (lostAcknowledgment) {
      expect(paused!.response?.status).toBe(200)
      terminal = await captureOldSyncTerminal(() => settle(page, true))
    } else expect(paused!.response).toMatchObject({ status: 409, body: { error: { code: 'HEAD_CONFLICT' } } })
    assertOldCompactAdmissionRefusal(terminal)
    const afterSelectedTables = await candidate.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())
    expect(afterSelectedTables).toEqual(selectedTables)
    const after = await candidate.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence())
    expect(after).toEqual(published)
    expect((await candidate.evaluate(() => (window as any).accountBootstrapProof.signinMergeAcceptance())).serviceEpoch).toBe(accepted.serviceEpoch)
    const restoredContext = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    try {
      const restored = await restoredContext.newPage()
      await beginSeededAccount(restored, app, email, password)
      await restored.evaluate(() => (window as any).accountBootstrapProof.initializeCatalogDevice())
      await settle(restored)
      expect((await restored.evaluate(() => (window as any).accountBootstrapProof.signinMergeAcceptance())).accepted).toBe(true)
      expect(await restored.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence())).toEqual(published)
    } finally { await restoredContext.close() }
    await testInfo.attach('frozen-saved-transport-qualification', { body: JSON.stringify({ boundary, noUploadForwardedBeforeCandidatePublication: boundary === 'before upload', before, selectedTables, afterSelectedTables, publishedSelection, finalRequest: paused!.request, finalResponse: paused!.response, requests, terminal, accepted, exactCompactEvidencePreserved: true, scope: 'independent browser profiles, actual old durable publication and transport resume' }), contentType: 'application/json' })
  } finally { await nextContext.close() }
})


test('qualifies full old startup and local operations around compact inherited evidence', async ({ page }, testInfo) => {
  test.skip(process.env.CRYKIT_COMPACT_CATALOG_QUALIFICATION !== '1' || testInfo.project.name !== 'desktop', 'Requires immutable old assets and Chromium exception observation')
  test.setTimeout(180_000)
  const email = await register(page)
  await beginSeededAccount(page, app, email, password, true)
  await page.evaluate(() => (window as any).accountBootstrapProof.seedCompactCatalogDestination())
  await beginSeededAccount(page, oldApp, email, password, true)
  const workerProbe = await observeMappingQualificationExceptions(page)
  expect(await oldAction(page, 'prepare')).toEqual({ prepared: true })
  expect(await oldAction(page, 'save')).toEqual({ saved: true })
  const supportedTransport = await settle(page, true)
  expect(supportedTransport.state).not.toBe('paused')
  await mountSeededAccount(page)
  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Account sync' })).toBeVisible()
  expect(await page.evaluate(() => !!(window as any).workspaceProof)).toBe(true)

  await beginSeededAccount(page, app, email, password, true)
  await page.evaluate(() => (window as any).accountBootstrapProof.migrateCatalogFixture())
  const before = await page.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())
  const storage = await page.evaluate(() => (window as any).accountBootstrapProof.accountStorage())
  const evidence = await page.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence())
  expect(evidence.members.some((member: any) => member.format === 'compact-v2')).toBe(true)
  const syncWrites: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/v1/sync/')) syncWrites.push(new URL(request.url()).pathname) })
  await page.goto(`${oldApp}#/settings/account`)
  const locked = page.getByRole('heading', { name: 'Account workspace locked', exact: true })
  await expect(locked.or(page.getByRole('complementary', { name: 'Account sync' }))).toBeVisible()
  await testInfo.attach('old-full-startup-observation', { body: JSON.stringify({ supportedTransport, syncWrites, storage, evidence, before, after: await accountTableDigests(page), locked: await locked.isVisible(), mounted: await page.evaluate(() => !!(window as any).workspaceProof) }), contentType: 'application/json' })
  expect(await locked.isVisible()).toBe(false)
  expect(await page.evaluate(() => !!(window as any).workspaceProof)).toBe(true)
  expect(await accountTableDigests(page)).toEqual(before)
  expect(syncWrites).toEqual([])
  const exported = await oldAction(page, 'export')
  await page.evaluate(() => (window as any).workspaceProof.queueDefinition('Synthetic old compatible projection edit'))
  const edited = await page.evaluate(() => (window as any).workspaceProof.releaseQueued())
  const afterEdit = await accountTableDigests(page)
  await testInfo.attach('old-full-local-operations', { body: JSON.stringify({ exported, edited, afterEdit }), contentType: 'application/json' })
  expect(exported).toMatchObject({ failed: 'ZodError' })
  expect(edited).toBe('saved')
  const savedBoundary = await mergeInstallationBoundary(page)
  // Retire the mounted scheduler before exercising the frozen transport directly on the same stored head
  await beginSeededAccount(page, oldApp, email, password, true)
  expect((await page.request.get('/api/v1/account')).status()).toBe(200)
  const terminal = await captureOldSyncTerminal(() => settle(page, true))
  await testInfo.attach('old-full-operation-terminal', { body: JSON.stringify({ terminal, syncWrites, workerSchemas: workerProbe.schemaFailures, probeFailures: workerProbe.failures }), contentType: 'application/json' })
  expect(terminal).toMatchObject({ kind: 'refused', failure: { failed: 'Error', message: 'Account background preparation failed' } })
  expect(workerProbe.failures).toEqual([])
  expect(syncWrites).toEqual([])
  expect(workerProbe.schemaFailures.some(error => error.worker.includes('account-local-mapping-worker') && JSON.stringify(error.issues) === JSON.stringify([{ path: ['version'], code: 'invalid_value' }, { path: [], code: 'unrecognized_keys' }]))).toBe(true)
  expect((await mergeInstallationBoundary(page)).protected).toEqual(savedBoundary.protected)
  await workerProbe.stop()
  await beginSeededAccount(page, app, email, password, true)
  const retained = await page.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence())
  expect(retained.members).toEqual(evidence.members)
  expect(retained.metadata).toEqual(evidence.metadata)
  expect(retained.native).toEqual(evidence.native)
  expect(retained.catalogs).toEqual(evidence.catalogs)
  expect((await page.evaluate(() => (window as any).accountBootstrapProof.accountStorage())).fence).toEqual((savedBoundary.protected.profileMeta as any[]).find(row => row.key === 'active'))
})


test('preserves competing edits to the same native document from old and new clients', async ({ page, browser, accountOrigin }, testInfo) => {
  test.skip(process.env.CRYKIT_COMPACT_CATALOG_QUALIFICATION !== '1', 'Requires immutable old assets and explicit candidate capability')
  test.setTimeout(180_000)
  const email = await register(page)
  await beginSeededAccount(page, oldApp, email, password)
  await page.evaluate(() => (window as any).accountBootstrapProof.seedConflictFixture())
  const initialPublication = page.waitForResponse(response => response.url().endsWith('/sync/commits') && response.ok() && response.request().postDataJSON().heads.length > 0)
  await mountSeededAccount(page)
  await initialPublication
  await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  if (await page.getByRole('button', { name: 'Load updated data', exact: true }).isVisible()) await loadAccountUpdate(page)
  const original = await oldAction(page, 'editor')
  expect(original).toMatchObject({ file: { id: 'editor-1', revision: 0 }, original: [0, 216], draft: [0, 216] })
  const otherContext = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  let release!: () => void
  try {
    const candidate = await otherContext.newPage()
    await candidate.goto(`${app}#/settings/account`)
    await candidate.getByLabel('Email', { exact: true }).fill(email)
    await candidate.getByLabel('Password', { exact: true }).fill(password)
    await candidate.getByRole('button', { name: 'Sign in', exact: true }).click()
    await finishAccountSignin(candidate)
    await expect.poll(() => candidate.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true })
    if (await candidate.getByRole('button', { name: 'Load updated data', exact: true }).isVisible()) await loadAccountUpdate(candidate)
    const starting = await candidate.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
    expect(starting.editors.find((file: any) => file.id === 'editor-1')).toEqual(original.file)
    const gate = new Promise<void>(resolve => { release = resolve })
    await candidate.route('**/api/v1/sync/**', async route => { await gate; await route.continue() })
    await candidate.evaluate(() => (window as any).workspaceProof.editConflictFile('Competing invalid draft.json', false, 0xd802))
    const oldPublication = page.waitForResponse(response => response.url().endsWith('/sync/commits') && response.ok() && response.request().postDataJSON().heads.length > 0)
    await page.evaluate(() => (window as any).workspaceProof.editConflictFile('Competing invalid draft.json', false, 0xd801))
    await oldPublication
    await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    const oldWinner = await oldAction(page, 'editor')
    expect(oldWinner).toMatchObject({ original: [0, 216], draft: [1, 216] })
    release()
    await candidate.unrouteAll({ behavior: 'wait' })
    await expect.poll(() => candidate.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true })
    if (await candidate.getByRole('button', { name: 'Load updated data', exact: true }).isVisible()) await loadAccountUpdate(candidate)
    const conflicts = await candidate.evaluate(() => (window as any).workspaceProof.conflictSnapshot())
    expect(conflicts.conflicts).toHaveLength(1)
    expect(conflicts.conflicts[0]).toMatchObject({ disposition: 'unresolved' })
    expect(conflicts.conflicts[0].versions.map((value: any) => value.draftBytes).sort()).toEqual([[1, 216], [2, 216]])
    const preserved = await candidate.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
    const conflict = preserved.conflicts.find((value: any) => value.key === '["editor","editor-1"]')
    expect(conflict.branches.every((file: any) => JSON.stringify(file.original) === JSON.stringify(original.file.original))).toBe(true)
    const thirdContext = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    try {
      const third = await thirdContext.newPage()
      await third.goto(`${app}#/settings/account`)
      await third.getByLabel('Email', { exact: true }).fill(email)
      await third.getByLabel('Password', { exact: true }).fill(password)
      await third.getByRole('button', { name: 'Sign in', exact: true }).click()
      await finishAccountSignin(third)
      await expect.poll(() => third.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true })
      expect(await third.evaluate(() => (window as any).workspaceProof.conflictSnapshot())).toEqual(conflicts)
      const downloaded = await third.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
      expect(downloaded.conflicts).toEqual(preserved.conflicts)
      for (const branch of conflict.branches) {
        const body = preserved.bodies.find((body: any) => body.ref.documentId === branch.unfinished.text.documentId && body.ref.revisionId === branch.unfinished.text.revisionId)
        expect(downloaded.bodies).toContainEqual(body)
      }
    } finally { await thirdContext.close() }
    await testInfo.attach('same-native-document-old-new', { body: JSON.stringify({ original, oldWinner, conflicts, branches: conflict.branches, independentDevicePreserved: true }), contentType: 'application/json' })
  } finally { release?.(); await otherContext.close() }
})

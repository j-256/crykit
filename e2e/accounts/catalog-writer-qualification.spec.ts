import { createHash } from 'node:crypto'
import { expect, test, type Page } from './test-fixture'
import { beginSeededAccount } from './signin-helpers'

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

async function oldAction(page: Page, action: 'prepare' | 'save' | 'sync' | 'export' | 'digests') {
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
      if (action === 'prepare') { (window as any).oldCatalogQueued = { repository, loaded: await repository.load(), database }; return { prepared: true } }
      const snapshot = await (await load('snapshot-DPL1MswI.js')).i(repository)
      await (await load('snapshot-DPL1MswI.js')).a(snapshot)
      return { exported: true }
    } catch (error) {
      const value = error as { code?: string; name?: string; issues?: { path: unknown; code: string }[] }
      return { failed: value.code ?? value.name ?? 'unknown', response: (window as any).oldCatalogCommitResponse, issues: value.issues?.map(issue => ({ path: issue.path, code: issue.code })) }
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
    const continuation = result.response?.body?.error?.continuation
    if (result.failed === 'SERVICE_UNAVAILABLE' && continuation && continuation.processed > (progress.get(continuation.workId) ?? 0)) { progress.set(continuation.workId, continuation.processed); continue }
    if (result.failed) throw new Error(`Frozen sync refusal: ${JSON.stringify(result)}`)
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

for (const lostAcknowledgment of [false, true]) test(`preserves compact evidence when old saved transport resumes ${lostAcknowledgment ? 'after lost acknowledgment' : 'before commit'}`, async ({ page, browser, accountOrigin }, testInfo) => {
  test.skip(process.env.CRYKIT_COMPACT_CATALOG_QUALIFICATION !== '1', 'Requires immutable synthetic compact writer inputs')
  test.setTimeout(180_000)
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
    const requests: { path: string; status?: number; heads?: number; epoch?: number }[] = []
    await page.route('**/api/v1/sync/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      const input = path.endsWith('/commits') ? request.postDataJSON() : undefined
      if (input?.heads.length && !paused && lostAcknowledgment) {
        const response = await route.fetch()
        if (response.status() === 200) { paused = { request: input, release() {}, response: { status: response.status(), body: await response.json() } }; await route.abort('failed') }
        else await route.fulfill({ response })
      } else if (input?.heads.length && !paused) {
        await new Promise<void>(resolve => { paused = { request: input, release: resolve } })
        const response = await route.fetch()
        paused!.response = { status: response.status(), body: await response.json() }
        requests.push({ path, status: response.status(), heads: input.heads.length, epoch: input.expectedPublicationEpoch })
        await route.fulfill({ response })
      } else if (input?.heads.length && paused && !lostAcknowledgment) {
        const response = await route.fetch()
        paused.response = { status: response.status(), body: await response.json() }
        requests.push({ path, status: response.status(), heads: input.heads.length, epoch: input.expectedPublicationEpoch })
        await route.fulfill({ response })
      } else { requests.push({ path, heads: input?.heads.length }); await route.continue() }
    })
    let terminal: unknown
    const pending = (async () => { try { terminal = await settle(page, true) } catch (error) { terminal = { failed: (error as Error).message } } })()
    await expect.poll(() => !!paused, { timeout: 60_000 }).toBe(true)
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
    await pending
    if (lostAcknowledgment) {
      expect(paused!.response?.status).toBe(200)
      try { terminal = await settle(page, true) } catch (error) { terminal = { failed: (error as Error).message } }
    } else expect(paused!.response).toMatchObject({ status: 409, body: { error: { code: 'HEAD_CONFLICT' } } })
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
    await testInfo.attach('frozen-saved-transport-qualification', { body: JSON.stringify({ before, selectedTables, afterSelectedTables, publishedSelection, finalRequest: paused!.request, finalResponse: paused!.response, requests, terminal, accepted, exactCompactEvidencePreserved: true, scope: 'independent browser profiles, actual old durable publication and transport resume' }), contentType: 'application/json' })
  } finally { await nextContext.close() }
})

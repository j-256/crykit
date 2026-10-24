import { prepareAccountProofCache } from './network-fixture'
import { expect, test } from './test-fixture'
import { createBlankLocalData } from '../../src/domain/local-data'
import { StoredPre250LocalDataSchema } from '../../src/interchange/native-schema'

// Independent synthetic cases retain the real limiter within each journey
test.beforeEach(async ({ request }) => { expect((await request.post('/__accounts/control/reset-rate-counters', { data: {} })).ok()).toBe(true) })

test('signInNeverUploadsGuestData and explicit saved-draft copy keeps guest originals', async ({ page }) => {
  test.setTimeout(120_000)
  const username = `copy_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const email = `${username}@example.org`, password = 'synthetic guest copy account password'
  await page.goto('/__accounts-proof/')
  await prepareAccountProofCache(page)
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  await page.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(row => row.recipient === email)!.capability)
  // The pre-account app initialized its planner before opening the Inspector
  // An Inspector-only database is a missing-participant recovery case, not that saved guest profile
  const { teamRevisions: _currentTeamRevisions, ...legacyPlanner } = createBlankLocalData({ now: '2026-10-13T00:00:00.000Z' })
  const planner = StoredPre250LocalDataSchema.parse({ ...legacyPlanner, schemaVersion: '2.4.0' })
  await page.evaluate(planner => new Promise<void>((resolve, reject) => {
    const NATIVE_PLANNER_VERSION = 60
    const request = indexedDB.open('crykit', NATIVE_PLANNER_VERSION)
    request.onupgradeneeded = () => {
      const schemas: Record<string, string[]> = { localDatas: ['id', 'revision', 'updatedAt'], catalogs: ['key', 'id', 'revisionId', 'checksum'], evidence: ['id', 'sourceDigest', 'group'], sources: ['id', 'digest', 'format'], history: ['id', 'localDataId', '[localDataId+nextRevision]'], imports: ['id', 'sourceDigest', 'localDataId'], meta: ['key'] }
      for (const [name, [keyPath, ...indexes]] of Object.entries(schemas)) {
        const store = request.result.createObjectStore(name, { keyPath })
        for (const index of indexes) store.createIndex(index, index === '[localDataId+nextRevision]' ? ['localDataId', 'nextRevision'] : index)
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction('localDatas', 'readwrite')
      transaction.objectStore('localDatas').put({ id: 'local-data-record', revision: planner.revision, updatedAt: planner.updatedAt, localData: planner, lineage: { rootLocalDataId: planner.id } })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }), planner)
  const original = { schemaVersion: 1, id: 'copy-browser-editor', revision: 1, filename: 'Private local draft.json', referenceId: 'synthetic-reference', createdAt: '2026-10-13', updatedAt: '2026-10-13', originalText: '{"private":"local"}', draftText: '\ud800unfinished local text' }
  await page.evaluate(row => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('crykit-mod-inspector-v1', 10)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').put(row)
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }), original)
  let uploads = 0
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/v1\/sync\//.test(request.url())) uploads++ })
  await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open account workspace', exact: true })).toBeVisible()
  expect(uploads).toBe(0)
  await page.getByRole('button', { name: 'Copy local work', exact: true }).click()
  const preview = page.getByRole('region', { name: 'Copy local work' })
  await preview.getByText('Preparing local copy...', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
  await expect(preview.getByRole('heading', { name: 'Choose local records' })).toBeVisible()
  expect(await preview.getByRole('checkbox').evaluateAll(inputs => inputs.filter(input => (input as HTMLInputElement).checked).length)).toBe(0)
  await preview.getByRole('checkbox', { name: 'Private local draft.json', exact: true }).check()
  await preview.getByText('Preparing local copy...', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
  // Legacy migration retains its complete original branch, including records outside this selection
  // Consent copies that branch as inert history without adding its planner records to the account
  await expect(preview.getByRole('button', { name: 'Copy selected work' })).toBeDisabled()
  await preview.getByRole('checkbox', { name: 'Exact inherited workspace originals (all original records, including unchecked records and samples) (Sample provenance)', exact: true }).check()
  await preview.getByText('Preparing local copy...', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
  await expect(preview.getByRole('button', { name: 'Copy selected work' })).toBeEnabled()
  await test.step('Copy selected work is durable on this device', async () => {
    await preview.getByRole('button', { name: 'Copy selected work' }).click()
    await preview.getByText('Preparing local copy...', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
    await expect(preview.getByRole('status')).toContainText('Copied to this account')
  })
  await test.step('Open the copied account workspace', async () => {
    await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Plan your next Build', exact: true })).toBeVisible()
  })
  const content = await page.evaluate(() => (window as unknown as { workspaceProof: { editorContent(): Promise<{ unfinishedText: string; validation: string }>; inspect(): Promise<{ titles: string[] }> } }).workspaceProof.editorContent())
  expect(content.unfinishedText).toBe(original.draftText)
  expect(content.validation).toBe('unchecked')
  const titles = await page.evaluate(() => (window as unknown as { workspaceProof: { inspect(): Promise<{ titles: string[] }> } }).workspaceProof.inspect())
  expect(titles.titles).toEqual([])
  const guest = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('crykit-mod-inspector-v1')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { const database = request.result, read = database.transaction('drafts').objectStore('drafts').get('copy-browser-editor'); read.onsuccess = () => { database.close(); resolve(read.result) }; read.onerror = () => reject(read.error) }
  }))
  expect(guest).toEqual(original)
  await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 60_000 })
})

import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import type { SaveWorkspaceDocument } from '../../src/workspace/documents'
import type * as auth from '../../src/account/auth-client'
import { createSaveEditorFixture } from '../../src/domain/save-editor.fixture'
import { encodeCrystalSave, decodeCrystalSave } from '../../src/interchange/crystal-save'

const password = 'synthetic binary conflict browser password'
const path = '/__accounts-proof/account-workspace.html#/settings/account'
const original = Buffer.from(encodeCrystalSave(createSaveEditorFixture()))
interface Version { role: string; file: SaveWorkspaceDocument; original: number[]; working: number[] }
interface Snapshot { files: Omit<Version, 'role'>[]; conflicts: { id: string; disposition: string; versions: Version[] }[] }
interface Proof { seedSaveConflictFixture(): Promise<void>; editSaveConflict(currency: number): Promise<void>; saveConflictSnapshot(): Promise<Snapshot>; flushSync(): void }
const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.saveConflictSnapshot())
const publication = (page: Page) => page.waitForResponse(value => value.url().endsWith('/sync/commits') && value.ok() && value.request().postDataJSON().heads.length > 0)
const status = (page: Page) => page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')
async function signIn(page: Page, email: string, seed = false) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open account workspace' })).toBeVisible()
  if (seed) await page.evaluate(() => (window as unknown as { accountBootstrapProof: Proof }).accountBootstrapProof.seedSaveConflictFixture())
  const ready = seed ? publication(page) : page.evaluate(() => new Promise<void>(resolve => window.addEventListener('crykit-account-sync-applied', () => resolve(), { once: true })))
  await page.getByRole('button', { name: 'Open account workspace' }).click()
  await ready
}
async function downloaded(page: Page, button: import('@playwright/test').Locator) {
  const event = page.waitForEvent('download')
  await button.click()
  const chunks: Buffer[] = [], stream = await (await event).createReadStream()
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
test.describe.serial('whole binary Save conflicts across browser profiles', () => {
  let a: Page, b: Page, c: Page, contexts: BrowserContext[], email: string, frozen: Snapshot['conflicts'][number]
  test.beforeAll(async ({ browser, baseURL }) => {
    contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ baseURL })))
    ;[a, b, c] = await Promise.all(contexts.map(context => context.newPage()))
    await a.goto('/__accounts-proof/'); await expect(a.locator('#status')).toHaveText('Browser worker and offline cache ready')
    const username = `binary_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`; email = `${username}@example.org`
    await a.evaluate(input => (window as unknown as { accountAuth: typeof auth }).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await a.request.post('/__accounts/jobs')
    const emails = await (await a.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
    await a.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(value => value.recipient === email)!.capability)
  })
  test.afterAll(async () => { for (const context of contexts ?? []) await context.close() })
  test('publishes exact native bytes to a second device', async () => {
    await signIn(a, email, true); await expect(status(a)).toHaveText('Synced')
    await signIn(b, email); await expect(status(b)).toHaveText('Synced')
    const state = await snapshot(b)
    expect(state.files).toHaveLength(1)
    expect(Buffer.from(state.files[0].original)).toEqual(original)
    expect(Buffer.from(state.files[0].working)).toEqual(original)
    await b.evaluate(() => { window.location.hash = '#/save-editor' })
    const files = b.getByRole('combobox', { name: 'Saved game saves', exact: true })
    await files.selectOption(state.files[0].file.id)
    await expect(b.getByLabel('Copper', { exact: true })).toHaveValue('123')
  })
  test('retains whole pending and accepted files after offline competing Apply edits', async () => {
    await contexts[1].setOffline(true)
    await b.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.editSaveConflict(222))
    const accepted = publication(a)
    await a.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.editSaveConflict(333))
    await accepted; await expect(status(a)).toHaveText('Synced')
    const conflict = publication(b)
    await contexts[1].setOffline(false)
    await b.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.flushSync())
    await conflict
    await expect(b.getByRole('heading', { name: 'Saved versions need review' })).toBeVisible()
  })
  test('third device inspects and downloads exact original and working branches without marking export', async () => {
    await signIn(c, email)
    await expect(c.getByRole('heading', { name: 'Saved versions need review' })).toBeVisible()
    const state = await snapshot(c)
    expect(state.conflicts).toHaveLength(1); frozen = state.conflicts[0]
    expect(frozen.versions.map(value => [value.role, decodeCrystalSave(new Uint8Array(value.working)).header.currencyAmount, value.file.pendingForm, value.file.exportedRevision])).toEqual([
      ['local-pending', 222, { version: 99, inertConflictChoice: 222 }, null],
      ['accepted-cloud', 333, { version: 99, inertConflictChoice: 333 }, null],
    ])
    for (const version of frozen.versions) expect(Buffer.from(version.original)).toEqual(original)
    await expect(c.getByRole('button', { name: 'Keep both configurations' })).toHaveCount(0)
    const panel = c.getByRole('region', { name: 'Saved version conflicts' })
    await panel.getByRole('button', { name: 'Inspect working file', exact: true }).nth(0).click()
    await expect(panel.getByLabel('Working file content')).toHaveText(Buffer.from(frozen.versions[0].working).toString('hex').match(/../g)!.join(' '))
    expect(await downloaded(c, panel.getByRole('button', { name: 'Download working file', exact: true }).nth(1))).toEqual(Buffer.from(frozen.versions[1].working))
    expect(await downloaded(c, panel.getByRole('button', { name: 'Download original file', exact: true }).nth(0))).toEqual(original)
    await c.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    const originalInspection = panel.getByRole('button', { name: 'Inspect original file', exact: true }).nth(0)
    await originalInspection.focus(); await originalInspection.press('Enter')
    await expect(panel.getByLabel('Original file content')).toHaveText(original.toString('hex').match(/../g)!.join(' '))
    expect((await snapshot(c)).conflicts[0]).toEqual(frozen)
  })
  test('explicit whole-file choice preserves both complete immutable branches on mobile', async ({}, testInfo) => {
    await c.setViewportSize({ width: 390, height: 844 })
    const published = publication(c)
    await c.getByRole('button', { name: 'Use pending version', exact: true }).click()
    await published; await expect(status(c)).toHaveText('Synced')
    await expect(c.getByRole('heading', { name: 'Saved version history' })).toBeVisible()
    const selected = await snapshot(c)
    expect(selected.files[0]).toEqual({ file: frozen.versions[0].file, original: frozen.versions[0].original, working: frozen.versions[0].working })
    expect(selected.conflicts[0]).toEqual({ ...frozen, disposition: 'resolved' })
    expect(await c.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await testInfo.attach('whole-save-history', { body: JSON.stringify(selected), contentType: 'application/json' })
  })
  test('account UI adds and downloads unsupported bytes without changing the saved native original', async () => {
    await c.evaluate(() => { window.location.hash = '#/save-editor' })
    const unsupported = Buffer.from([99, 0, 255, 12])
    await c.getByLabel('Open Crystal Project save', { exact: true }).setInputFiles({ name: 'future-account.sav', mimeType: 'application/octet-stream', buffer: unsupported })
    await expect(c.getByText('Read-only save', { exact: true })).toBeVisible()
    await expect(c.getByLabel('Copper', { exact: true })).toHaveCount(0)
    expect(await downloaded(c, c.getByRole('button', { name: 'Download original', exact: true }))).toEqual(unsupported)
    const files = c.getByRole('combobox', { name: 'Saved game saves', exact: true })
    await expect(files.locator('option')).toHaveCount(3)
    const state = await snapshot(c), native = state.files.find(value => value.file.filename === 'binary-conflict.sav')!
    expect(Buffer.from(native.original)).toEqual(original)
    expect(decodeCrystalSave(new Uint8Array(native.working)).header.currencyAmount).toBe(222)
    expect(state.files.find(value => value.file.filename === 'future-account.sav')!.file.exportedRevision).toBeNull()
  })

})

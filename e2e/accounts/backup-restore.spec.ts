import 'fake-indexeddb/auto'
import { readFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { readWorkspaceBackup } from '../../src/interchange/workspace-backup'
import { blobIdentity, memoryBlob, readBlob } from '../../src/workspace/blobs'
import { disposeWorkspaceSnapshot } from '../../src/workspace/snapshot'
import { readCompleteBackup } from '../workspace-backup'
import { waitForPlannerReady } from '../local-data-helpers'

const fixtures = JSON.parse(await readFile(new URL('../../src/interchange/workspace-backup-v1.fixtures.json', import.meta.url), 'utf8')) as { archive: string }[]
const backup = Buffer.from(fixtures[2].archive, 'base64')
const stagingNames = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map(database => database.name).filter((name): name is string => !!name?.startsWith('crykit-backup-staging-')).sort())

test('guest complete restore preserves saved drafts, original bytes and history after reopening', async ({ page }) => {
  test.setTimeout(60_000)
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
  await page.goto('/#/builds')
  await waitForPlannerReady(page)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  let panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  await panel.locator('.playthrough-create > summary').click()
  await panel.getByLabel('New blank Playthrough').fill('Later playthrough')
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Active Playthrough', exact: true }).locator('option:checked')).toContainText('Later playthrough')
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'damaged.crykit', mimeType: 'application/octet-stream', buffer: backup.subarray(0, 32) })
  await expect(panel.getByText('Backup could not be opened', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Active Playthrough', exact: true }).locator('option:checked')).toContainText('Later playthrough')
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'synthetic.crykit', mimeType: 'application/octet-stream', buffer: backup })
  await panel.getByText('Complete workspace preview', { exact: true }).waitFor({ state: 'visible' })
  await expect(panel.getByText('Editor documents', { exact: true })).toBeVisible()
  await expect(panel.getByText('Save documents', { exact: true })).toBeVisible()
  await expect(panel.locator('dt').filter({ hasText: /^History$/ })).toBeVisible()
  await expect.poll(() => stagingNames(page)).toHaveLength(2)
  await panel.getByRole('button', { name: 'Choose another backup', exact: true }).click()
  await expect.poll(() => stagingNames(page)).toEqual([])
  await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'synthetic.crykit', mimeType: 'application/octet-stream', buffer: backup })
  await panel.getByText('Complete workspace preview', { exact: true }).waitFor({ state: 'visible' })
  await expect(panel.getByRole('button', { name: 'Replace saved workspace', exact: true })).toBeDisabled()
  await panel.getByLabel('Confirm complete workspace replacement').check()
  const reopened = page.waitForEvent('load')
  await panel.getByRole('button', { name: 'Replace saved workspace', exact: true }).click()
  await reopened
  await waitForPlannerReady(page)
  await expect.poll(() => stagingNames(page)).toEqual([])
  panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Playthrough', exact: true })).toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Active Playthrough', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const pending = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const restoredBytes = await readFile((await (await pending).path())!)
  const state = await readCompleteBackup(restoredBytes)
  expect(state.editorDocuments[0]).toMatchObject({ filename: 'before.json', unfinished: { validation: 'invalid' } })
  expect(state.saveDocuments[0]).toMatchObject({ filename: 'save.dat', coverage: { status: 'unsupported' } })
  expect(state.planner.history.map(entry => entry.id)).toContain('history:44d0e238-52c4-4b79-ad3e-804db9afb895')
  expect(state.planner.localData.playthroughs).toEqual({})
  const restored = await readWorkspaceBackup(memoryBlob(restoredBytes).open())
  try {
    const original = restored.state.saveDocuments[0].original
    const body = restored.state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(original))
    expect(body).toBeDefined()
    expect(new TextDecoder().decode(await readBlob(body!.content, original.byteLength))).toBe('opaqueCredential password accountKey csrf inert file bytes')
  } finally { await disposeWorkspaceSnapshot(restored) }
})

test('account complete restore replaces the selected workspace and keeps exact originals', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
  const username = `restore_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
  const email = `${username}@example.org`, password = 'synthetic restore account password'
  await page.goto('/__accounts-proof/')
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  await page.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(row => row.recipient === email)!.capability)
  await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Remember this device').first().check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 60_000 })
  await page.evaluate(() => { window.location.hash = '#/settings/data' })
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(panel.getByText('selected account workspace', { exact: false })).toBeVisible()
  await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'synthetic.crykit', mimeType: 'application/octet-stream', buffer: backup })
  await expect(panel.getByText('Sign in to resume sync after reopening if prompted', { exact: false })).toBeVisible()
  await panel.getByLabel('Confirm complete workspace replacement').check()
  const reopened = page.waitForEvent('load')
  await panel.getByRole('button', { name: 'Replace saved workspace', exact: true }).click()
  await reopened
  await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Needs sign-in')
  const download = page.waitForEvent('download')
  await page.getByRole('dialog', { name: 'Data & settings', exact: true }).getByRole('button', { name: 'Export backup', exact: true }).click()
  const restored = await readWorkspaceBackup(memoryBlob(await readFile((await (await download).path())!)).open())
  try {
    expect(restored.state.editorDocuments[0].unfinished.validation).toBe('invalid')
    const original = restored.state.saveDocuments[0].original
    const body = restored.state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(original))!
    expect(new TextDecoder().decode(await readBlob(body.content, original.byteLength))).toBe('opaqueCredential password accountKey csrf inert file bytes')
  } finally { await disposeWorkspaceSnapshot(restored) }
})

test('selected guest restore refuses occupied native targets without replacing the old selection', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/__accounts-proof/account-workspace.html#/builds')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const probes = await page.evaluate(bytes => (window as unknown as { workspaceProof: { probeGuestRestoreCollisions(bytes: number[]): Promise<{ kind: string; occupancy: string; denied: boolean; error: string; selectedBefore: unknown; selectedAfter: unknown; marker: string; retainedMarker: unknown; version: number; retainedVersion: number; stores: string[] }[]> } }).workspaceProof.probeGuestRestoreCollisions(bytes), Array.from(backup))
  expect(probes.map(({ kind, occupancy }) => [kind, occupancy])).toEqual([['planner', 'same'], ['inspector', 'older'], ['files', 'future']])
  for (const probe of probes) {
    expect(probe.denied, `${probe.kind} ${probe.occupancy}: ${probe.error}`).toBe(true)
    expect(probe.selectedAfter).toEqual(probe.selectedBefore)
    expect(probe.retainedVersion).toBe(probe.version)
    expect(probe.stores).toEqual(['sentinel'])
    expect(probe.retainedMarker).toBe(probe.marker)
  }
})

test('a pre-feature guest tab writes only to the retained branch after restore', async ({ page, context }) => {
  const frozenBundle = process.env.CRYKIT_OLD_BUNDLE_DIST
  test.skip(!frozenBundle, 'Set CRYKIT_OLD_BUNDLE_DIST to a verified pre-feature dist fixture')
  test.setTimeout(120_000)
  const root = resolve(frozenBundle!)
  await context.route('**/__old/**', async route => {
    const suffix = new URL(route.request().url()).pathname.slice('/__old/'.length) || 'index.html'
    const path = resolve(root, suffix)
    if (relative(root, path).startsWith('..')) { await route.abort(); return }
    const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream'
    try { await route.fulfill({ body: await readFile(path), contentType, headers: { 'cache-control': 'no-store' } }) }
    catch { await route.fulfill({ status: 404, body: 'Missing frozen asset' }) }
  })
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
  const old = await context.newPage()
  await old.goto('/__old/#/builds')
  await expect(old.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await old.getByRole('button', { name: 'New Build', exact: true }).click()
  const title = 'Pre-feature tab saved after restore'
  await old.getByLabel('Build title').fill(title)
  await page.goto('/__accounts-proof/account-workspace.html#/builds')
  await waitForPlannerReady(page)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'synthetic.crykit', mimeType: 'application/octet-stream', buffer: backup })
  await expect(panel.getByText('Complete workspace preview', { exact: true })).toBeVisible()
  await panel.getByLabel('Confirm complete workspace replacement').check()
  const reopened = page.waitForEvent('load')
  await panel.getByRole('button', { name: 'Replace saved workspace', exact: true }).click()
  await reopened
  await waitForPlannerReady(page)
  const selectedBackup = async () => {
    if (!(await page.getByRole('dialog', { name: 'Data & settings', exact: true }).isVisible())) {
      await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
    }
    const download = page.waitForEvent('download')
    await page.getByRole('dialog', { name: 'Data & settings', exact: true }).getByRole('button', { name: 'Export backup', exact: true }).click()
    return readCompleteBackup(await readFile((await (await download).path())!))
  }
  const selected = await selectedBackup()
  expect(Object.values(selected.planner.localData.builds).map(value => value.title)).not.toContain(title)
  await old.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(old.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await page.reload()
  await waitForPlannerReady(page)
  const recoveryNotice = page.getByRole('alert', { name: 'Older local workspace needs recovery' })
  await expect(recoveryNotice.getByText('An older tab changed its saved data after this workspace opened.')).toBeVisible()
  await page.getByRole('dialog', { name: 'Data & settings', exact: true }).getByRole('button', { name: 'Close dialog' }).click()
  await recoveryNotice.getByRole('button', { name: 'Inspect retained data' }).click()
  await expect(recoveryNotice.getByText(/exact originals remain separate/)).toBeVisible()
  expect((await selectedBackup()).planner.localData).toEqual(selected.planner.localData)
  await page.getByRole('dialog', { name: 'Data & settings', exact: true }).getByRole('button', { name: 'Close dialog' }).click()
  await page.evaluate(() => {
    const state = { chunks: [] as Uint8Array[], closed: false }
    Object.assign(window, { recoveryProof: state })
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({ createWritable: async () => ({
      write: async (bytes: Uint8Array) => { state.chunks.push(bytes.slice()) }, close: async () => { state.closed = true }, abort: async () => { state.chunks = [] },
    }) }) })
  })
  const exportRecovery = recoveryNotice.getByRole('button', { name: 'Export exact recovery branch' })
  await exportRecovery.focus()
  await expect(exportRecovery).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { recoveryProof: { closed: boolean } }).recoveryProof.closed)).toBe(true)
  const exported = await page.evaluate(savedTitle => {
    const chunks = (window as unknown as { recoveryProof: { chunks: Uint8Array[] } }).recoveryProof.chunks
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const titleBytes = new Uint8Array(savedTitle.length * 2)
    for (let index = 0; index < savedTitle.length; index++) { titleBytes[index * 2] = savedTitle.charCodeAt(index) & 255; titleBytes[index * 2 + 1] = savedTitle.charCodeAt(index) >> 8 }
    return { magic: new TextDecoder().decode(bytes.subarray(0, 16)), containsTitle: bytes.some((_, at) => titleBytes.every((value, index) => bytes[at + index] === value)), bytes: bytes.length }
  }, title)
  expect(exported.magic).toBe('CRYKIT-LEGACY/1\n')
  expect(exported.containsTitle).toBe(true)
  expect(exported.bytes).toBeGreaterThan(16)
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileInspect = recoveryNotice.getByRole('button', { name: 'Inspect retained data' })
  await expect(mobileInspect).toBeInViewport()
  await mobileInspect.click()
  await expect(recoveryNotice.getByText(/exact originals remain separate/)).toBeVisible()
  await old.close()
})

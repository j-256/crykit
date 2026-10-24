import sharp from 'sharp'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { previewCrystalEdit } from '../../src/interchange/crystal-edit'
import { createPublicShareUrl } from '../../src/interchange/public-share'
import { CURRENT_CATALOG } from '../../src/catalog/bundled'
import { modModelEntity } from '../../src/domain/mod-layers'
import { SUGGESTED_BUILD_SLOTS } from '../../src/domain/build-planning'
import { PC_RULES } from '../../src/domain/calculation-rules'
import type { PublicSnapshot } from '../../src/interchange/public-share-schema'
import { skipInitialModSetup } from '../local-data-helpers'

const source = Buffer.from(JSON.stringify({ ID: 'recipient-owned-t05', Title: 'Recipient source', EditorVersion: 34, PrivateUnselected: 'SENDER_PRIVATE_CANARY_T05', Jobs: [{ ID: 0, Name: 'Recipient class', HPRating: 60, MPRating: 60, StrRating: 60, VitRating: 60, DexRating: 60, AgiRating: 60, MndRating: 60, SpiRating: 60, SpdRating: 60, LckRating: 60, EquipmentTypes: [0], PassiveIDs: [], AbilityIDs: [] }], Equipment: [{ ID: 9, Name: 'Recipient blade', Description: 'OWN_EXACT_EFFECT_T05', EquipmentType: 0, TexturePath: 'Equipment/Recipient', TextureIndex: 0, IsTwoHanded: true, StatMods: [{ Tag: Number(Object.entries(PC_RULES.statMods).find(([, rule]) => rule.name === 'Flat_MPCosts')![0]), Value1: -2, Value2: 0, Value3: 0 }] }] }))
async function snapshot(): Promise<PublicSnapshot> {
  const preview = await previewCrystalEdit(source, 'source.json'), catalog = preview.proposed.catalogs[0]!
  const job = modModelEntity(catalog, 'crystal-edit:Jobs:0')!, weapon = modModelEntity(catalog, 'crystal-edit:Equipment:9')!
  const ref = (id: string) => ({ kind: 'catalog' as const, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: id })
  const baseline = { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }
  return { version: 5, kind: 'team', title: 'Recipient Team T05', setup: { baseline, catalogLock: { [baseline.catalogId]: baseline.catalogRevisionId, [catalog.id]: catalog.revisionId }, layers: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, title: 'Recipient source' }], mode: { state: 'known', value: 'Standard' }, ppCostsNonNegative: { state: 'known', value: true }, slots: SUGGESTED_BUILD_SLOTS.map(({ id, label, equipmentRole }) => ({ id, label, equipmentRole })) }, slots: [{ primaryClass: ref(job.id), secondaryClass: null, equipment: [{ slotId: 'plan-main-hand', ref: ref(weapon.id) }, { slotId: 'plan-off-hand', ref: ref(weapon.id) }], equipmentGroups: [['plan-main-hand', 'plan-off-hand']], passives: [], calculation: { model: 'pc-1.6.9-v1', level: 30, growthMode: 'primary', gender: 'male', growth: [{ classRef: ref(job.id), levels: 30 }], bonuses: [], statuses: [] } }, null, null, null], receipts: [job, weapon].map((entity, index) => ({ ref: ref(entity.id), kind: entity.kind, name: entity.name, origin: { kind: 'catalog', projectId: catalog.id, sourceRevisionId: catalog.revisionId, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, modelKey: index ? 'crystal-edit:Equipment:9' : 'crystal-edit:Jobs:0' } })) }
}
for (const width of [1280, 390]) test(`guest recipient exact import and independent four-slot copy at ${width}px`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
  const privateRequests: string[] = []
  page.on('request', request => { if (/\/api\/v1\/sync\/(revisions|uploads)/.test(request.url())) privateRequests.push(request.url()) })
  await page.goto(createPublicShareUrl(await snapshot(), baseURL!))
  await skipInitialModSetup(page)
  await expect(page.getByRole('heading', { name: 'Recipient Team T05', exact: true })).toBeVisible()
  await expect(page.getByText('Empty slot', { exact: true })).toHaveCount(3)
  expect(await page.locator('body').textContent()).not.toContain('OWN_EXACT_EFFECT_T05')
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).toHaveCount(0)
  expect(await page.locator('body').textContent()).not.toContain('SENDER_PRIVATE_CANARY_T05')
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Independent saved copy' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Independent saved copy' })).toBeVisible()
  await page.getByRole('button', { name: 'Add matching files', exact: true }).click()
  const input = page.getByLabel('Matching JSON for Recipient source', { exact: true })
  await expect(input).toBeEnabled()
  await input.setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(source.toString().replace('OWN_EXACT_EFFECT_T05', 'WRONG_REVISION_T05')) })
  await expect(page.getByText('This file does not match the saved project and content. Choose the exact shared source version.')).toBeVisible()
  expect(await page.locator('body').textContent()).not.toContain('WRONG_REVISION_T05')
  await input.setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: source })
  await expect(page.getByRole('status').filter({ hasText: 'Matching definitions available' })).toBeVisible()
  await page.getByRole('region', { name: 'Your matching definitions' }).getByText('Recipient blade', { exact: true }).click()
  await expect(page.getByText('OWN_EXACT_EFFECT_T05', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'Read-only calculations' })).toBeVisible()
  await page.getByRole('button', { name: 'Jump to stats', exact: true }).first().click()
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Max HP', exact: true }) }).getByRole('cell').first()).toHaveText(/^[1-9][0-9,]*$/)
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Matching definitions available' })).toBeVisible()
  await test.info().attach('recipient-calculations', { body: await page.getByRole('region', { name: 'Read-only calculations' }).innerText(), contentType: 'text/plain' })
  await page.screenshot({ path: test.info().outputPath('recipient.png'), fullPage: true })
  expect(privateRequests).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

// Match the existing account mod-library/folder-import operation budget; semantic checks follow settlement
const LIBRARY_OPERATION_MS = 60_000
const proofApp = '/__accounts-proof/account-workspace.html'
type PublicProof = { publicSharingState(): Promise<{ localData: import('../../src/domain/types').LocalData; sources: string[]; defaults: unknown; assets: unknown[] }>; publishPublicFixture(snapshot: PublicSnapshot): Promise<{ shareId: string }> }
async function register(page: Page) {
  const username = `view_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`, password = 'synthetic recipient own files password'
  await page.goto('/__accounts-proof/')
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  await page.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(value => value.recipient === email)!.capability)
  await page.goto(`${proofApp}#/settings/account`)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.locator('form').filter({ has: page.getByRole('button', { name: 'Sign in', exact: true }) }).getByLabel('Remember this device', { exact: true }).check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  // Initial account projection can remount the planner; use the established account import setup boundary
  await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 90_000 })
  if (await page.getByRole('button', { name: 'Load updated data' }).isVisible()) await page.getByRole('button', { name: 'Load updated data' }).click()
}
const readProof = (page: Page) => page.evaluate(() => (window as unknown as { workspaceProof: PublicProof }).workspaceProof.publicSharingState())
test('initialized account recipient uses its own files and artwork while sender and stranger stay isolated', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000)
  test.skip(new URL(baseURL!).port === '5189', 'Captured-mail Worker owns the account journey')
  const recipientContext = await browser.newContext({ baseURL }), strangerContext = await browser.newContext({ baseURL })
  const recipient = await recipientContext.newPage(), stranger = await strangerContext.newPage()
  const folder = await mkdtemp(join(tmpdir(), 'crykit-viewer-owned-'))
  const art = await sharp({ create: { width: 240, height: 36, channels: 4, background: '#6699cc' } }).png().toBuffer()
  await mkdir(join(folder, 'mod', 'Equipment'), { recursive: true })
  await writeFile(join(folder, 'mod.json'), source)
  await writeFile(join(folder, 'mod', 'Equipment', 'Recipient.png'), art)
  try {
    // Initialize both offline fixture caches before either account starts sync
    // Concurrent fresh startup has separate retained failure evidence
    for (const profile of [page, recipient]) {
      await profile.goto('/__accounts-proof/')
      // Fixture readiness includes full offline precache; finish that setup operation before checking its status
      await profile.evaluate(async () => {
        await navigator.serviceWorker.ready
        if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
      })
      await expect(profile.locator('#status')).toHaveText('Browser worker and offline cache ready')
    }
    await register(page)
    await page.evaluate(() => { window.location.hash = '#/mods' })
    await page.getByLabel('Import mod folder').setInputFiles(folder)
    const senderPreview = page.getByRole('region', { name: 'Folder import preview' })
    await senderPreview.getByRole('radio').check()
    await senderPreview.getByRole('checkbox', { name: /Recipient.png/ }).check()
    await senderPreview.getByRole('combobox', { name: /Associate .*Recipient.png with project revision/ }).selectOption({ index: 1 })
    await senderPreview.getByRole('button', { name: 'Save selected JSON and artwork' }).click()
    await expect(senderPreview).toBeHidden({ timeout: LIBRARY_OPERATION_MS })
    await expect(page.getByText('1 matching image saved privately.')).toBeVisible()
    const beforeSender = await readProof(page), shared = await snapshot()
    const published = await page.evaluate(value => (window as unknown as { workspaceProof: PublicProof }).workspaceProof.publishPublicFixture(value), shared)
    await register(recipient)
    const beforeRecipient = await readProof(recipient)
    const publicUrl = `${baseURL}${proofApp}#/s/${published.shareId}`
    await recipient.goto(publicUrl)
    await expect(recipient.getByRole('heading', { name: shared.title, exact: true })).toBeVisible()
    await expect(recipient.getByText('Calculations unavailable', { exact: true })).toBeVisible()
    await expect(recipient.locator('[data-artwork-source="private"]')).toHaveCount(0)
    await recipient.getByRole('button', { name: 'Save a copy', exact: true }).click()
    await expect(recipient.getByRole('status').filter({ hasText: 'Independent saved copy' })).toBeVisible()
    const copiedUrl = recipient.url()
    await recipient.getByRole('button', { name: 'Choose from my library', exact: true }).click()
    const matchingInput = recipient.getByLabel('Matching JSON for Recipient source', { exact: true })
    await expect(matchingInput).toBeEnabled({ timeout: LIBRARY_OPERATION_MS })
    const importStarted = Date.now()
    await matchingInput.setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: source })
    const savingSource = recipient.getByRole('status').filter({ hasText: 'Saving matching source...' })
    await expect(savingSource).toBeVisible()
    await expect(matchingInput).toBeDisabled()
    await expect(savingSource).toBeHidden({ timeout: LIBRARY_OPERATION_MS })
    await expect(matchingInput).toBeEnabled()
    console.info('recipient-source-import', { elapsedMilliseconds: Date.now() - importStarted })
    await expect(recipient.getByRole('status').filter({ hasText: 'Matching definitions available' })).toBeVisible()
    await recipient.evaluate(() => { window.location.hash = '#/mods' })
    await recipient.getByLabel('Import mod folder').setInputFiles(folder)
    const preview = recipient.getByRole('region', { name: 'Folder import preview' })
    await preview.getByRole('radio').check()
    await preview.getByRole('checkbox', { name: /Recipient.png/ }).check()
    await preview.getByRole('combobox', { name: /Associate .*Recipient.png with project revision/ }).selectOption({ index: 1 })
    await preview.getByRole('button', { name: 'Save selected JSON and artwork' }).click()
    await expect(preview).toBeHidden({ timeout: LIBRARY_OPERATION_MS })
    await expect(recipient.getByText('1 matching image saved privately.')).toBeVisible()
    await recipient.goto(copiedUrl)
    await recipient.getByRole('region', { name: 'Your matching definitions' }).getByText('Recipient blade', { exact: true }).click()
    const image = recipient.getByRole('img', { name: 'Recipient blade private artwork', exact: true }).first()
    // Private artwork opens through the same asynchronous account boundary as the folder-import journey
    await expect(image).toBeVisible({ timeout: LIBRARY_OPERATION_MS })
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(240)
    await expect(recipient.getByRole('table', { name: 'Calculated character stats', exact: true }).getByRole('row').filter({ has: recipient.getByRole('rowheader', { name: 'Max HP', exact: true }) }).getByRole('cell').first()).toHaveText(/^[1-9][0-9,]*$/)
    const afterRecipient = await readProof(recipient)
    expect(afterRecipient.localData.playthroughs).toEqual(beforeRecipient.localData.playthroughs)
    expect(afterRecipient.defaults).toEqual(beforeRecipient.defaults)
    expect(afterRecipient.assets).toHaveLength(1)
    expect(afterRecipient.sources).toHaveLength(1)
    expect(await readProof(page)).toEqual(beforeSender)
    const requests: string[] = [], publicLogs: string[] = []
    stranger.on('console', message => publicLogs.push(message.text()))
    stranger.on('request', request => { if (/\/api\/v1\/sync\//.test(request.url())) requests.push(request.url()) })
    await stranger.goto(`${baseURL}/#/s/${published.shareId}`)
    await skipInitialModSetup(stranger)
    await expect(stranger.getByRole('heading', { name: shared.title, exact: true })).toBeVisible()
    await expect(stranger.getByText('Calculations unavailable', { exact: true })).toBeVisible()
    await expect(stranger.locator('[data-artwork-source="private"]')).toHaveCount(0)
    expect(await stranger.locator('body').textContent()).not.toContain('OWN_EXACT_EFFECT_T05')
    expect(requests).toEqual([])
    const response = await stranger.request.get(`/api/public/v1/shares/${published.shareId}`)
    expect((await response.json()).snapshot).toEqual(shared)
    for (const cachePage of [page, recipient]) {
      const cached = await cachePage.evaluate(async () => {
        const bodies: string[] = []
        for (const key of await caches.keys()) { const cache = await caches.open(key); for (const request of await cache.keys()) { const response = await cache.match(request); if (response) bodies.push(request.url, await response.text()) } }
        return bodies.join('\n')
      })
      expect(cached.length).toBeGreaterThan(0)
      expect(cached).not.toContain('SENDER_PRIVATE_CANARY_T05')
      expect(cached).not.toContain('OWN_EXACT_EFFECT_T05')
    }
    expect(publicLogs.join('\n')).not.toContain('SENDER_PRIVATE_CANARY_T05')
    expect(publicLogs.join('\n')).not.toContain('OWN_EXACT_EFFECT_T05')
    await recipient.goto(publicUrl)
    await recipient.getByRole('button', { name: 'Choose from my library', exact: true }).click()
    await expect(recipient.getByLabel('Matching JSON for Recipient source', { exact: true })).toBeEnabled({ timeout: LIBRARY_OPERATION_MS })
    await expect(recipient.getByRole('status').filter({ hasText: 'Matching definitions available' })).toBeVisible()
    await recipient.setViewportSize({ width: 390, height: 900 })
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await recipient.screenshot({ path: test.info().outputPath('account-recipient-mobile.png'), fullPage: true })
  } finally { await recipientContext.close(); await strangerContext.close(); await rm(folder, { recursive: true, force: true }) }
})

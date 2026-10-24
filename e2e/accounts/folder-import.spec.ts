import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'

const source = (version: string) => Buffer.from(JSON.stringify({ ID: 'synthetic-folder-project', Title: 'Synthetic folder mod', Version: version, EditorVersion: 34, Items: [{ ID: 9, Name: `Synthetic item ${version}` }] }))

test('folder preview requires a revision choice and cancellation keeps the library unchanged', async ({ page }) => {
  test.setTimeout(120_000)
  const folder = await mkdtemp(join(tmpdir(), 'crykit-folder-preview-'))
  try {
    await writeFile(join(folder, 'first.json'), source('1'))
    await writeFile(join(folder, 'second.json'), source('2'))
    await writeFile(join(folder, 'private.txt'), 'Synthetic unrelated notes')
    await page.goto('/__accounts-proof/account-workspace.html#/mods')
    await expect(page.getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
    await page.getByLabel('Import mod folder').setInputFiles(folder)
    const preview = page.getByRole('region', { name: 'Folder import preview' })
    await expect(preview).toBeVisible()
    await expect(preview.getByRole('radio')).toHaveCount(2)
    await expect(preview.getByRole('button', { name: 'Save selected JSON' })).toBeDisabled()
    await preview.getByText('Excluded files (1)').click()
    await expect(preview.getByText(/private.txt: Not a supported/)).toBeVisible()
    await preview.getByRole('button', { name: 'Cancel folder import' }).click()
    await expect(preview).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Synthetic folder mod' })).toHaveCount(0)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('mobile multi-file fallback requires reconfirmation after unmatched artwork', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/__accounts-proof/account-workspace.html#/mods')
  await expect(page.getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
  const image = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#99ccff' } }).png().toBuffer()
  await page.getByLabel('Import mod files').setInputFiles([
    { name: 'folder-project.json', mimeType: 'application/json', buffer: source('3') },
    { name: 'icon.png', mimeType: 'image/png', buffer: image },
  ])
  const preview = page.getByRole('region', { name: 'Folder import preview' })
  await expect(preview).toContainText('Synthetic folder mod')
  await expect(preview).toContainText('icon.png')
  await expect(preview.getByRole('radio')).not.toBeChecked()
  await preview.getByRole('radio').check()
  await preview.getByRole('checkbox', { name: /icon.png/ }).check()
  await expect(preview.getByRole('button', { name: 'Save selected JSON and artwork' })).toBeDisabled()
  await preview.getByRole('combobox', { name: 'Associate icon.png with project revision' }).selectOption({ index: 1 })
  await preview.getByRole('button', { name: 'Save selected JSON and artwork' }).click()
  await expect(page.getByText(/Selected artwork could not be saved: icon.png/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Synthetic folder mod' })).toHaveCount(0)
  await preview.getByRole('checkbox', { name: /icon.png/ }).uncheck()
  await preview.getByRole('button', { name: 'Save selected JSON' }).click()
  await expect(page.getByRole('region', { name: 'Synthetic folder mod' })).toBeVisible({ timeout: 60_000 })
  await expect(preview).toHaveCount(0)
})

test('exact private artwork reaches a second account device as original image bytes', async ({ browser, baseURL, page }) => {
  test.setTimeout(240_000)
  const username = `art_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
  const email = `${username}@example.org`
  const password = 'synthetic account artwork browser password'
  const original = await sharp({ create: { width: 240, height: 36, channels: 4, background: '#6699cc' } }).png().toBuffer()
  const json = Buffer.from(JSON.stringify({ ID: 'browser-art-project', Title: 'Browser artwork mod', EditorVersion: 34, Equipment: [{ ID: 9, Name: 'Browser art item', TexturePath: 'Equipment/Test', TextureIndex: 0 }] }))
  const folder = await mkdtemp(join(tmpdir(), 'crykit-companion-art-'))
  await mkdir(join(folder, 'mod', 'Equipment'), { recursive: true })
  await writeFile(join(folder, 'mod.json'), json)
  await writeFile(join(folder, 'mod', 'Equipment', 'Test.png'), original)
  try {
    await page.goto('/__accounts-proof/')
    await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
    await page.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await page.request.post('/__accounts/jobs')
    const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
    await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(message => message.recipient === email)!.capability)
    await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.locator('form').filter({ has: page.getByRole('button', { name: 'Sign in', exact: true }) }).getByLabel('Remember this device', { exact: true }).check()
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 90_000 })
    if (await page.getByRole('button', { name: 'Load updated data' }).isVisible()) await page.getByRole('button', { name: 'Load updated data' }).click()
    await page.evaluate(() => { window.location.hash = '#/mods' })
    await expect(page.getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
    await page.getByLabel('Import mod folder').setInputFiles(folder)
    const preview = page.getByRole('region', { name: 'Folder import preview' })
    await preview.getByRole('radio').check()
    await preview.getByLabel('Add this mod to Reference').check()
    await preview.getByRole('checkbox', { name: /Test.png/ }).check()
    await preview.getByRole('combobox', { name: /Associate .*Test.png with project revision/ }).selectOption({ index: 1 })
    const publication = page.waitForResponse(response => response.url().endsWith('/sync/commits') && response.ok() && response.request().postDataJSON().heads.length > 0, { timeout: 90_000 })
    await preview.getByRole('button', { name: 'Save selected JSON and artwork' }).click()
    await expect(page.getByRole('region', { name: 'Browser artwork mod' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('1 matching image saved privately.')).toBeVisible()
    await publication
    await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 90_000 })
    const secondContext = await browser.newContext({ baseURL })
    try {
      const second = await secondContext.newPage()
      await second.goto('/__accounts-proof/account-workspace.html#/settings/account')
      await second.getByLabel('Email', { exact: true }).fill(email)
      await second.getByLabel('Password', { exact: true }).fill(password)
      await second.locator('form').filter({ has: second.getByRole('button', { name: 'Sign in', exact: true }) }).getByLabel('Remember this device', { exact: true }).check()
      await second.getByRole('button', { name: 'Sign in', exact: true }).click()
      await second.getByRole('button', { name: 'Open account workspace', exact: true }).click()
      await expect(second.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 90_000 })
      await expect(second.getByText('Updated data is ready')).toBeVisible()
      await second.getByRole('button', { name: 'Load updated data' }).click()
      await second.evaluate(() => { window.location.hash = '#/reference?v=1&q=Browser+art+item' })
      const image = second.locator('[data-artwork-source="private"] img').first()
      await expect(image).toBeVisible({ timeout: 60_000 })
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: 60_000 }).toBeGreaterThan(0)
      const artwork = await second.evaluate(() => (window as unknown as { workspaceProof: { artworkContent(): Promise<{ id: string; bytes: number[] }[]> } }).workspaceProof.artworkContent())
      expect(artwork).toHaveLength(1)
      expect(Buffer.from(artwork[0]!.bytes)).toEqual(original)
    } finally { await secondContext.close() }
  } finally { await rm(folder, { recursive: true, force: true }) }
})

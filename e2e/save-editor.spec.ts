import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { decodeCrystalSave, encodeCrystalSave, type CrystalSave } from '../src/interchange/crystal-save'
import { createSaveEditorFixture } from '../src/domain/save-editor.fixture'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectOfflineReady } from './offline-helpers'

const ROUTE = '/#/save-editor'
const FILENAME = 'synthetic-party.sav'

async function openSave(page: Page, save = createSaveEditorFixture()) {
  const bytes = Buffer.from(encodeCrystalSave(save))
  await page.getByLabel('Open Crystal Project save', { exact: true }).setInputFiles({ name: FILENAME, mimeType: 'application/octet-stream', buffer: bytes })
  await expect(page.getByRole('heading', { name: FILENAME, exact: true })).toBeVisible()
  return bytes
}

async function downloadSave(page: Page, name: string) {
  const event = page.waitForEvent('download')
  await page.getByRole('button', { name, exact: true }).first().click()
  const download = await event
  return { bytes: await readFile((await download.path())!), filename: download.suggestedFilename() }
}

function expectPreserved(original: CrystalSave, edited: CrystalSave) {
  expect(edited.combatBytes).toEqual(original.combatBytes)
  expect(edited.maps).toEqual(original.maps)
  expect(edited.header.playTime).toEqual(original.header.playTime)
  expect(edited.header.homePointName).toBe(original.header.homePointName)
}

for (const version of [3, 12, 27]) test(`edits legacy format ${version} and exports its original layout`, { tag: version === 3 ? MOBILE_TEST_TAG : [] }, async ({ page }) => {
  await page.goto(ROUTE)
  const fixture = createSaveEditorFixture(version)
  fixture.header.invertedVersion = version === 3
  const original = decodeCrystalSave(await openSave(page, fixture))
  await expect(page.getByText('Not stored in this format', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Review overpowered preset', exact: true }).click()
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click()
  const output = (await downloadSave(page, 'Export edited save')).bytes
  const edited = decodeCrystalSave(output)
  expect(edited.header.version).toBe(version)
  expect(edited.header.lastUpdated).toBeNull()
  expect(edited.header.members[0]!.level).toBe(99)
  expect(output[0]).toBe(version === 3 ? 252 : version)
  expectPreserved(original, edited)
})

test('opens, edits, and downloads a separate save with exact original recovery', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Save editor', exact: true }).filter({ visible: true }).click()
  await expect(page.getByRole('heading', { name: 'Save editor', exact: true })).toBeVisible()
  const originalBytes = await openSave(page)
  const original = decodeCrystalSave(originalBytes)
  expect((await downloadSave(page, 'Download original')).bytes).toEqual(originalBytes)
  expect((await downloadSave(page, 'Export edited save')).bytes).toEqual(originalBytes)

  await page.getByLabel('Copper', { exact: true }).fill('123456')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  await page.getByLabel('Member 1 name', { exact: true }).fill('Synthetic Hero')
  await page.getByRole('button', { name: 'Apply member 1', exact: true }).click()
  await page.getByLabel('Search inventory', { exact: true }).fill('Potion')
  await page.getByLabel('Potion stock', { exact: true }).fill('7')
  await page.getByRole('button', { name: 'Apply Potion stock', exact: true }).click()
  await expect(page.getByText('Changes not exported', { exact: true })).toBeVisible()

  const download = await downloadSave(page, 'Export edited save')
  expect(download.filename).toBe('synthetic-party-edited.sav')
  const edited = decodeCrystalSave(download.bytes)
  expect(edited.header.currencyAmount).toBe(123456)
  expect(edited.header.members[0]!.name).toBe('Synthetic Hero')
  expect(edited.members[0]!.value.Name).toMatchObject({ type: 'string', value: 'Synthetic Hero' })
  expect(edited.party.value.Currency).toMatchObject({ type: 'document', value: { Val: { value: 123456 } } })
  expect(edited.party.value.Items).toMatchObject({ type: 'document', value: { Stock: { type: 'array', value: expect.arrayContaining([expect.objectContaining({ type: 'document', value: expect.objectContaining({ Item: expect.objectContaining({ value: 0 }), Count: expect.objectContaining({ value: 7 }) }) })]) } } })
  expectPreserved(original, edited)
  expect((await downloadSave(page, 'Download original')).bytes).toEqual(originalBytes)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(errors).toEqual([])
})

test('reviews the overpowered preset before applying and preserves equipped loadouts', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(ROUTE)
  const original = decodeCrystalSave(await openSave(page))
  await page.getByRole('button', { name: 'Review overpowered preset', exact: true }).click()
  const review = page.getByRole('region', { name: 'Review bulk changes', exact: true })
  await expect(review).toContainText('99')
  await expect(page.getByLabel('Copper', { exact: true })).toHaveValue('123')
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click()
  await expect(page.getByLabel('Member 1 level', { exact: true })).toHaveValue('5')
  await page.getByRole('button', { name: 'Review overpowered preset', exact: true }).click()
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click()
  const edited = decodeCrystalSave((await downloadSave(page, 'Export edited save')).bytes)
  expect(edited.header.currencyAmount).toBe(999999999)
  expect(edited.header.assistFlags & 128).toBe(128)
  for (let index = 0; index < edited.members.length; index++) {
    expect(edited.header.members[index]!.level).toBe(99)
    expect(edited.members[index]!.value.Equipment).toEqual(original.members[index]!.value.Equipment)
    expect(edited.members[index]!.value.Passives).toEqual(original.members[index]!.value.Passives)
  }
  expectPreserved(original, edited)
})

test('retains pending input and the loaded save after rejected edits or malformed replacement', async ({ page }) => {
  await page.goto(ROUTE)
  const originalBytes = await openSave(page)
  await page.getByLabel('Copper', { exact: true }).fill('12.5')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  await expect(page.getByText(/Copper must be a whole number/)).toBeVisible()
  await expect(page.getByLabel('Copper', { exact: true })).toHaveValue('12.5')
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  await expect(page.getByText('Unsaved edits are still open', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Export and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Save editor', exact: true })).toBeVisible()
  await expect(page.getByText(/Apply or discard pending input before exporting/)).toBeVisible()
  await page.getByRole('button', { name: 'Discard pending input', exact: true }).click()
  await page.getByLabel('Open Crystal Project save', { exact: true }).setInputFiles({ name: 'broken.sav', mimeType: 'application/octet-stream', buffer: Buffer.from([28, 0, 0, 0]) })
  await expect(page.getByText(/The open draft has not changed/)).toBeVisible()
  expect((await downloadSave(page, 'Download original')).bytes).toEqual(originalBytes)
  await page.getByLabel('Copper', { exact: true }).fill('500')
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
})

test('exports a valid draft before continuing away from the editor', async ({ page }) => {
  await page.goto(ROUTE)
  await openSave(page)
  await page.getByLabel('Copper', { exact: true }).fill('456')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  const download = await downloadSave(page, 'Export and continue')
  expect(decodeCrystalSave(download.bytes).header.currencyAmount).toBe(456)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
})

test('keeps modded saves read-only with the exact original download', async ({ page }) => {
  await page.goto(ROUTE)
  const modded = createSaveEditorFixture()
  modded.header.isModded = true
  const bytes = await openSave(page, modded)
  await expect(page.getByText('Read-only save', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export edited save', exact: true }).first()).toBeDisabled()
  expect((await downloadSave(page, 'Download original')).bytes).toEqual(bytes)
})

test('edits and exports offline without persisting the opened game save', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  await page.goto(ROUTE)
  await openSave(page)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.goto(ROUTE)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Choose a save file', exact: true })).toBeVisible()
  await openSave(page)
  await page.getByLabel('Copper', { exact: true }).fill('789')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  const downloaded = await downloadSave(page, 'Export edited save')
  expect(decodeCrystalSave(downloaded.bytes).header.currencyAmount).toBe(789)
})

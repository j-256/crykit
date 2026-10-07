import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import type { LocalData } from '../src/domain/types'
import { createSaveEditorFixture } from '../src/domain/save-editor.fixture'
import { decodeCrystalSave, encodeCrystalSave } from '../src/interchange/crystal-save'
import { createBlankPlaythrough, selectedPlaythrough, skipInitialModSetup } from './local-data-helpers'
import { MOBILE_TEST_TAG } from './test-tags'

test('base-game onboarding and mobile navigation reach the primary planning controls', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  await page.goto('/')
  const onboarding = page.getByRole('dialog', { name: 'Choose your mods', exact: true })
  await expect(onboarding).toBeVisible()
  await expect(onboarding.getByRole('searchbox', { name: 'Search mods', exact: true })).not.toBeVisible()
  await onboarding.getByRole('button', { name: 'Choose mods', exact: true }).press('Enter')
  await expect(onboarding.getByRole('searchbox', { name: 'Search mods', exact: true })).toBeFocused()
  await onboarding.getByRole('button', { name: 'Choose mods', exact: true }).click()
  await onboarding.getByRole('button', { name: 'Continue without mods', exact: true }).click()
  await expect(onboarding).not.toBeVisible()
  if (isMobile) {
    const more = page.getByRole('button', { name: 'More destinations', exact: true })
    await more.click()
    const menu = page.getByRole('dialog', { name: 'Navigate CryKit', exact: true })
    await menu.getByRole('button', { name: 'Inventory', exact: true }).click()
    await expect(menu).not.toBeVisible()
    await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
    await more.click()
    await menu.getByRole('button', { name: 'Builds', exact: true }).click()
  }
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  const classPicker = page.getByRole('combobox', { name: 'Class', exact: true })
  await expect(classPicker).toBeVisible()
  if (isMobile) {
    const pickerBounds = await classPicker.boundingBox()
    const navigationBounds = await page.locator('.bottom-nav').boundingBox()
    expect(pickerBounds).not.toBeNull()
    expect(navigationBounds).not.toBeNull()
    expect(pickerBounds!.y + pickerBounds!.height).toBeLessThan(navigationBounds!.y)
  }
})

test('failed saves expose diagnostics on demand and export the retained transaction directly', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await page.goto('/#/inventory')
  await createBlankPlaythrough(page)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(...args: Parameters<typeof put>) {
      if (this.name === 'localDatas') throw new DOMException('Synthetic recovery test', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
  await form.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await form.getByRole('textbox', { name: 'Item name', exact: true }).fill('Synthetic direct recovery item')
  await form.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(page.getByText('Local save failed', { exact: true })).toBeAttached()
  await expect(form.getByRole('textbox', { name: 'Item name', exact: true })).toHaveValue('Synthetic direct recovery item')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  const alert = page.locator('.global-save-alert')
  const diagnostics = alert.locator('.error-details')
  await expect(diagnostics.locator('code')).not.toBeVisible()
  await diagnostics.locator('summary').click()
  await expect(diagnostics.locator('code')).toContainText(/Error code storage-failure; diagnostic [\w-]+/)
  const download = page.waitForEvent('download')
  await alert.getByRole('button', { name: 'Export recovery backup', exact: true }).click()
  const file = await download
  const path = await file.path()
  if (!path) throw new Error('The recovery backup did not finish downloading')
  const entries = unzipSync(await readFile(path))
  const backup = JSON.parse(strFromU8(entries['bundle.json']!)) as { localData: LocalData }
  expect(Object.values(selectedPlaythrough(backup.localData).inventory)).toEqual([expect.objectContaining({ observedName: 'Synthetic direct recovery item', possession: 'unknown', quantity: { kind: 'unknown' } })])
  await expect(alert.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.getByText('Synthetic direct recovery item', { exact: true })).not.toBeVisible()
})

test('backup help remains reachable in the dialog keyboard cycle', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await page.goto('/#/inventory')
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Export backup', exact: true }).focus()
  await page.keyboard.press('Tab')
  const help = panel.getByText("What's included in a backup?", { exact: true })
  await expect(help).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(panel.getByText("Download Mod Inspector files and edited game saves separately.", { exact: false })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(help).toBeFocused()
})

test('blocked navigation reveals recovery choices and retains deep editor fields', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await page.getByRole('button', { name: 'Save Editor', exact: true }).filter({ visible: true }).click()
  await page.getByLabel('Open Crystal Project save', { exact: true }).setInputFiles({ name: 'synthetic-navigation.sav', mimeType: 'application/octet-stream', buffer: Buffer.from(encodeCrystalSave(createSaveEditorFixture())) })
  const copper = page.getByLabel('Copper', { exact: true })
  const warning = page.getByRole('region', { name: 'Resolve unsaved edits', exact: true })
  for (const value of ['456', '789']) {
    await copper.fill(value)
    if (isMobile) {
      await page.getByRole('button', { name: 'More destinations', exact: true }).click()
      await page.getByRole('dialog', { name: 'Navigate CryKit', exact: true }).getByRole('button', { name: 'Inventory', exact: true }).click()
    } else await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Inventory', exact: true }).click()
    await expect(copper).toHaveValue(value)
    await expect(warning).toBeFocused()
    const bounds = await warning.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThan(page.viewportSize()!.height)
    await expect(warning.getByRole('button', { name: 'Export and continue', exact: true })).toBeVisible()
  }
  await warning.getByRole('button', { name: 'Export and continue', exact: true }).click()
  await expect(page.getByText('Apply or discard pending fields and loadout choices before exporting. Unreviewed input has not been included in the draft.', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Save Editor', exact: true })).toBeVisible()
  await expect(copper).toHaveValue('789')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  if (isMobile) {
    await page.getByRole('button', { name: 'More destinations', exact: true }).click()
    await page.getByRole('dialog', { name: 'Navigate CryKit', exact: true }).getByRole('button', { name: 'Inventory', exact: true }).click()
  } else await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Inventory', exact: true }).click()
  await expect(warning).toBeFocused()
  const downloading = page.waitForEvent('download')
  await warning.getByRole('button', { name: 'Export and continue', exact: true }).click()
  const download = await downloading
  const path = await download.path()
  if (!path) throw new Error('The retained editor changes did not finish downloading')
  expect(decodeCrystalSave(await readFile(path)).header.currencyAmount).toBe(789)
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
})

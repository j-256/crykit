import { openBuildPickerFilters } from './build-picker-helpers'
import { expect, test, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectOfflineReady } from './offline-helpers'

async function storedData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction('localDatas', 'readonly').objectStore('localDatas').getAll()
      read.onerror = () => { database.close(); reject(read.error) }
      read.onsuccess = () => { database.close(); resolve(read.result[0].localData) }
    }
  }))
}

async function choose(page: Page, label: string, name: string, options: { includeUnavailable?: boolean } = {}) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('combobox', { name: label, exact: true }).fill(name)
  const results = page.getByRole('listbox', { name: `Choose ${label}`, exact: true })
  if (options.includeUnavailable) {
    const includeUnavailable = results.getByRole('checkbox', { name: 'Include disabled or unconfirmed mods', exact: true })
    await openBuildPickerFilters(page)
    if (!await includeUnavailable.isVisible()) await results.getByText('Broader planning options', { exact: true }).click()
    await includeUnavailable.check()
  }
  await results.getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click()
}

async function promptFreelancer(page: Page) {
  await choose(page, 'Class', 'Freelancer', { includeUnavailable: true })
  const dialog = page.getByRole('dialog', { name: 'Enable Moonlight Project?', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Freelancer requires Moonlight Project')
  await expect(dialog.getByRole('button', { name: 'Enable and select Freelancer', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: /^(Save build|Save new revision)$/ })).toBeDisabled()
  return dialog
}

test('mod confirmation cancels without selecting, saving, or leaving the picker open', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library/new')
  const field = page.getByRole('combobox', { name: 'Class', exact: true })
  await expect(field).toBeVisible()
  await expect(page.locator('.build-behavior')).not.toHaveAttribute('open')
  await expect(page.getByText('Stats unavailable', { exact: true })).toHaveCount(0)
  const before = await storedData(page)
  for (const dismissal of ['Cancel', 'Escape', 'Close dialog']) {
    const dialog = await promptFreelancer(page)
    await expect(field).toHaveValue('')
    if (dismissal === 'Escape') await page.keyboard.press('Escape')
    else await dialog.getByRole('button', { name: dismissal, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(field).toHaveValue('')
    await expect(field).toBeFocused()
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0)
    expect(await storedData(page)).toEqual(before)
  }
  await choose(page, 'Class', 'Warrior')
  await field.fill('Freelancer')
  await field.press('ArrowDown')
  await field.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Enable Moonlight Project?', exact: true })
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue('Warrior')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(field).toHaveValue('Warrior')
  await expect(field).toBeFocused()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  expect(await storedData(page)).toEqual(before)
})

test('confirming Freelancer enables the exact legacy source and preserves earlier plans offline', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/#/settings/storage')
  const storage = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await storage.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(storage)
  await storage.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Rowan: sample Warrior', exact: true }).click()
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === 'Rowan: sample Warrior')!
  const dialog = await promptFreelancer(page)
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
  await expect(dialog).toContainText('Version 2.2')
  await expect(dialog.getByRole('combobox', { name: 'Mod version', exact: true })).not.toBeVisible()
  await dialog.getByText('Version details', { exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: 'Mod version', exact: true }).locator('option:checked')).toContainText('format 27')
  await dialog.getByRole('button', { name: 'Enable and select Freelancer', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const totals = page.getByRole('table', { name: 'Calculated character stats', exact: true })
  await expect(totals).toBeVisible()
  await expect(totals).not.toContainText('Unknown')
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Freelancer')
  await expect(page.locator('.build-behavior')).not.toHaveAttribute('open')
  expect((await storedData(page)).buildRevisions).toEqual(before.buildRevisions)
  expect((await storedData(page)).gameSetups).toEqual(before.gameSetups)
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByRole('combobox', { name: /^Editor checkpoint/ }).locator('option:checked')).toContainText('r2')
  const after = await storedData(page)
  const saved = after.buildRevisions[after.builds[build.id]!.latestRevisionId!]!
  const setup = after.gameSetups[saved.gameSetupRevisionId]!
  expect(setup.modComposition!.layers).toHaveLength(1)
  expect(setup.modComposition!.layers[0]!.enabled).toBe(true)
  expect(saved.content.primaryClass?.kind === 'catalog' && saved.content.primaryClass.catalogRevisionId).toBe(setup.catalogLock[saved.content.primaryClass!.kind === 'catalog' ? saved.content.primaryClass!.catalogId : ''])
  expect(after.playthroughs).toEqual(before.playthroughs)
  for (const [id, revision] of Object.entries(before.buildRevisions)) expect(after.buildRevisions[id]).toEqual(revision)
  for (const [id, revision] of Object.entries(before.gameSetups)) expect(after.gameSetups[id]).toEqual(revision)
  await page.reload()
  await expect(totals).toBeVisible()
  await expect(totals).not.toContainText('Unknown')
  await page.getByRole('button', { name: 'Freelancer mod settings', exact: true }).click()
  const card = page.getByRole('region', { name: 'Mod Moonlight Project', exact: true })
  await expect(card).toContainText('format 27')
  await card.getByRole('button', { name: 'Disable Moonlight Project', exact: true }).click()
  const stats = page.getByRole('region', { name: 'Class stats', exact: true })
  await expect(stats).toContainText('Enable Moonlight Project to calculate stats')
  await expect(stats).not.toContainText('Stats unavailable')
  await stats.getByRole('button', { name: 'Enable Moonlight Project', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Enable Moonlight Project', exact: true }).click()
  await expect(totals).toBeVisible()
  expect((await storedData(page)).buildRevisions).toEqual(after.buildRevisions)
  expect(errors).toEqual([])
})

test('a failed confirmation retains the field and supports an explicit retry', async ({ page }) => {
  await page.goto('/#/builds/library/new')
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toBeVisible()
  const before = await storedData(page)
  const dialog = await promptFreelancer(page)
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    let failOnce = true
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.name === 'sources' && failOnce) { failOnce = false; throw new DOMException('Synthetic source import failure', 'QuotaExceededError') }
      return add.apply(this, args)
    }
  })
  await dialog.getByRole('button', { name: 'Enable and select Freelancer', exact: true }).click()
  await expect(dialog.getByText('Mod could not be enabled', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('')
  await dialog.getByRole('button', { name: 'Enable and select Freelancer', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Freelancer build', exact: true })).toBeVisible()
  expect((await storedData(page)).playthroughs).toEqual(before.playthroughs)
})

test('equipment without a source file asks once and preserves unknown calculation effects', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library/new')
  await choose(page, 'Class', 'Warrior')
  await choose(page, 'Off hand', 'Doge Shield', { includeUnavailable: true })
  const dialog = page.getByRole('dialog', { name: 'Enable Doge Shield?', exact: true })
  await expect(dialog).toContainText('Source data is unavailable')
  const field = page.getByRole('combobox', { name: 'Off hand', exact: true })
  await expect(field).toHaveValue('')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(field).toHaveValue('')
  await choose(page, 'Off hand', 'Doge Shield')
  await dialog.getByRole('button', { name: 'Enable and select Doge Shield', exact: true }).click()
  await expect(field).toHaveValue('Doge Shield')
  await choose(page, 'Off hand', 'Doge Shield')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Class stats', exact: true })).toContainText('unavailable')
})

test('growth choices confirm their source and subsequent selections from it need no prompt', async ({ page }) => {
  await page.goto('/#/builds/library/new')
  await choose(page, 'Class', 'Warrior')
  await page.getByText(/^Level-up growth ·/).click()
  await choose(page, 'Growth class 1', 'Freelancer', { includeUnavailable: true })
  const dialog = page.getByRole('dialog', { name: 'Enable Moonlight Project?', exact: true })
  const growth = page.getByRole('combobox', { name: 'Growth class 1', exact: true })
  await expect(dialog).toBeVisible()
  await expect(growth).toHaveValue('Warrior')
  await page.keyboard.press('Escape')
  await expect(growth).toHaveValue('Warrior')
  await growth.fill('Freelancer')
  await page.getByRole('listbox', { name: 'Choose Growth class 1', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Freelancer$/ }) }).click()
  await dialog.getByRole('button', { name: 'Enable and select Freelancer', exact: true }).click()
  await expect(growth).toHaveValue('Freelancer')
  await page.getByRole('combobox', { name: 'Sub-command', exact: true }).fill('Brawler')
  await page.getByRole('listbox', { name: 'Choose Sub-command', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Combo \(Brawler\)$/ }) }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Sub-command', exact: true })).toHaveValue('Combo (Brawler)')
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
})

test('legacy format 4 passives confirm the saved source before selection', async ({ page }) => {
  const source = JSON.stringify({ ID: 'synthetic-legacy-prompt', Title: 'Synthetic legacy mod', Version: '1', EditorVersion: 4, Passives: [{ ID: 9001, Name: 'Synthetic old passive', PP: 1, IsInnate: false, IsLearnable: true, StatMods: [] }] })
  await page.goto('/#/mods')
  await page.getByLabel('Import mod JSON', { exact: true }).setInputFiles({ name: 'synthetic-legacy.json', mimeType: 'application/json', buffer: Buffer.from(source) })
  await expect(page.getByText('Mod revision saved to CryKit', { exact: true })).toBeVisible()
  const before = await storedData(page)
  await page.goto('/#/builds/library/new')
  await choose(page, 'Equipped passive 1', 'Synthetic old passive', { includeUnavailable: true })
  const dialog = page.getByRole('dialog', { name: 'Enable Synthetic legacy mod?', exact: true })
  const field = page.getByRole('combobox', { name: 'Equipped passive 1', exact: true })
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue('')
  await dialog.getByText('Version details', { exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: 'Mod version', exact: true }).locator('option:checked')).toHaveText('1 · saved · format 4')
  await dialog.getByRole('button', { name: 'Enable and select Synthetic old passive', exact: true }).click()
  await expect(field).toHaveValue('Synthetic old passive')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Untitled build', exact: true })).toBeVisible()
  const after = await storedData(page)
  const build = Object.values(after.builds).find(build => build.title === 'Untitled build')!
  const revision = after.buildRevisions[build.latestRevisionId!]!
  expect(after.gameSetups[revision.gameSetupRevisionId]!.modComposition!.layers).toMatchObject([{ catalogId: 'crystal-edit:synthetic-legacy-prompt', enabled: true }])
  expect(after.playthroughs).toEqual(before.playthroughs)
})

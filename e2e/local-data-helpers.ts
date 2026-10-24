import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { expect, type Locator, type Page } from '@playwright/test'
import type { LocalData, Playthrough } from '../src/domain'
import { readManagedGuestPlanner } from './guest-planner-reader'

export async function waitForPlannerReady(page: Page): Promise<void> {
  // First-run seed validation can outlast the browser load event; wait for the app shell before route assertions
  await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).waitFor()
}

export async function selectedGuestPlannerName(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const name = 'crykit-guest-coordinator-v1'
    if (!(await indexedDB.databases()).some(database => database.name === name)) return 'crykit'
    return new Promise<string>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('active', 'readonly')
        const read = transaction.objectStore('active').get('active')
        transaction.onerror = () => { database.close(); reject(transaction.error) }
        transaction.oncomplete = () => {
          database.close()
          const planner = read.result?.manifest?.planner
          if (typeof planner !== 'string' || !planner) reject(new Error('Selected guest planner is unavailable'))
          else resolve(planner)
        }
      }
    })
  })
}

export async function readLocalData(page: Page): Promise<LocalData> {
  const managed = await readManagedGuestPlanner(page)
  if (managed) return structuredClone(managed.localData)
  const name = await selectedGuestPlannerName(page)
  return page.evaluate(name => new Promise<LocalData>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('localDatas', 'readonly')
      transaction.oncomplete = () => database.close()
      transaction.onerror = () => { database.close(); reject(transaction.error) }
      const records = transaction.objectStore('localDatas').getAll()
      records.onsuccess = () => {
        const record = (records.result as { localData: LocalData }[])[0]
        if (record) resolve(record.localData)
        else reject(new Error('Synthetic planner data not found'))
      }
    }
  }), name)
}

export function selectedPlaythrough(localData: LocalData): Playthrough {
  const playthrough = localData.selectedPlaythroughId ? localData.playthroughs[localData.selectedPlaythroughId] : undefined
  if (!playthrough) throw new Error('The fixture has no selected Playthrough')
  return playthrough
}

// Restored records do not select a device context; the Tracking picker also works when no Playthrough is selected
export async function choosePlaythrough(page: Page, label: string): Promise<void> {
  const previousUrl = page.url(), trackingUrl = new URL(previousUrl)
  trackingUrl.hash = '/inventory'
  await page.goto(trackingUrl.href)
  await page.getByRole('button', { name: /^Playthrough:/ }).click()
  const picker = page.getByRole('dialog', { name: 'Choose playthrough', exact: true })
  await picker.getByRole('button').filter({ has: page.getByText(label, { exact: true }) }).click()
  await expect(picker).not.toBeVisible()
  await expect(page.getByRole('button', { name: `Playthrough: ${label}`, exact: true })).toBeVisible()
  await page.goto(previousUrl)
}

export async function createBlankPlaythrough(page: Page): Promise<void> {
  // The first-run mod chooser opens only on the landing route and can cover Data & settings
  const hash = new URL(page.url()).hash
  if (!hash || hash === '#/' || await page.getByRole('dialog', { name: 'Choose your mods', exact: true }).isVisible()) await skipInitialModSetup(page)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  await panel.locator('.playthrough-create > summary').click()
  await panel.getByLabel('New blank Playthrough').fill('Blank test playthrough')
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Active Playthrough', exact: true }).locator('option:checked')).toContainText('Blank test playthrough')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
}

export async function replacePlannerData(panel: Locator): Promise<void> {
  await panel.getByRole('checkbox', { name: /Replace all planner data/ }).check()
  await panel.getByRole('button', { name: 'Replace planner data', exact: true }).click()
  // Complete import validation and publication are bulk work, separate from ordinary durable saves
  await panel.getByRole('button', { name: 'Importing...', exact: true }).waitFor({ state: 'hidden' })
}

// Use the supported native import boundary instead of writing a retired planner database
export async function replacePlannerFixture(page: Page, localData: LocalData): Promise<LocalData> {
  const previousUrl = page.url()
  await page.goto('/#/settings/data')
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  const download = page.waitForEvent('download')
  if (!await panel.getByRole('button', { name: 'Export planner ZIP', exact: true }).isVisible()) await panel.getByText("What's included in a backup?", { exact: true }).click()
  await panel.getByRole('button', { name: 'Export planner ZIP', exact: true }).click()
  const path = await (await download).path()
  if (!path) throw new Error('The fixture backup download did not finish')
  const files = unzipSync(await readFile(path))
  const bundle = JSON.parse(strFromU8(files['bundle.json']!))
  // Preserve exact exported catalog/source receipts; the import records its own native command
  files['bundle.json'] = new TextEncoder().encode(JSON.stringify({ ...bundle, localData: { ...localData, changes: [] }, history: [] }))
  await panel.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-planner-fixture.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) })
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  await page.goto(previousUrl)
  await waitForPlannerReady(page)
  return readLocalData(page)
}

export async function chooseFourTeamMembers(form: Locator): Promise<void> {
  const selectors = form.getByRole('combobox', { name: /^Party member \d$/ })
  await expect(selectors).toHaveCount(4)
  for (let index = 0; index < 4; index += 1) {
    const selector = selectors.nth(index)
    if (await selector.inputValue()) continue
    const option = selector.locator('option:not([disabled])').filter({ hasNotText: 'Choose character' }).first()
    await selector.selectOption((await option.getAttribute('value'))!)
  }
}

export async function openBuildGameSetup(page: Page): Promise<void> {
  const setup = page.locator('.build-behavior')
  if (await setup.getAttribute('open') === null) await setup.locator(':scope > summary').click()
}

export async function openGameSetupSection(panel: Locator, label: string): Promise<void> {
  if (await panel.evaluate(element => element instanceof HTMLDetailsElement && !element.open)) await panel.locator(':scope > summary').click()
  if (label === 'Game context') {
    const details = panel.locator('.game-setup-base-details')
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
    return
  }
  if (label === 'Mods' || label === 'Imported mod files') {
    const mods = panel.locator('.game-setup-mods')
    if (await mods.getAttribute('open') === null) await mods.locator(':scope > summary').click()
    if (label === 'Mods') {
      const named = mods.locator('.game-setup-named-mods')
      if (await named.getAttribute('open') === null) await named.locator(':scope > summary').click()
    }
    return
  }
  const derived = panel.locator('.game-setup-derived')
  if (await derived.getAttribute('open') === null) await derived.locator(':scope > summary').click()
}

export async function openSwitchModPacks(panel: Locator): Promise<void> {
  if (await panel.locator('.game-setup-mods').count()) await openGameSetupSection(panel, 'Mods')
  const packs = panel.locator('.game-setup-mod-pack')
  for (let index = 0; index < await packs.count(); index += 1) {
    const pack = packs.nth(index)
    if (await pack.getAttribute('open') === null) await pack.locator(':scope > summary').click()
  }
}

export async function openCurrentGameSetup(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  const setupId = await panel.getByRole('combobox', { name: 'Game Setup to apply', exact: true }).inputValue()
  if (!setupId) throw new Error('The fixture has no current Game Setup')
  await panel.getByRole('button', { name: 'Manage saved setups', exact: true }).click()
  const revisionSelector = `button[data-game-setup-revision=${JSON.stringify(setupId)}]`
  const history = panel.locator('.game-setup-library__item > details').filter({ has: panel.page().locator(revisionSelector) })
  await history.locator(':scope > summary').click()
  await history.locator(revisionSelector).click()
  await expect(panel.getByRole('heading', { name: 'Saved Game Setup', exact: true })).toBeVisible()
  await openGameSetupSection(panel, 'Game context')
}

export async function applySavedGameSetup(panel: Locator): Promise<void> {
  await expect(panel.getByRole('button', { name: 'Save Game Setup', exact: true })).toBeDisabled()
  const page = panel.page()
  const editorUrl = page.url()
  const setupId = new URLSearchParams(new URL(editorUrl).hash.split('?')[1]).get('gameSetup')
  if (!setupId) throw new Error('The editor has no saved Game Setup revision')
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  await panel.getByRole('combobox', { name: 'Game Setup to apply', exact: true }).selectOption(setupId)
  await panel.getByRole('button', { name: /^Apply to / }).click()
  await expect(panel.getByRole('combobox', { name: 'Active Playthrough', exact: true })).toBeEnabled()
  await expect(panel.getByRole('button', { name: /^Apply to / })).toBeDisabled()
  await page.goBack()
  await expect(page).toHaveURL(editorUrl)
  await expect(panel.getByRole('heading', { name: 'Saved Game Setup', exact: true })).toBeVisible()
}

export async function saveAndApplyGameSetup(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: /^(Create Game Setup|Save Game Setup)$/ }).click()
  await applySavedGameSetup(panel)
}

export async function skipInitialModSetup(page: Page): Promise<void> {
  const selector = page.getByRole('dialog', { name: 'Choose your mods', exact: true })
  await waitForPlannerReady(page)
  if ((await readLocalData(page)).modSetup?.state !== 'pending') return
  await expect(selector).toBeVisible()
  await selector.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect(selector).not.toBeVisible()
}

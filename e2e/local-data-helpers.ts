import { expect, type Locator, type Page } from '@playwright/test'
import type { LocalData, Playthrough } from '../src/domain'

export function selectedPlaythrough(localData: LocalData): Playthrough {
  const playthrough = localData.selectedPlaythroughId ? localData.playthroughs[localData.selectedPlaythroughId] : undefined
  if (!playthrough) throw new Error('The fixture has no selected Playthrough')
  return playthrough
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

export async function addBundledModToReference(page: Page, title: string): Promise<void> {
  await page.goto('/')
  await skipInitialModSetup(page)
  await page.goto('/#/mods')
  await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill(title)
  const card = page.getByRole('region', { name: title, exact: true })
  await card.getByRole('button', { name: 'Add to Reference', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Remove from Reference', exact: true })).toBeVisible()
}

export async function replacePlannerData(panel: Locator): Promise<void> {
  await panel.getByRole('checkbox', { name: /Replace all local planner data after validation/ }).check()
  await panel.getByRole('button', { name: 'Replace planner data', exact: true }).click()
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
  const state = async () => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('crykit')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (!database.objectStoreNames.contains('localDatas')) return 'loading'
      return await new Promise<string>((resolve, reject) => {
        const request = database.transaction('localDatas').objectStore('localDatas').get('local-data-record')
        request.onsuccess = () => resolve(request.result ? request.result.localData.modSetup?.state ?? 'legacy' : 'loading')
        request.onerror = () => reject(request.error)
      })
    } finally { database.close() }
  })
  await expect.poll(state).not.toBe('loading')
  if (await state() !== 'pending') return
  await expect(selector).toBeVisible()
  await selector.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect(selector).not.toBeVisible()
}

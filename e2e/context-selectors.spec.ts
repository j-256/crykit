import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { selectedPlaythrough, chooseFourTeamMembers, createBlankPlaythrough, openGameSetupSection } from './local-data-helpers'

type ContextLabel = 'Playthrough' | 'Game Setup' | 'Scenario'

async function openContext(page: Page, label: ContextLabel) {
  await page.getByRole('button', { name: new RegExp(`^${label}:`) }).click()
  const picker = page.getByRole('dialog', { name: `Choose ${label.toLowerCase()}`, exact: true })
  await expect(picker).toBeVisible()
  return picker
}

async function chooseContext(page: Page, label: ContextLabel, name: string) {
  const picker = await openContext(page, label)
  await picker.locator('.picker-result').filter({ has: page.getByText(name, { exact: true }) }).click()
  await expect(picker).not.toBeVisible()
}

async function readLocalData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise<LocalData>((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('localDatas', 'readonly')
      transaction.oncomplete = () => db.close()
      transaction.onerror = () => { db.close(); reject(transaction.error) }
      const records = transaction.objectStore('localDatas').getAll()
      records.onsuccess = () => {
        const record = (records.result as { localData: LocalData }[])[0]
        if (record) resolve(record.localData)
        else reject(new Error('Synthetic planner data not found'))
      }
    }
  }))
}

async function addGameSetupRevision(page: Page) {
  const picker = await openContext(page, 'Game Setup')
  await picker.getByRole('button', { name: 'Configure Game Setup', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await openGameSetupSection(settings, 'Game context')
  await settings.getByLabel('Platform', { exact: true }).selectOption('PC')
  await settings.getByRole('button', { name: 'Save new Game Setup revision', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Save new Game Setup revision', exact: true })).toBeEnabled()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/inventory')
  await expect(page.getByRole('button', { name: 'Playthrough: Sample playthrough', exact: true })).toBeVisible()
})

test('all context selectors fit, search, support keyboard and touch, and dismiss to their trigger', async ({ page, isMobile }, testInfo) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 740 })
  for (const label of ['Playthrough', 'Game Setup', 'Scenario'] as const) {
    const trigger = page.getByRole('button', { name: new RegExp(`^${label}:`) })
    await expect(trigger).toBeVisible()
    const bounds = (await trigger.boundingBox())!
    expect(bounds.height).toBeGreaterThanOrEqual(44)
    if (isMobile) await trigger.tap()
    else await trigger.press('ArrowDown')
    const picker = page.getByRole('dialog', { name: `Choose ${label.toLowerCase()}`, exact: true })
    const search = picker.getByRole('searchbox')
    await expect(search).toBeFocused()
    const popup = (await picker.boundingBox())!
    expect(popup.x).toBeGreaterThanOrEqual(0)
    expect(popup.x + popup.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    expect(popup.y + popup.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    await search.fill('no matching synthetic choice')
    await expect(picker.getByText('No matching choices.', { exact: true })).toBeVisible()
    await search.fill('')
    await search.press('ArrowDown')
    await expect(picker.locator('.picker-result').first()).toBeFocused()
    await page.keyboard.press('End')
    await expect(picker.locator('.picker-result').last()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(picker).not.toBeVisible()
    await expect(trigger).toBeFocused()
  }
  const scenarioPicker = await openContext(page, 'Scenario')
  await expect(scenarioPicker.locator('.picker-result[aria-pressed="true"]')).toContainText('Sample starter team')
  await page.screenshot({ path: testInfo.outputPath('context-dropdown.png') })
  await page.locator('.brand').filter({ visible: true }).click()
  await expect(scenarioPicker).not.toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Playthrough switching isolates tracked records while sharing Game Setups and Builds', async ({ page }) => {
  await createBlankPlaythrough(page)
  const blank = await readLocalData(page)
  const blankPlaythrough = selectedPlaythrough(blank)
  await expect(page.getByRole('button', { name: 'Game Setup: Sample starter Game Setup · revision 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Scenario: None selected', exact: true })).toBeVisible()
  const gameSetups = await openContext(page, 'Game Setup')
  await expect(gameSetups.getByRole('button', { name: /Sample starter Game Setup/ })).toBeVisible()
  await expect(gameSetups.getByRole('button', { name: 'Configure Game Setup', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  const scenarios = await openContext(page, 'Scenario')
  await expect(scenarios.getByRole('button', { name: 'New scenario', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await chooseContext(page, 'Playthrough', 'Sample playthrough')
  const sample = await readLocalData(page)
  const characterId = Object.values(selectedPlaythrough(sample).characters)[0]!.id
  await page.goto(`/#/characters/${characterId}/current`)
  await chooseContext(page, 'Playthrough', 'Blank test playthrough')
  await expect(page).toHaveURL(/#\/characters$/)
  await expect(page.getByRole('heading', { name: 'Your roster is blank', exact: true })).toBeVisible()
  const switched = await readLocalData(page)
  expect(switched.playthroughs[blankPlaythrough.id]).toEqual(blank.playthroughs[blankPlaythrough.id])
  expect(switched.builds).toEqual(blank.builds)
  expect(switched.gameSetups).toEqual(blank.gameSetups)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Playthrough: Blank test playthrough', exact: true })).toBeVisible()
  await chooseContext(page, 'Playthrough', 'Sample playthrough')
  await expect(page.getByRole('button', { name: 'Scenario: Sample starter team', exact: true })).toBeVisible()
})

test('Game Setup revisions and scenarios persist independently while saved pins remain intact', async ({ page }) => {
  const original = await readLocalData(page)
  await addGameSetupRevision(page)
  await expect(page.getByRole('button', { name: 'Game Setup: Sample starter Game Setup · revision 2', exact: true })).toBeVisible()
  let picker = await openContext(page, 'Scenario')
  await expect(picker.locator('.picker-result').filter({ hasText: 'Sample starter team' })).toContainText('Different from current Game Setup')
  await picker.getByRole('button', { name: 'New scenario', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Create team scenario', exact: true })
  await form.getByLabel('Scenario label').fill('Synthetic alternate team')
  await chooseFourTeamMembers(form)
  await form.getByRole('button', { name: 'Create scenario', exact: true }).click()
  await expect(form).not.toBeVisible()
  const withAlternate = await readLocalData(page)
  await chooseContext(page, 'Scenario', 'Sample starter team')
  await expect(page).toHaveURL(/#\/builds\/teams\//)
  await expect(page.locator('article').filter({ has: page.getByRole('heading', { name: 'Sample starter team', exact: true }) }).getByText('Active', { exact: true })).toBeVisible()
  picker = await openContext(page, 'Game Setup')
  await picker.getByRole('button', { name: /^Sample starter Game Setup Revision 1/ }).click()
  await expect(picker).not.toBeVisible()
  await chooseContext(page, 'Scenario', 'Synthetic alternate team')
  const selected = await readLocalData(page)
  expect(selected.planningGameSetupRevisionId).toBe(original.planningGameSetupRevisionId)
  expect(selectedPlaythrough(selected).scenarios).toEqual(selectedPlaythrough(withAlternate).scenarios)
  expect(selected.buildRevisions).toEqual(original.buildRevisions)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Game Setup: Sample starter Game Setup · revision 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Scenario: Synthetic alternate team', exact: true })).toBeVisible()
  await chooseContext(page, 'Scenario', 'None selected')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Scenario: None selected', exact: true })).toBeVisible()
  expect(selectedPlaythrough(await readLocalData(page)).scenarios).toEqual(selectedPlaythrough(withAlternate).scenarios)
})

test('open build drafts block every context change without losing edited selections', async ({ page }) => {
  await createBlankPlaythrough(page)
  await chooseContext(page, 'Playthrough', 'Sample playthrough')
  await addGameSetupRevision(page)
  const saved = await readLocalData(page)
  await page.goto('/#/builds/library/new')
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Warrior')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ has: page.getByText('Warrior', { exact: true }) }).click()
  for (const [label, option] of [['Playthrough', /^Blank test playthrough/], ['Game Setup', /^Sample starter Game Setup Revision 1/]] as const) {
    const picker = await openContext(page, label)
    await picker.getByRole('button', { name: option }).click()
    await expect(picker.getByText(`${label} switch failed`, { exact: true })).toBeVisible()
    await expect(picker).toContainText('Save or discard open form edits')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
  }
  expect(await readLocalData(page)).toEqual(saved)
  await expect(page.getByRole('button', { name: /^Scenario:/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel and discard', exact: true }).click()
  await page.getByRole('button', { name: 'Team scenarios', exact: true }).click()
  await chooseContext(page, 'Scenario', 'None selected')
})

test('the selected scenario supplies readiness when a checkpoint belongs to multiple teams', async ({ page }) => {
  const original = await readLocalData(page)
  const revision = Object.values(original.buildRevisions)[0]!
  const originalPlaythrough = selectedPlaythrough(original)
  const characterId = Object.entries(originalPlaythrough.scenarios[originalPlaythrough.activeScenarioId!]!.assignments).find(([, assignedRevisionId]) => assignedRevisionId === revision.id)?.[0]
  const character = originalPlaythrough.characters[characterId!]!
  const picker = await openContext(page, 'Scenario')
  await picker.getByRole('button', { name: 'New scenario', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Create team scenario', exact: true })
  await form.getByLabel('Scenario label').fill('Synthetic readiness team')
  await chooseFourTeamMembers(form)
  await form.getByRole('button', { name: 'Create scenario', exact: true }).click()
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic readiness team', exact: true }) })
  await card.getByRole('combobox', { name: character.name, exact: true }).selectOption(revision.id)
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.goto(`/#/builds/library/${revision.buildId}/revisions/${revision.id}`)
  await page.locator('.build-readiness > summary').click()
  await expect(page.getByText('Evaluated in Synthetic readiness team', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Team scenarios', exact: true }).click()
  await chooseContext(page, 'Scenario', 'Sample starter team')
  await page.goto(`/#/builds/library/${revision.buildId}/revisions/${revision.id}`)
  await page.locator('.build-readiness > summary').click()
  await expect(page.getByText('Evaluated in Sample starter team', { exact: true })).toBeVisible()
  expect((await readLocalData(page)).buildRevisions).toEqual(original.buildRevisions)
})

test('failed selection remains recoverable and can be retried and reopened offline', async ({ page, context }) => {
  const original = await readLocalData(page)
  const playthroughs = await openContext(page, 'Playthrough')
  await playthroughs.getByRole('button', { name: 'Manage Playthroughs', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  if (await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).isVisible()) await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = originalPut; throw new DOMException('Synthetic context save failure', 'QuotaExceededError') }
      return originalPut.apply(this, args)
    }
  })
  const picker = await openContext(page, 'Scenario')
  await picker.getByRole('button', { name: /^None selected/ }).click()
  await expect(picker.getByText('Scenario switch failed', { exact: true })).toBeVisible()
  expect(await readLocalData(page)).toEqual(original)
  await picker.getByRole('button', { name: /^Sample starter team/ }).click()
  await expect(picker).toContainText('retry any failed save')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const saved = await readLocalData(page)
  expect(selectedPlaythrough(saved).activeScenarioId).toBeUndefined()
  expect(selectedPlaythrough(saved).scenarios).toEqual(selectedPlaythrough(original).scenarios)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Scenario: None selected', exact: true })).toBeVisible()
  await chooseContext(page, 'Scenario', 'Sample starter team')
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  expect(selectedPlaythrough(await readLocalData(page)).activeScenarioId).toBe(selectedPlaythrough(original).activeScenarioId)
})

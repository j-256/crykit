import { expect, test, type Page } from '@playwright/test'
import type { Profile } from '../src/domain/types'
import { createBlankPlaythrough } from './profile-helpers'

type ContextLabel = 'Playthrough' | 'Ruleset' | 'Scenario'

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

async function readProfile(page: Page, label = 'Sample playthrough'): Promise<Profile> {
  return page.evaluate((profileLabel) => new Promise<Profile>((resolve, reject) => {
    const request = indexedDB.open('crystal-companion')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('profiles', 'readonly')
      transaction.oncomplete = () => db.close()
      transaction.onerror = () => { db.close(); reject(transaction.error) }
      const records = transaction.objectStore('profiles').getAll()
      records.onsuccess = () => {
        const record = (records.result as { profile: Profile }[]).find((entry) => entry.profile.label === profileLabel)
        if (record) resolve(record.profile)
        else reject(new Error('Synthetic profile not found'))
      }
    }
  }), label)
}

async function addRulesetRevision(page: Page) {
  const picker = await openContext(page, 'Ruleset')
  await picker.getByRole('button', { name: 'Configure ruleset', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByLabel('Platform', { exact: true }).fill('Synthetic platform')
  await settings.getByRole('button', { name: 'Save new ruleset revision', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Save new ruleset revision', exact: true })).toBeEnabled()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Playthrough: Sample playthrough', exact: true })).toBeVisible()
})

test('all context selectors fit, search, support keyboard and touch, and dismiss to their trigger', async ({ page, isMobile }, testInfo) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 740 })
  for (const label of ['Playthrough', 'Ruleset', 'Scenario'] as const) {
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

test('playthrough switching isolates records, resets record links, and exposes blank-state actions', async ({ page }) => {
  await createBlankPlaythrough(page)
  const blank = await readProfile(page, 'Blank test playthrough')
  await expect(page.getByRole('button', { name: 'Ruleset: Not configured', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Scenario: None selected', exact: true })).toBeVisible()
  const rulesets = await openContext(page, 'Ruleset')
  await expect(rulesets.getByText('No rulesets yet. Configure one to get started.', { exact: true })).toBeVisible()
  await expect(rulesets.getByRole('button', { name: 'Configure ruleset', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  const scenarios = await openContext(page, 'Scenario')
  await expect(scenarios.getByRole('button', { name: 'New scenario', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await chooseContext(page, 'Playthrough', 'Sample playthrough')
  const sample = await readProfile(page)
  const characterId = Object.values(sample.characters)[0]!.id
  await page.goto(`/#/characters/${characterId}/current`)
  await chooseContext(page, 'Playthrough', 'Blank test playthrough')
  await expect(page).toHaveURL(/#\/characters$/)
  await expect(page.getByRole('heading', { name: 'Your roster is blank', exact: true })).toBeVisible()
  expect(await readProfile(page, 'Blank test playthrough')).toEqual(blank)
  expect(await readProfile(page)).toEqual(sample)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Playthrough: Blank test playthrough', exact: true })).toBeVisible()
  await chooseContext(page, 'Playthrough', 'Sample playthrough')
  await expect(page.getByRole('button', { name: 'Scenario: Sample starter team', exact: true })).toBeVisible()
})

test('ruleset revisions and scenarios persist independently while saved pins remain intact', async ({ page }) => {
  const original = await readProfile(page)
  await addRulesetRevision(page)
  await expect(page.getByRole('button', { name: 'Ruleset: Sample starter ruleset · revision 2', exact: true })).toBeVisible()
  let picker = await openContext(page, 'Scenario')
  await expect(picker.locator('.picker-result').filter({ hasText: 'Sample starter team' })).toContainText('Different from active ruleset')
  await picker.getByRole('button', { name: 'New scenario', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Create team scenario', exact: true })
  await form.getByLabel('Scenario label').fill('Synthetic alternate team')
  await form.getByRole('button', { name: 'Create scenario', exact: true }).click()
  await expect(form).not.toBeVisible()
  const withAlternate = await readProfile(page)
  await chooseContext(page, 'Scenario', 'Sample starter team')
  await expect(page).toHaveURL(/#\/builds\/teams\//)
  await expect(page.locator('article').filter({ has: page.getByRole('heading', { name: 'Sample starter team', exact: true }) }).getByText('Active', { exact: true })).toBeVisible()
  picker = await openContext(page, 'Ruleset')
  await picker.getByRole('button', { name: /^Sample starter ruleset Revision 1/ }).click()
  await expect(picker).not.toBeVisible()
  await chooseContext(page, 'Scenario', 'Synthetic alternate team')
  const selected = await readProfile(page)
  expect(selected.activeRulesetRevisionId).toBe(original.activeRulesetRevisionId)
  expect(selected.scenarios).toEqual(withAlternate.scenarios)
  expect(selected.buildRevisions).toEqual(original.buildRevisions)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Ruleset: Sample starter ruleset · revision 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Scenario: Synthetic alternate team', exact: true })).toBeVisible()
  await chooseContext(page, 'Scenario', 'None selected')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Scenario: None selected', exact: true })).toBeVisible()
  expect((await readProfile(page)).scenarios).toEqual(withAlternate.scenarios)
})

test('open build drafts block every context change without losing edited selections', async ({ page }) => {
  await createBlankPlaythrough(page)
  await chooseContext(page, 'Playthrough', 'Sample playthrough')
  await addRulesetRevision(page)
  const saved = await readProfile(page)
  await page.goto('/#/builds/library/new')
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Warrior')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ has: page.getByText('Warrior', { exact: true }) }).click()
  for (const [label, option] of [['Playthrough', /^Blank test playthrough/], ['Ruleset', /^Sample starter ruleset Revision 1/], ['Scenario', /^None selected/]] as const) {
    const picker = await openContext(page, label)
    await picker.getByRole('button', { name: option }).click()
    await expect(picker.getByText(`${label} switch failed`, { exact: true })).toBeVisible()
    await expect(picker).toContainText('Save or discard open form edits')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
  }
  expect(await readProfile(page)).toEqual(saved)
  await page.getByRole('button', { name: 'Cancel and discard', exact: true }).click()
  await chooseContext(page, 'Scenario', 'None selected')
})

test('the selected scenario supplies readiness when a checkpoint belongs to multiple teams', async ({ page }) => {
  const original = await readProfile(page)
  const revision = Object.values(original.buildRevisions)[0]!
  const character = original.characters[original.builds[revision.buildId]!.characterId!]!
  const picker = await openContext(page, 'Scenario')
  await picker.getByRole('button', { name: 'New scenario', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Create team scenario', exact: true })
  await form.getByLabel('Scenario label').fill('Synthetic readiness team')
  await form.getByRole('button', { name: 'Create scenario', exact: true }).click()
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic readiness team', exact: true }) })
  await card.getByRole('combobox', { name: character.name, exact: true }).selectOption(revision.id)
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.goto(`/#/builds/library/${revision.buildId}/revisions/${revision.id}`)
  await page.locator('.build-readiness > summary').click()
  await expect(page.getByText('Evaluated in Synthetic readiness team', { exact: true })).toBeVisible()
  await chooseContext(page, 'Scenario', 'Sample starter team')
  await expect(page.getByText('Evaluated in Sample starter team', { exact: true })).toBeVisible()
  expect((await readProfile(page)).buildRevisions).toEqual(original.buildRevisions)
})

test('failed selection remains recoverable and can be retried and reopened offline', async ({ page, context }) => {
  const original = await readProfile(page)
  const profiles = await openContext(page, 'Playthrough')
  await profiles.getByRole('button', { name: 'Manage playthroughs', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  if (await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).isVisible()) await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expect(settings.getByText('Offline ready', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
      if (this.name === 'profiles') { IDBObjectStore.prototype.put = originalPut; throw new DOMException('Synthetic context save failure', 'QuotaExceededError') }
      return originalPut.apply(this, args)
    }
  })
  const picker = await openContext(page, 'Scenario')
  await picker.getByRole('button', { name: /^None selected/ }).click()
  await expect(picker.getByText('Scenario switch failed', { exact: true })).toBeVisible()
  expect(await readProfile(page)).toEqual(original)
  await picker.getByRole('button', { name: /^Sample starter team/ }).click()
  await expect(picker).toContainText('retry any failed save')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const saved = await readProfile(page)
  expect(saved.activeScenarioId).toBeUndefined()
  expect(saved.scenarios).toEqual(original.scenarios)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Scenario: None selected', exact: true })).toBeVisible()
  await chooseContext(page, 'Scenario', 'Sample starter team')
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  expect((await readProfile(page)).activeScenarioId).toBe(original.activeScenarioId)
})

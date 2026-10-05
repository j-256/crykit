import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { zipSync } from 'fflate'
import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import { createSampleLocalData } from '../src/domain/sample-data'
import type { LocalData } from '../src/domain/types'
import { skipInitialModSetup, createBlankPlaythrough, openGameSetupSection, replacePlannerData, selectedPlaythrough } from './local-data-helpers'
import { expectOfflineReady } from './offline-helpers'

const settings = (page: Page) => page.getByRole('dialog', { name: 'Data & settings', exact: true })
const save = (page: Page) => settings(page).getByRole('button', { name: 'Save Game Setup', exact: true })

async function readData(page: Page): Promise<LocalData> {
  await expect(page.getByRole('heading', { name: 'Opening Crystal Kit', exact: true })).toHaveCount(0)
  return page.evaluate(() => new Promise<LocalData>((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('localDatas', 'readonly')
      transaction.oncomplete = () => db.close()
      transaction.onerror = () => { db.close(); reject(transaction.error) }
      const records = transaction.objectStore('localDatas').getAll()
      records.onsuccess = () => resolve(records.result[0].localData as LocalData)
    }
  }))
}

test('Playthrough assignment and Game Setup editing open distinct screens', async ({ page }) => {
  await page.goto('/#/settings/game-setup?scope=playthrough')
  const panel = settings(page)
  await expect(page).toHaveURL(/settings\/playthrough$/)
  await expect(panel.getByRole('combobox', { name: 'Game Setup to apply', exact: true })).toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Game version', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('combobox', { name: 'Difficulty', exact: true })).toHaveCount(0)
  await expect(panel.locator('.game-setup-form')).toHaveCount(0)
  const data = await readData(page)
  const setupId = selectedPlaythrough(data).currentGameSetupRevisionId!
  await page.goto(`/#/settings/game-setup?gameSetup=${setupId}`)
  await expect(panel.getByRole('heading', { name: 'Saved Game Setup', exact: true })).toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Game version', exact: true })).toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Difficulty', exact: true })).toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Game Setup to apply', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Saved setups', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await readData(page)).toEqual(data)
})

test('context is visible, unchanged drafts do not save, and discard protects navigation', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/#/settings/game-setup')
  await settings(page).getByRole('button', { name: 'Edit setup', exact: true }).first().click()
  const panel = settings(page)
  await expect(panel.getByRole('combobox', { name: 'Difficulty', exact: true })).toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Platform', exact: true })).not.toBeVisible()
  await expect(save(page)).toBeDisabled()
  const original = await readData(page)
  const label = panel.getByLabel('Game Setup label')
  const previous = await label.inputValue()
  await label.fill('Synthetic unsaved setup')
  await expect(save(page)).toBeEnabled()
  if (isMobile) {
    const bounds = await save(page).boundingBox()
    expect(bounds!.width).toBeGreaterThan(130)
    expect(bounds!.height).toBeLessThan(90)
  }
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  await expect(page).toHaveURL(/settings\/game-setup\?gameSetup=/)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Discard and close', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(label).toHaveValue('Synthetic unsaved setup')
  await panel.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await panel.getByRole('button', { name: 'Discard edits', exact: true }).click()
  await expect(label).toHaveValue(previous)
  await expect(save(page)).toBeDisabled()
  await label.fill('Synthetic close confirmation')
  await page.keyboard.press('Escape')
  await panel.getByRole('button', { name: 'Discard and close', exact: true }).click()
  await expect(panel).not.toBeVisible()
  expect(await readData(page)).toEqual(original)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('exact versions and difficulty preserve other Playthroughs and historical pins', async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await createBlankPlaythrough(page)
  const original = await readData(page)
  const source = original.gameSetups[original.planningGameSetupRevisionId!]!
  await page.goto('/#/settings/game-setup')
  await settings(page).getByRole('button', { name: 'Edit setup', exact: true }).first().click()
  const panel = settings(page)
  await openGameSetupSection(panel, 'Game context')
  await panel.getByRole('combobox', { name: 'Platform', exact: true }).selectOption('Windows')
  await panel.getByRole('combobox', { name: 'Game version', exact: true }).selectOption('1.6.9')
  await panel.getByRole('combobox', { name: 'Game mode', exact: true }).selectOption('Standard')
  await panel.getByRole('combobox', { name: 'Difficulty', exact: true }).selectOption('2')
  await openGameSetupSection(panel, 'Rules from game data')
  await panel.getByText('Difficulty and engine rules', { exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Hard', exact: true })).toBeVisible()
  await expect(panel.getByText('Enemy HP: 130%. Boss HP: 130%. Player hit modifier: 0 percentage points.', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Sources for base game rules', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Sources for Hard difficulty', exact: true })).toHaveCount(0)
  await panel.getByRole('combobox', { name: 'Platform', exact: true }).selectOption('Linux')
  await panel.getByRole('button', { name: 'Sources for Hard difficulty', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sources for Hard difficulty', exact: true })).toContainText('PC 1.6.9 game data')
  await page.keyboard.press('Escape')
  await expect(panel.getByText('Native Windows PC calculations do not establish parity for Linux.', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Enter exact version', exact: true }).click()
  await panel.getByLabel('Exact game version', { exact: true }).fill('synthetic-2.0')
  await panel.getByRole('combobox', { name: 'Difficulty', exact: true }).selectOption('2')
  await save(page).click()
  await expect(panel.getByText(`Saved revision ${source.revision + 1}`, { exact: true })).toBeVisible()
  const saved = await readData(page)
  const setup = Object.values(saved.gameSetups).find(value => !original.gameSetups[value.id])!
  expect(setup.gameVersion).toEqual({ state: 'known', value: 'synthetic-2.0' })
  expect(setup.platform).toEqual({ state: 'known', value: 'Linux' })
  expect(setup.slots).toEqual(source.slots)
  expect(setup.difficulty).toEqual({ version: 1, selection: { state: 'known', value: 2 } })
  expect(saved.gameSetups[source.id]).toEqual(source)
  expect(saved.buildRevisions).toEqual(original.buildRevisions)
  for (const playthrough of Object.values(original.playthroughs)) if (playthrough.id !== saved.selectedPlaythroughId) expect(saved.playthroughs[playthrough.id]).toEqual(playthrough)
  expect(saved.playthroughs).toEqual(original.playthroughs)
  expect(saved.planningGameSetupRevisionId).toBe(original.planningGameSetupRevisionId)
  await page.reload()
  await expect(panel.getByRole('combobox', { name: 'Game version', exact: true })).toHaveValue('synthetic-2.0')
})

test('saving a setup is independent and applying it to a playthrough is explicit', async ({ page }) => {
  await page.goto('/#/settings/game-setup')
  const panel = settings(page)
  const original = await readData(page)
  const source = original.gameSetups[original.planningGameSetupRevisionId!]!
  await panel.getByRole('button', { name: 'New Game Setup', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Game version', exact: true })).toHaveValue('')
  await expect(panel.getByLabel('Game mode', { exact: true })).toHaveValue('Standard')
  await expect(panel.getByRole('combobox', { name: 'Difficulty', exact: true })).toHaveValue('0')
  await expect(panel.getByRole('combobox', { name: 'Difficulty', exact: true }).locator('option:checked')).toHaveText('Normal')
  await panel.getByLabel('Game Setup label').fill('Synthetic separate setup')
  await panel.getByRole('button', { name: 'Create Game Setup', exact: true }).click()
  await expect(panel.getByText('Saved revision 1', { exact: true })).toBeVisible()
  const saved = await readData(page)
  const setup = Object.values(saved.gameSetups).find(value => !original.gameSetups[value.id])!
  expect(setup.gameSetupId).not.toBe(source.gameSetupId)
  expect(setup.gameVersion).toEqual({ state: 'unknown' })
  expect(setup.mode).toEqual({ state: 'known', value: 'Standard' })
  expect(setup.difficulty).toEqual({ version: 1, selection: { state: 'known', value: 0 } })
  expect(saved.gameSetups[source.id]).toEqual(source)
  expect(saved.playthroughs).toEqual(original.playthroughs)
  expect(saved.planningGameSetupRevisionId).toBe(original.planningGameSetupRevisionId)
  await expect(panel.getByRole('button', { name: 'Saved setups', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await panel.getByRole('button', { name: 'Back to saved setups', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Saved Game Setups', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Playthrough', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('button', { name: 'Saved setups', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(panel.getByRole('combobox', { name: 'Game version', exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/settings\/playthrough$/)
  await panel.getByRole('combobox', { name: 'Game Setup to apply', exact: true }).selectOption(setup.id)
  await expect(panel.locator('.playthrough-game-preview')).toContainText('Synthetic separate setup')
  expect(await readData(page)).toEqual(saved)
  await panel.getByRole('button', { name: `Apply to ${selectedPlaythrough(saved).label}`, exact: true }).click()
  await expect.poll(async () => (await readData(page)).planningGameSetupRevisionId).toBe(setup.id)
  const applied = await readData(page)
  expect(applied.gameSetups).toEqual(saved.gameSetups)
  expect(applied.buildRevisions).toEqual(saved.buildRevisions)
  expect(selectedPlaythrough(applied).scenarios).toEqual(selectedPlaythrough(saved).scenarios)
})

test('applying a saved setup recovers a failed save without changing historical pins', async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await createBlankPlaythrough(page)
  const original = await readData(page)
  const targetId = Object.values(original.gameSetups).find(setup => setup.id !== selectedPlaythrough(original).currentGameSetupRevisionId)!.id
  await page.goto('/#/settings/playthrough')
  const panel = settings(page)
  await panel.getByRole('combobox', { name: 'Game Setup to apply', exact: true }).selectOption(targetId)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = put; throw new DOMException('Synthetic apply failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
  await panel.getByRole('button', { name: /^Apply to / }).click()
  await expect(panel.getByText('Playthrough settings not saved', { exact: true })).toBeVisible()
  expect(await readData(page)).toEqual(original)
  await panel.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Active Playthrough', exact: true })).toBeEnabled()
  const saved = await readData(page)
  expect(selectedPlaythrough(saved).currentGameSetupRevisionId).toBe(targetId)
  expect(saved.gameSetups).toEqual(original.gameSetups)
  expect(saved.buildRevisions).toEqual(original.buildRevisions)
  expect(selectedPlaythrough(saved).characters).toEqual(selectedPlaythrough(original).characters)
  await page.reload()
  await expect(panel.getByRole('combobox', { name: 'Game Setup to apply', exact: true })).toHaveValue(targetId)
})

test('unrelated edits preserve unresolved knowledge and backup round trips', async ({ page }) => {
  const fixture = createSampleLocalData(DEFAULT_CATALOG, '2026-01-01T00:00:00.000Z')
  const id = fixture.planningGameSetupRevisionId!
  const source = { ...fixture.gameSetups[id]!, platform: { state: 'conflicting' as const, claims: [{ value: 'Windows', sources: [{ sourceId: 'synthetic-a' }] }, { value: 'Nintendo Switch', sources: [{ sourceId: 'synthetic-b' }] }] }, gameVersion: { state: 'unknown' as const, reason: 'Synthetic missing version' }, mode: { state: 'notApplicable' as const, reason: 'Synthetic scope' }, difficulty: { version: 1 as const, selection: { state: 'unknown' as const, reason: 'Synthetic missing difficulty', sources: [{ sourceId: 'synthetic-context' }] } }, ppLimit: { state: 'unknown' as const, reason: 'Synthetic missing budget' }, ppCostsNonNegative: { state: 'conflicting' as const, claims: [{ value: true, sources: [{ sourceId: 'synthetic-a' }] }, { value: false, sources: [{ sourceId: 'synthetic-b' }] }] } }
  const localData = { ...fixture, gameSetups: { ...fixture.gameSetups, [id]: source }, changes: [] }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const archive = zipSync({ 'manifest.json': encode({ format: 'crykit-backup', formatVersion: '2.0.0', exportedAt: '2026-01-01T00:00:00.000Z', payload: 'bundle.json', sources: [] }), 'bundle.json': encode({ localData, lineage: { rootLocalDataId: localData.id }, catalogs: [DEFAULT_CATALOG], evidence: [], history: [] }) })
  await page.goto('/#/settings/data')
  const panel = settings(page)
  await panel.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-unresolved.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) })
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  await page.goto('/#/settings/game-setup')
  await settings(page).getByRole('button', { name: 'Edit setup', exact: true }).first().click()
  await expect(panel.getByRole('combobox', { name: 'Difficulty', exact: true })).toHaveValue('')
  await panel.getByLabel('Game Setup label').fill('Synthetic renamed setup')
  await save(page).click()
  await expect(panel.getByText('Saved revision 2', { exact: true })).toBeVisible()
  const saved = await readData(page)
  const setup = Object.values(saved.gameSetups).find(value => !localData.gameSetups[value.id])!
  for (const key of ['platform', 'gameVersion', 'mode', 'difficulty', 'ppLimit', 'ppCostsNonNegative', 'mods'] as const) expect(setup[key]).toEqual(source[key])
  expect(saved.gameSetups[id]).toEqual(source)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const backup = await readFile((await (await download).path())!)
  await panel.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-round-trip.zip', mimeType: 'application/zip', buffer: backup })
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  expect((await readData(page)).gameSetups).toEqual(saved.gameSetups)

})

test('a failed new setup save retries inside the panel and survives offline reload', async ({ page, context }) => {
  await page.goto('/#/settings/storage')
  const panel = settings(page)
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  await prepare.click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Saved setups', exact: true }).click()
  const original = await readData(page)
  await panel.getByRole('button', { name: 'New Game Setup', exact: true }).click()
  await panel.getByLabel('Game Setup label').fill('Synthetic recovered setup')
  await context.setOffline(true)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = put; throw new DOMException('Synthetic storage failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
  await panel.getByRole('button', { name: 'Create Game Setup', exact: true }).click()
  await expect(panel.getByText('Game Setup not saved', { exact: true })).toBeVisible()
  expect((await readData(page)).gameSetups).toEqual(original.gameSetups)
  await panel.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(panel.getByText('Saved revision 1', { exact: true })).toBeVisible()
  await expect(save(page)).toBeDisabled()
  expect((await readData(page)).playthroughs).toEqual(original.playthroughs)
  expect(Object.values((await readData(page)).gameSetups).filter(setup => setup.label === 'Synthetic recovered setup')).toHaveLength(1)
  await page.reload()
  await expect(panel.getByLabel('Game Setup label')).toHaveValue('Synthetic recovered setup')
  await context.setOffline(false)
})

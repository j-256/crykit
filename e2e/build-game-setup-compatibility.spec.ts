import { expect, test, type Page } from '@playwright/test'
import { zipSync } from 'fflate'
import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import { createGameSetupRevision, setPlaythroughGameSetup } from '../src/domain'
import { DEFAULT_GAME_VERSION } from '../src/domain/local-data'
import { createSampleLocalData } from '../src/domain/sample-data'
import type { LocalData } from '../src/domain/types'
import { openGameSetupSection, replacePlannerData } from './local-data-helpers'

const TEST_NOW = '2026-01-01T00:00:00.000Z'
const ALTERNATE_GAME_SETUP = 'Synthetic alternate Game Setup'

function compatibilityFixture(): LocalData {
  let localData = createSampleLocalData(DEFAULT_CATALOG, TEST_NOW)
  const source = localData.gameSetups[localData.planningGameSetupRevisionId!]!
  localData = createGameSetupRevision(localData, {
    label: ALTERNATE_GAME_SETUP,
    platform: source.platform,
    gameVersion: source.gameVersion,
    mode: source.mode,
    mods: source.mods,
    disabledMods: source.disabledMods,
    ppLimit: { state: 'known', value: 20 },
    ppCostsNonNegative: source.ppCostsNonNegative,
    slots: source.slots,
    catalogLock: source.catalogLock,
    definitionOverrides: source.definitionOverrides,
    activate: true,
    now: TEST_NOW,
  })
  localData = setPlaythroughGameSetup(localData, { gameSetupRevisionId: localData.planningGameSetupRevisionId!, now: TEST_NOW })
  return { ...localData, changes: [] }
}

async function loadFixture(page: Page): Promise<void> {
  await page.goto('/')
  const localData = compatibilityFixture()
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const archive = zipSync({
    'manifest.json': encode({ format: 'crykit-backup', formatVersion: '2.0.0', exportedAt: TEST_NOW, payload: 'bundle.json', sources: [] }),
    'bundle.json': encode({ localData, lineage: { rootLocalDataId: localData.id }, catalogs: [DEFAULT_CATALOG], evidence: [], history: [] }),
  })
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-build-compatibility.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) })
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  await page.goto('/#/builds/library')
}

test('the build library is independent of the playthrough and copies rules explicitly', async ({ page }) => {
  await loadFixture(page)
  const library = page.getByRole('region', { name: 'Build library', exact: true })
  await expect(library.locator('.build-card')).toHaveCount(4)
  await expect(page.locator('.build-card--inapplicable')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Game Setup:/ })).toHaveCount(0)
  await library.locator('.build-card__open').first().click()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeEnabled()
  await page.locator('.build-behavior > summary').click()
  const preset = page.getByRole('combobox', { name: 'Copy Game Setup', exact: true })
  await expect(preset.locator('option:checked')).toContainText('Sample starter Game Setup')
  await preset.selectOption({ label: `${ALTERNATE_GAME_SETUP} · r1` })
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await page.goto('/#/builds/library')
  await expect(library.locator('.build-card')).toHaveCount(4)
  await expect(library.locator('.build-card').filter({ hasText: ALTERNATE_GAME_SETUP })).toHaveCount(1)
})

test('new builds reuse Build rules and can explicitly copy the selected playthrough', async ({ page }) => {
  await loadFixture(page)
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  await page.locator('.build-behavior > summary').click()
  await expect(page.getByRole('combobox', { name: 'Copy Game Setup', exact: true }).locator('option:checked')).toContainText('Sample starter Game Setup')
  await openGameSetupSection(page.locator('.build-behavior'), 'Game context')
  await expect(page.getByRole('combobox', { name: 'Platform', exact: true })).toHaveValue('')
  await expect(page.getByRole('combobox', { name: 'Game version', exact: true })).toHaveValue(DEFAULT_GAME_VERSION)
  await page.getByRole('combobox', { name: 'Copy Game Setup', exact: true }).selectOption('playthrough')
  await expect(page.locator('.build-behavior > summary')).toContainText(ALTERNATE_GAME_SETUP)
})

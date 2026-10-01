import { expect, test, type Locator, type Page } from '@playwright/test'
import { zipSync } from 'fflate'
import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import { createGameSetupRevision, setPlaythroughGameSetup } from '../src/domain'
import { createSampleLocalData } from '../src/domain/sample-data'
import type { LocalData } from '../src/domain/types'
import { replacePlannerData } from './local-data-helpers'

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

function cards(section: Locator): Locator {
  return section.locator('.build-card')
}

test('inapplicable Builds remain visible below current Builds with an explanation and direct editing', async ({ page, isMobile }) => {
  await loadFixture(page)
  const groups = page.locator('.build-library-group')
  await expect(groups.locator('.build-library-group__header h2')).toHaveText(['Current Game Setup', 'Other Game Setups'])

  const current = page.getByRole('region', { name: 'Builds for current Game Setup', exact: true })
  const other = page.getByRole('region', { name: 'Builds for other Game Setups', exact: true })
  await expect(current.getByText('No matching Builds for this Game Setup', { exact: true })).toBeVisible()
  await expect(cards(other)).toHaveCount(4)

  const original = cards(other).first()
  const originalTitle = await original.locator('.build-card__open').innerText()
  await expect(original).toHaveClass(/build-card--inapplicable/)
  await expect(original).toHaveCSS('filter', 'grayscale(0.72)')
  await expect(original).toContainText(`Uses Sample starter Game Setup. Current Playthrough uses ${ALTERNATE_GAME_SETUP}.`)

  await original.locator('.build-card__open').click()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Fork to current Game Setup', exact: true })).toHaveCount(0)
  await page.locator('.build-behavior > summary').click()
  const preset = page.getByRole('combobox', { name: 'Behavior preset', exact: true })
  await preset.selectOption({ label: `${ALTERNATE_GAME_SETUP} · r1` })
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  if (isMobile) await page.locator('.build-library > summary').click()
  await expect(cards(current)).toHaveCount(1)
  await expect(cards(current).first()).toContainText(originalTitle)
  await expect(cards(other)).toHaveCount(3)
})

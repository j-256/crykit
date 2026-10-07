import { savedCatalogVersion } from '../src/domain/legacy-definition.test-helpers'
import { skipInitialModSetup, openBuildGameSetup, saveAndApplyGameSetup, openCurrentGameSetup, openGameSetupSection, replacePlannerData } from './local-data-helpers'
import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import { syntheticModLayers } from '../src/domain/mod-layers.test-helpers'
import { coalesceDefinitionOverrides, setPlaythroughGameSetup } from '../src/domain/local-data'
import { createSampleLocalData } from '../src/domain/sample-data'
import type { EntityId, LocalData } from '../src/domain/types'

const MOD_LAYER_BACKUP_JOURNEY_TIMEOUT_MS = 90_000

async function openSettings(page: Page, section: string) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  if (section === 'Game Setup') await openCurrentGameSetup(panel)
  else await panel.getByRole('button', { name: section, exact: true }).click()
  if (section === 'Game Setup') await openGameSetupSection(panel, 'Imported mod files')
  return panel
}

async function exportData(page: Page) {
  const panel = await openSettings(page, 'Import & backup')
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const bytes = await readFile((await (await download).path())!)
  const files = unzipSync(bytes)
  const bundle = JSON.parse(strFromU8(files['bundle.json']!)) as { localData: LocalData }
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return { localData: bundle.localData, bytes }
}

test('ordered mod layers supply effective definitions while saved builds retain their pinned setup offline', async ({ page, context }, testInfo) => {
  // Multiple source imports, a pinned Build, backup, and offline verification share this journey
  test.setTimeout(MOD_LAYER_BACKUP_JOURNEY_TIMEOUT_MS)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const mods = await syntheticModLayers()
  await page.goto('/')
  await skipInitialModSetup(page)
  for (const preview of [mods.first, mods.second]) {
    const panel = await openSettings(page, 'Import & backup')
    await panel.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: preview.filename, mimeType: 'application/json', buffer: Buffer.from(preview.proposed.sources[0]!.bytes) })
    await panel.getByRole('button', { name: 'Add references', exact: true }).click()
    await expect(panel).not.toBeVisible()
  }
  const panel = await openSettings(page, 'Game Setup')
  const layers = panel.getByRole('region', { name: 'Imported mod layers', exact: true })
  await layers.getByRole('combobox', { name: 'Imported mod to add', exact: true }).selectOption('crystal-edit:layer-a')
  await layers.getByRole('button', { name: 'Add mod layer', exact: true }).click()
  await layers.getByRole('combobox', { name: 'Imported mod to add', exact: true }).selectOption('crystal-edit:layer-b')
  await layers.getByRole('button', { name: 'Add mod layer', exact: true }).click()
  await expect(layers.getByLabel('Effective mod summary', { exact: true })).toHaveText('5 effective imported records · 5 with replacements · 0 bundled targets unresolved')
  await layers.getByText('Review effective records and replacement links', { exact: true }).click()
  await layers.getByRole('button', { name: 'Bundled target for Second Fighter', exact: true }).click()
  const link = page.getByRole('dialog', { name: 'Link Second Fighter', exact: true })
  await link.getByLabel('Search bundled replacements', { exact: true }).fill('Warrior')
  await link.getByRole('button', { name: 'Warrior', exact: true }).click()
  await expect(layers.getByRole('button', { name: 'Bundled target for Second Fighter', exact: true })).toHaveText('Replaces Warrior')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await page.screenshot({ path: testInfo.outputPath('mod-layer-priority-and-links.png'), fullPage: true })
  const oldSetupHeading = await panel.locator('.game-setup-context p').filter({ hasText: /revision/ }).innerText()
  await saveAndApplyGameSetup(panel)
  await expect(panel.locator('.game-setup-context p').filter({ hasText: /revision/ })).not.toHaveText(oldSetupHeading)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await page.goto('/#/builds/library/new')
  await openBuildGameSetup(page)
  await page.getByRole('combobox', { name: 'Copy Game Setup', exact: true }).selectOption('playthrough')
  await page.getByLabel('Build title').fill('Pinned mod build')
  const primary = page.getByRole('combobox', { name: 'Class', exact: true })
  await primary.fill('Second Fighter')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Second Fighter$/ }) }).click()
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pinned mod build', exact: true })).toBeVisible()
  const old = await exportData(page)
  const build = Object.values(old.localData.builds).find(value => value.title === 'Pinned mod build')!
  const oldRevision = old.localData.buildRevisions[build.latestRevisionId!]!
  expect(oldRevision.content.primaryClass).toMatchObject({ catalogId: DEFAULT_CATALOG.id, entityId: 'base:job:0' })
  const changed = await openSettings(page, 'Game Setup')
  await changed.getByRole('button', { name: 'Move Layer B earlier', exact: true }).click()
  const priorHeading = await changed.locator('.game-setup-context p').filter({ hasText: /revision/ }).innerText()
  await saveAndApplyGameSetup(changed)
  await expect(changed.locator('.game-setup-context p').filter({ hasText: /revision/ })).not.toHaveText(priorHeading)
  await changed.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(changed).not.toBeVisible()
  const newer = await exportData(page)
  expect(newer.localData.buildRevisions[oldRevision.id]).toEqual(oldRevision)
  expect(newer.localData.gameSetups[newer.localData.planningGameSetupRevisionId!]!.modComposition?.layers.map(layer => layer.catalogId)).toEqual(['crystal-edit:layer-b', 'crystal-edit:layer-a'])
  await page.goto('/#/builds/library/new')
  await openBuildGameSetup(page)
  await page.getByRole('combobox', { name: 'Copy Game Setup', exact: true }).selectOption('playthrough')
  await primary.fill('Fighter')
  const options = page.getByRole('listbox', { name: 'Choose Class', exact: true })
  await expect(options.getByRole('option').filter({ has: page.locator('strong', { hasText: /^First Fighter$/ }) })).toBeVisible()
  await expect(options.getByRole('option').filter({ has: page.locator('strong', { hasText: /^Second Fighter$/ }) })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Cancel and discard', exact: true }).click()
  const offline = await openSettings(page, 'Offline & storage')
  await offline.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(offline)
  await offline.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  const reloaded = await openSettings(page, 'Game Setup')
  await expect(reloaded.getByLabel('Enable Layer A', { exact: true })).toBeChecked()
  await expect(reloaded.getByLabel('Enable Layer B', { exact: true })).toBeChecked()
  await expect(reloaded.getByRole('list', { name: 'Mod priority', exact: true }).locator('li').first()).toContainText('Layer B')
  expect(errors).toEqual([])
})

test('changing layers requires an explicit personal override decision and label edits retain the effective catalog', async ({ page }) => {
  const mods = await syntheticModLayers()
  const source = createSampleLocalData(DEFAULT_CATALOG)
  const override = savedCatalogVersion(source, [DEFAULT_CATALOG], { sourceRef: { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:job:0' as EntityId }, name: 'Personal fighter' })
  const pinned = coalesceDefinitionOverrides(override.localData, { sourceGameSetupRevisionId: source.planningGameSetupRevisionId!, definitionRefs: [override.ref], activate: true })
  const localData = setPlaythroughGameSetup(pinned, { gameSetupRevisionId: pinned.planningGameSetupRevisionId! })
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const archive = zipSync({
    'manifest.json': encode({ format: 'crykit-backup', formatVersion: '2.0.0', exportedAt: localData.updatedAt, payload: 'bundle.json', sources: [] }),
    'bundle.json': encode({ localData: { ...localData, changes: [] }, lineage: { rootLocalDataId: localData.id }, catalogs: [DEFAULT_CATALOG], evidence: [], history: [] }),
  })
  await page.goto('/')
  await skipInitialModSetup(page)
  const importing = await openSettings(page, 'Import & backup')
  await importing.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-mod-overrides.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) })
  await replacePlannerData(importing)
  await expect(importing).not.toBeVisible()
  const adding = await openSettings(page, 'Import & backup')
  await adding.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: mods.first.filename, mimeType: 'application/json', buffer: Buffer.from(mods.first.proposed.sources[0]!.bytes) })
  await adding.getByRole('button', { name: 'Add references', exact: true }).click()
  await expect(adding).not.toBeVisible()
  const panel = await openSettings(page, 'Game Setup')
  await panel.getByRole('button', { name: 'Add mod layer', exact: true }).click()
  await expect(panel.getByText('Review personal override pins', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Save Game Setup', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: 'Use layer definitions for these records', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Save Game Setup', exact: true })).toBeEnabled()
  const initialHeading = await panel.locator('.game-setup-context p').filter({ hasText: /revision/ }).innerText()
  await saveAndApplyGameSetup(panel)
  await expect(panel.locator('.game-setup-context p').filter({ hasText: /revision/ })).not.toHaveText(initialHeading)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const saved = await exportData(page)
  const layered = saved.localData.gameSetups[saved.localData.planningGameSetupRevisionId!]!
  expect(layered.definitionOverrides).toEqual([])
  expect(saved.localData.gameSetups[pinned.planningGameSetupRevisionId!]!.definitionOverrides).toEqual([override.ref])
  expect(saved.localData.personalDefinitions[override.ref.definitionId]).toEqual(override.definition)
  const editing = await openSettings(page, 'Game Setup')
  await editing.getByLabel('Game Setup label').fill('Renamed mod setup')
  await saveAndApplyGameSetup(editing)
  await expect(editing.getByRole('button', { name: 'Save Game Setup', exact: true })).toBeDisabled()
  await expect(editing.getByLabel('Game Setup label')).toHaveValue('Renamed mod setup')
  await editing.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const renamed = await exportData(page)
  expect(renamed.localData.gameSetups[renamed.localData.planningGameSetupRevisionId!]!.catalogLock).toEqual(layered.catalogLock)
})

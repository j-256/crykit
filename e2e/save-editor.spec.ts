import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { decodeCrystalSave, encodeCrystalSave, type CrystalSave } from '../src/interchange/crystal-save'
import { SYNTHETIC_SAVE_MOD, createModdedSaveEditorFixture, createSaveEditorFixture, createSaveEditorModProjectFixture, setSaveEditorFixtureMode, setSaveEditorFixtureRandomizer } from '../src/domain/save-editor.fixture'
import { SAVE_EDITOR_CATALOG } from '../src/catalog/save-editor'
import { inspectSave } from '../src/domain/save-editor'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectOfflineReady } from './offline-helpers'
import { skipInitialModSetup } from './local-data-helpers'

const ROUTE = '/#/save-editor'
const FILENAME = 'synthetic-party.sav'

async function openSave(page: Page, save = createSaveEditorFixture()) {
  const bytes = Buffer.from(encodeCrystalSave(save))
  await page.getByLabel('Open Crystal Project save', { exact: true }).setInputFiles({ name: FILENAME, mimeType: 'application/octet-stream', buffer: bytes })
  await expect(page.getByRole('heading', { name: FILENAME, exact: true })).toBeVisible()
  return bytes
}

async function downloadSave(page: Page, name: string) {
  const event = page.waitForEvent('download')
  await page.getByRole('button', { name, exact: true }).first().click()
  const download = await event
  return { bytes: await readFile((await download.path())!), filename: download.suggestedFilename() }
}

function expectPreserved(original: CrystalSave, edited: CrystalSave) {
  expect(edited.combatBytes).toEqual(original.combatBytes)
  expect(edited.maps).toEqual(original.maps)
  expect(edited.header.playTime).toEqual(original.header.playTime)
  expect(edited.header.homePointName).toBe(original.header.homePointName)
}

test('loadout pickers grant missing prerequisites and highlight them before applying and exporting', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(ROUTE)
  const fixture = createSaveEditorFixture()
  const learnedJobs = fixture.members[0]!.value.LearnedJobs
  if (learnedJobs?.type !== 'array') throw new Error('Expected synthetic class progression')
  learnedJobs.value[4] = { type: 'int32', value: 0 }
  const original = decodeCrystalSave(await openSave(page, fixture))
  const choose = async (field: string, name: string) => {
    const input = page.getByRole('combobox', { name: field, exact: true })
    await input.click()
    await input.fill(name)
    await page.getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click()
  }
  await choose('Class', 'Cleric')
  await choose('Main hand', String(SAVE_EDITOR_CATALOG.records.equipment.get(5)!.Name))
  await choose('Equipped passive 1', String(SAVE_EDITOR_CATALOG.records.passive.get(0)!.Name))
  const additions = page.getByLabel('New loadout additions', { exact: true })
  await expect(additions).toContainText('Cleric unlocked')
  await expect(additions).toContainText('learned')
  await expect(additions).toContainText('copy added')
  await page.getByRole('button', { name: 'Review loadout changes', exact: true }).click()
  const review = page.locator('.save-editor__preview')
  await expect(review.locator('li[data-added]').first()).toContainText('New')
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click()
  await expect(page.locator('.save-editor__review li[data-added]').first()).toContainText('Cleric unlocked')
  const edited = decodeCrystalSave((await downloadSave(page, 'Export edited save')).bytes)
  expect(inspectSave(edited, SAVE_EDITOR_CATALOG).members[0]).toMatchObject({ jobId: 4, subJobId: null, equipmentIds: [5, null, null, null, null, null], passiveIds: [0] })
  expect(edited.members.slice(1)).toEqual(original.members.slice(1))
  expectPreserved(original, edited)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

for (const version of [3, 12, 27]) test(`edits legacy format ${version} and exports its original layout`, { tag: version === 3 ? MOBILE_TEST_TAG : [] }, async ({ page }) => {
  await page.goto(ROUTE)
  const fixture = createSaveEditorFixture(version)
  fixture.header.invertedVersion = version === 3
  const original = decodeCrystalSave(await openSave(page, fixture))
  await expect(page.getByText('Not stored in this format', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Review overpowered preset', exact: true }).click()
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click()
  const output = (await downloadSave(page, 'Export edited save')).bytes
  const edited = decodeCrystalSave(output)
  expect(edited.header.version).toBe(version)
  expect(edited.header.lastUpdated).toBeNull()
  expect(edited.header.members[0]!.level).toBe(99)
  expect(output[0]).toBe(version === 3 ? 252 : version)
  expectPreserved(original, edited)
})

for (const [patchMode, name] of [[1, 'Vanilla'], [2, 'Chaos']] as const) test(`edits a nonrandomized ${name} mode save`, { tag: patchMode === 2 ? MOBILE_TEST_TAG : [] }, async ({ page }) => {
  await page.goto(ROUTE)
  await openSave(page, setSaveEditorFixtureMode(createSaveEditorFixture(), patchMode))
  await expect(page.getByRole('definition').filter({ hasText: name })).toBeVisible()
  await expect(page.getByText('Read-only save', { exact: true })).toHaveCount(0)
  await page.getByLabel('Copper', { exact: true }).fill('456')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  const edited = decodeCrystalSave((await downloadSave(page, 'Export edited save')).bytes)
  expect(edited.header).toMatchObject({ patchMode, currencyAmount: 456 })
  expect(edited.party.value.GameplayFlags).toMatchObject({ type: 'document', value: { PatchMode: { value: patchMode } } })
})

test('edits a randomized Chaos save without changing its randomizer state', async ({ page }) => {
  await page.goto(ROUTE)
  const save = setSaveEditorFixtureRandomizer(setSaveEditorFixtureMode(createSaveEditorFixture(), 2), { flags: { Equipment: true } })
  const mapping = structuredClone(save.party.value.RandomizerMapping)
  const flags = structuredClone(save.party.value.RandomizerFlags)
  if (mapping?.type !== 'document' || flags?.type !== 'document') throw new Error('Expected synthetic randomizer state')
  await openSave(page, save)
  await expect(page.getByRole('definition').filter({ hasText: 'Chaos' })).toBeVisible()
  await expect(page.getByRole('definition').filter({ hasText: 'Enabled' })).toBeVisible()
  await expect(page.getByText('Read-only save', { exact: true })).toHaveCount(0)
  await page.getByLabel('Copper', { exact: true }).fill('456')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  const edited = decodeCrystalSave((await downloadSave(page, 'Export edited save')).bytes)
  expect(edited.header).toMatchObject({ patchMode: 2, randomizerFlags: 8, currencyAmount: 456 })
  expect(edited.party.value.RandomizerFlags).toMatchObject({ type: 'document', value: flags.value })
  expect(edited.party.value.RandomizerMapping).toMatchObject({ type: 'document', value: mapping.value })
})

test('opens, edits, and downloads a separate save with exact original recovery', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await skipInitialModSetup(page)
  await page.getByRole('button', { name: 'Save Editor', exact: true }).filter({ visible: true }).click()
  await expect(page.getByRole('heading', { name: 'Save Editor', exact: true })).toBeVisible()
  const originalBytes = await openSave(page)
  const original = decodeCrystalSave(originalBytes)
  const facts = page.getByRole('region', { name: 'Open save details', exact: true })
  for (const label of ['Saved date', 'Play time', 'Game mode', 'Randomizer', 'Party', 'Level cap', 'Original size', 'Save format', 'Editing rules']) await expect(facts.getByRole('term').filter({ hasText: label })).toBeVisible()
  await expect(facts.getByRole('button', { name: 'Download original', exact: true })).toBeVisible()
  await expect(facts.getByRole('button', { name: 'Reset to original', exact: true })).toBeVisible()
  await expect(page.locator('.context-bar').getByRole('button', { name: 'Export edited save', exact: true })).toBeInViewport()
  expect((await downloadSave(page, 'Download original')).bytes).toEqual(originalBytes)
  expect((await downloadSave(page, 'Export edited save')).bytes).toEqual(originalBytes)

  await page.getByLabel('Copper', { exact: true }).fill('123456')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  const applied = page.locator('.save-editor__review')
  await expect(applied).toHaveAttribute('open', '')
  await expect(applied.getByRole('listitem').filter({ hasText: 'copper' })).toBeVisible()
  await page.getByLabel('Member 1 name', { exact: true }).fill('Synthetic Hero')
  await page.getByRole('button', { name: 'Apply name & level', exact: true }).click()
  await page.getByRole('button', { name: 'Clear Main hand', exact: true }).click()
  await page.getByRole('button', { name: 'Review loadout changes', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Review bulk changes', exact: true })).toContainText('equipped loadout updated and inventory reconciled')
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click()
  await page.getByLabel('Search inventory', { exact: true }).fill('Potion')
  await page.getByLabel('Potion stock', { exact: true }).fill('7')
  await page.getByRole('button', { name: 'Apply Potion stock', exact: true }).click()
  await expect(page.getByText('Changes not exported', { exact: true })).toBeVisible()

  const download = await downloadSave(page, 'Export edited save')
  expect(download.filename).toBe('synthetic-party-edited.sav')
  const edited = decodeCrystalSave(download.bytes)
  expect(edited.header.currencyAmount).toBe(123456)
  expect(edited.header.members[0]!.name).toBe('Synthetic Hero')
  expect(edited.members[0]!.value.Name).toMatchObject({ type: 'string', value: 'Synthetic Hero' })
  expect(edited.members[0]!.value.Equipment).toMatchObject({ type: 'array', value: [{ type: 'null' }, { type: 'null' }, { type: 'null' }, { type: 'null' }, { type: 'null' }, { type: 'null' }] })
  expect(edited.party.value.Currency).toMatchObject({ type: 'document', value: { Val: { value: 123456 } } })
  expect(edited.party.value.Items).toMatchObject({ type: 'document', value: { Stock: { type: 'array', value: expect.arrayContaining([expect.objectContaining({ type: 'document', value: expect.objectContaining({ Item: expect.objectContaining({ value: 0 }), Count: expect.objectContaining({ value: 7 }) }) })]) } } })
  expectPreserved(original, edited)
  expect((await downloadSave(page, 'Download original')).bytes).toEqual(originalBytes)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(errors).toEqual([])
})

test('reviews the overpowered preset before applying and preserves equipped loadouts', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(ROUTE)
  const original = decodeCrystalSave(await openSave(page))
  await page.getByRole('button', { name: 'Review overpowered preset', exact: true }).click()
  const review = page.getByRole('region', { name: 'Review bulk changes', exact: true })
  await expect(review).toContainText('99')
  await expect(page.getByLabel('Copper', { exact: true })).toHaveValue('123')
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click()
  await expect(page.getByLabel('Member 1 level', { exact: true })).toHaveValue('5')
  await page.getByRole('button', { name: 'Review overpowered preset', exact: true }).click()
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click()
  const edited = decodeCrystalSave((await downloadSave(page, 'Export edited save')).bytes)
  expect(edited.header.currencyAmount).toBe(999999999)
  expect(edited.header.assistFlags & 128).toBe(128)
  for (let index = 0; index < edited.members.length; index++) {
    expect(edited.header.members[index]!.level).toBe(99)
    expect(edited.members[index]!.value.Equipment).toEqual(original.members[index]!.value.Equipment)
    expect(edited.members[index]!.value.Passives).toEqual(original.members[index]!.value.Passives)
  }
  expectPreserved(original, edited)
})

test('retains pending input and the loaded save after rejected edits or malformed replacement', async ({ page }) => {
  await page.goto(ROUTE)
  const originalBytes = await openSave(page)
  await page.getByLabel('Copper', { exact: true }).fill('12.5')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  await expect(page.getByText(/Copper must be a whole number/)).toBeVisible()
  await expect(page.getByLabel('Copper', { exact: true })).toHaveValue('12.5')
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  await expect(page.getByText('Unsaved edits are still open', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Export and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Save Editor', exact: true })).toBeVisible()
  await expect(page.getByText(/Apply or discard pending fields and loadout choices before exporting/)).toBeVisible()
  await page.getByRole('button', { name: 'Discard pending input', exact: true }).click()
  await page.getByLabel('Open Crystal Project save', { exact: true }).setInputFiles({ name: 'broken.sav', mimeType: 'application/octet-stream', buffer: Buffer.from([28, 0, 0, 0]) })
  await expect(page.getByText(/The open draft has not changed/)).toBeVisible()
  expect((await downloadSave(page, 'Download original')).bytes).toEqual(originalBytes)
  await page.getByLabel('Copper', { exact: true }).fill('500')
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
})

test('exports a valid draft before continuing away from the editor', async ({ page }) => {
  await page.goto(ROUTE)
  await openSave(page)
  await page.getByLabel('Copper', { exact: true }).fill('456')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  const download = await downloadSave(page, 'Export and continue')
  expect(decodeCrystalSave(download.bytes).header.currencyAmount).toBe(456)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
})

test('keeps modded saves read-only with the exact original download', async ({ page }) => {
  await page.goto(ROUTE)
  const modded = createSaveEditorFixture()
  modded.header.isModded = true
  const bytes = await openSave(page, modded)
  await expect(page.getByText('Read-only save', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export edited save', exact: true }).first()).toBeDisabled()
  expect((await downloadSave(page, 'Download original')).bytes).toEqual(bytes)
})

test('loads an exact mod definition, edits the active save, and removes its mod state', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(ROUTE)
  await openSave(page, createModdedSaveEditorFixture({ equipped: true }))
  await expect(page.getByText('Definition required', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Copper', { exact: true })).toBeDisabled()
  await page.getByLabel('Add Crystal Edit mod definitions', { exact: true }).setInputFiles({ name: 'synthetic-save-mod.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(createSaveEditorModProjectFixture())) })
  await expect(page.getByText('Imported definition matched', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Synthetic Save Mod definition available', { exact: true })).toBeChecked()
  await expect(page.getByLabel('Copper', { exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: 'Class', exact: true }).click()
  await expect(page.getByRole('option', { name: /Synthetic mod class/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByLabel('Copper', { exact: true }).fill('654')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  const modded = decodeCrystalSave((await downloadSave(page, 'Export edited save')).bytes)
  expect(modded.header.currencyAmount).toBe(654)
  expect(modded.header.isModded).toBe(true)
  expect(modded.header.mods).toHaveLength(1)

  await page.getByRole('button', { name: 'Review mod data removal', exact: true }).click()
  const review = page.getByRole('region', { name: 'Review bulk changes', exact: true })
  await expect(review).toContainText('equipped mod-only passives removed')
  await expect(review).toContainText('ID redirects cleared')
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click()
  const vanilla = decodeCrystalSave((await downloadSave(page, 'Export edited save')).bytes)
  expect(vanilla.header.currencyAmount).toBe(654)
  expect(vanilla.header.isModded).toBe(false)
  expect(vanilla.header.mods).toEqual([])
  expect(vanilla.header.modIdMaps).toEqual([])
})

test('identifies imported disabled-mod residue by exact project identity', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(ROUTE)
  await openSave(page, createModdedSaveEditorFixture({ active: false, equipped: true, mod: SYNTHETIC_SAVE_MOD }))
  await page.getByLabel('Add Crystal Edit mod definitions', { exact: true }).setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(createSaveEditorModProjectFixture())) })
  await expect(page.getByLabel('Synthetic Save Mod definition available', { exact: true })).toBeChecked()
  await expect(page.getByText(/Saved revision unavailable/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review mod data removal', exact: true })).toBeEnabled()
})

test('edits and exports offline without persisting the opened game save', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  await page.goto(ROUTE)
  await openSave(page)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.goto(ROUTE)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Choose a save file', exact: true })).toBeVisible()
  await openSave(page)
  await page.getByLabel('Copper', { exact: true }).fill('789')
  await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
  const downloaded = await downloadSave(page, 'Export edited save')
  expect(decodeCrystalSave(downloaded.bytes).header.currencyAmount).toBe(789)
})

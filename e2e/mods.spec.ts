import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { STARTER_CATALOG } from '../src/catalog/starter'
import { CONFIRMED_SWITCH_MOD_SETUP, SWITCH_MOD_PACKS } from '../src/catalog/mods'
import { asId, captureCharacter, createCharacter, setPlaythroughGameSetup, updateGameSetupRevision } from '../src/domain'
import { createTestLocalData, HAND_SLOT, known, TEST_NOW, TEST_GAME_SETUP_REVISION_ID } from '../src/domain/test-helpers'
import type { CatalogRef, CharacterId, EntityId, LocalData } from '../src/domain/types'
import { selectedPlaythrough, openGameSetupSection, openSwitchModPacks, replacePlannerData } from './local-data-helpers'

const CHARACTER = asId<CharacterId>('synthetic-mod-rowan')
const SHIELD: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: asId<EntityId>('mod-pack-2:item:doge-shield') }
const BACKBREAKER: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: asId<EntityId>('equipment-expansion:item:backbreaker') }

function backup(localData: LocalData): Uint8Array {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  return zipSync({ 'manifest.json': encode({ format: 'crystal-companion-backup', formatVersion: '2.0.0', exportedAt: TEST_NOW, payload: 'bundle.json', sources: [] }), 'bundle.json': encode({ localData: { ...localData, changes: [] }, lineage: { rootLocalDataId: localData.id }, catalogs: [STARTER_CATALOG], evidence: [], history: [] }) })
}

async function dataPanel(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportLocalData(page: Page): Promise<LocalData> {
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const bytes = await readFile((await (await downloaded).path())!)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return (JSON.parse(strFromU8(unzipSync(bytes)['bundle.json'])) as { localData: LocalData }).localData
}

async function importBackup(page: Page, bytes: Uint8Array) {
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-mods.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) })
  await expect(panel.getByText('native-backup-2.0.0', { exact: true })).toBeVisible()
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
}

async function search(page: Page, query: string) {
  await page.getByRole('button', { name: /^(Search|Search planner)$/ }).filter({ visible: true }).click()
  const palette = page.getByRole('dialog', { name: 'Search Crystal Companion', exact: true })
  await palette.getByRole('searchbox').fill(query)
  return palette
}

test('recorded mod help opens settings and preserves the snapshot after a mod choice changes', async ({ page, isMobile }) => {
  const original = createTestLocalData()
  let localData = updateGameSetupRevision(original, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, catalogLock: { [STARTER_CATALOG.id]: STARTER_CATALOG.revisionId }, slots: original.gameSetups[TEST_GAME_SETUP_REVISION_ID].slots.map(slot => ({ ...slot, label: slot.id === HAND_SLOT ? 'Accessory 1' : slot.label })) })
  localData = createCharacter(localData, { id: CHARACTER, name: 'Synthetic Rowan', now: TEST_NOW })
  localData = captureCharacter(localData, { characterId: CHARACTER, level: known(12), displayedStats: {}, equipment: { [HAND_SLOT]: BACKBREAKER }, now: TEST_NOW })
  localData = { ...localData, changes: [] }
  await page.goto('/')
  await importBackup(page, backup(localData))
  await page.goto(`/#/characters/${CHARACTER}/current`)
  const help = page.locator('.member-menu .recorded-mod')
  const summary = help.locator('summary')
  await expect(summary.locator('[data-mod-badge="Equipment Expansion"] .badge')).toHaveText('Mod: Equipment Expansion')
  await expect(summary.locator('.mod-badge__state')).toHaveText('Enabled status not recorded')
  if (isMobile) await summary.tap()
  else {
    await summary.focus()
    await page.keyboard.press('Enter')
  }
  await expect(help).toHaveAttribute('open', '')
  await expect(help).toContainText('This entry comes from the Equipment Expansion mod.')
  await expect(help).toContainText('This snapshot does not record whether that mod was enabled in your game.')
  await expect(help).toContainText('This label does not check whether a selection fits its slot.')
  await expect(help).toContainText('then capture a new character snapshot')
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await help.getByRole('link', { name: 'Data & settings > Game Setup', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await openSwitchModPacks(settings)
  await expect(settings.getByRole('combobox', { name: 'Equipment Expansion', exact: true })).toHaveValue('unknown')
  await settings.getByRole('combobox', { name: 'Equipment Expansion', exact: true }).selectOption('enabled')
  await settings.getByRole('button', { name: 'Save new Game Setup revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/characters/${CHARACTER}/current$`))
  await expect(summary.locator('[data-mod-badge="Equipment Expansion"] .badge')).toHaveText('Mod: Equipment Expansion')
  await expect(summary.locator('.mod-badge__state')).toHaveText('Enabled status not recorded')
  await expect(page.getByText('Slot context has changed', { exact: true })).toBeVisible()
  expect(selectedPlaythrough(await exportLocalData(page)).characters).toEqual(selectedPlaythrough(localData).characters)
})

test('mod settings control search and choices while sheets retain recorded context across backup restore', async ({ page }) => {
  let localData = updateGameSetupRevision(createTestLocalData(), { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, mods: known(['Doge Shield']), disabledMods: known(['Equipment Expansion']), catalogLock: { [STARTER_CATALOG.id]: STARTER_CATALOG.revisionId } })
  localData = setPlaythroughGameSetup(localData, { gameSetupRevisionId: localData.planningGameSetupRevisionId!, now: TEST_NOW })
  localData = createCharacter(localData, { id: CHARACTER, name: 'Synthetic Rowan', now: TEST_NOW })
  localData = captureCharacter(localData, { characterId: CHARACTER, level: known(12), displayedStats: {}, equipment: { [HAND_SLOT]: SHIELD }, note: 'Synthetic mod observation', now: TEST_NOW })
  localData = captureCharacter(localData, { characterId: CHARACTER, level: known(14), displayedStats: {}, equipment: { [HAND_SLOT]: SHIELD }, note: 'Synthetic later mod observation', now: '2026-01-03T00:00:00.000Z' })
  localData = { ...localData, changes: [] }
  await page.goto('/')
  await importBackup(page, backup(localData))
  let palette = await search(page, 'Doge Shield')
  await expect(palette.locator('.universal-search__result')).toHaveCount(1)
  await page.keyboard.press('Escape')
  palette = await search(page, 'Heavy Edge')
  await expect(palette.locator('.universal-search__result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  const settings = await dataPanel(page)
  await settings.getByRole('button', { name: 'Game Setup', exact: true }).click()
  await openSwitchModPacks(settings)
  await expect(settings.getByRole('combobox', { name: 'Doge Shield', exact: true })).toHaveValue('enabled')
  await settings.getByRole('combobox', { name: 'Doge Shield', exact: true }).selectOption('disabled')
  await settings.getByRole('combobox', { name: 'Bloodmage', exact: true }).selectOption('enabled')
  await settings.getByRole('combobox', { name: 'Equipment Expansion', exact: true }).selectOption('unknown')
  await settings.getByRole('button', { name: 'Save new Game Setup revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.goto(`/#/characters/${CHARACTER}/current`)
  await expect(page.locator('.member-slot-warning [data-mod-badge="Doge Shield"][data-mod-state="enabled"]')).toBeVisible()
  await page.locator('.member-record > summary').filter({ hasText: 'Observation details' }).click()
  await expect(page.locator('.recorded-sheet')).toContainText('Equipment Expansion')
  await page.getByRole('link', { name: 'Doge Shield', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Doge Shield', exact: true })).toBeVisible()
  await expect(page.getByText('Mod: Doge Shield', { exact: true })).toBeVisible()
  await expect(page.locator('[data-mod-badge="Doge Shield"][data-mod-state="disabled"]')).toContainText('Disabled')
  await page.goto('/#/reference')
  const referenceSearch = page.getByRole('searchbox', { name: 'Search reference', exact: true })
  if (!await referenceSearch.isVisible()) await page.getByRole('button', { name: /Refine|Filters/ }).click()
  await referenceSearch.fill('Doge Shield')
  await expect(page.locator('button.reference-card')).toHaveCount(0)
  await referenceSearch.fill('Heavy Edge')
  await expect(page.locator('button.reference-card')).toHaveCount(1)
  await expect(page.locator('button.reference-card').getByText('Mod: Equipment Expansion', { exact: true })).toBeVisible()
  await expect(page.locator('button.reference-card')).toContainText('Enabled status not recorded')
  palette = await search(page, 'Doge Shield')
  await expect(palette.locator('.universal-search__result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  palette = await search(page, 'Bloodmage')
  const bloodmageResult = palette.locator('.universal-search__result').filter({ hasText: 'Bloodmage' })
  await expect(bloodmageResult).toHaveCount(1)
  await expect(bloodmageResult.locator('[data-mod-badge="Bloodmage"][data-mod-state="enabled"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.goto(`/#/characters/${CHARACTER}/current`)
  await page.getByRole('button', { name: 'Capture snapshot', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
  await form.getByRole('button', { name: 'Choose Hand', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose Hand', exact: true })
  await picker.getByRole('button', { name: /^Unknown/ }).click()
  await form.getByRole('button', { name: 'Choose Hand', exact: true }).click()
  await picker.getByRole('searchbox').fill('Doge Shield')
  await expect(picker.locator('[data-definition-result="true"]').filter({ hasText: 'Doge Shield' })).toHaveCount(0)
  await picker.getByRole('searchbox').fill('Heavy Edge')
  await expect(picker.locator('[data-definition-result="true"]').filter({ hasText: 'Heavy Edge' })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: 'Compare snapshots', exact: true }).click()
  await page.getByLabel('Show unchanged fields', { exact: true }).check()
  await expect(page.getByRole('region', { name: 'Hand', exact: true }).locator('[data-mod-badge="Doge Shield"][data-mod-state="enabled"]')).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const bytes = await readFile((await (await downloaded).path())!)
  const saved = (JSON.parse(strFromU8(unzipSync(bytes)['bundle.json'])) as { localData: LocalData }).localData
  expect(selectedPlaythrough(saved).characters).toEqual(selectedPlaythrough(localData).characters)
  expect(saved.gameSetups[saved.planningGameSetupRevisionId!].disabledMods).toEqual(known(['Doge Shield']))
  expect(saved.gameSetups[localData.planningGameSetupRevisionId!].mods).toEqual(known(['Doge Shield']))
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await importBackup(page, bytes)
  await page.reload()
  palette = await search(page, 'Doge Shield')
  await expect(palette.locator('.universal-search__result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.goto(`/#/characters/${CHARACTER}/current`)
  await expect(page.locator('.member-slot-warning [data-mod-badge="Doge Shield"][data-mod-state="enabled"]')).toBeVisible()
})

test('fixed Switch choices start unknown, apply the confirmed setup, and recover an offline save failure', async ({ page, context }) => {
  const externalRequests: string[] = []
  const appOrigin = new URL(test.info().project.use.baseURL!).origin
  page.on('request', request => { if (new URL(request.url()).origin !== appOrigin) externalRequests.push(request.url()) })
  await page.goto('/')
  let panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expect(panel.getByText('Offline ready', { exact: true })).toBeVisible({ timeout: 15_000 })
  await panel.getByRole('button', { name: 'Game Setup', exact: true }).click()
  await openSwitchModPacks(panel)
  await expect(panel.locator('textarea')).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: 'Mods', exact: true }).locator('..').locator('..')).toContainText(`0 of ${SWITCH_MOD_PACKS.flatMap(pack => pack.mods).length} enabled`)
  await openGameSetupSection(panel, 'Game context')
  const platform = panel.getByRole('combobox', { name: 'Platform', exact: true })
  const version = panel.getByRole('combobox', { name: /^Game version/ })
  const mode = panel.getByRole('combobox', { name: 'Game mode', exact: true })
  await expect(platform.locator('option')).toHaveText(['Not set', 'Nintendo Switch', 'PC (Windows, macOS, or Linux)'])
  await expect(version.locator('option')).toHaveText(['< 1.6.6', '1.6.6', '> 1.6.6'])
  await expect(version).toHaveValue('1.6.6')
  await expect(mode.locator('option')).toHaveText(['Not set', 'Standard', 'Vanilla', 'Chaos'])
  await expect(panel.getByLabel('Exact game version', { exact: true })).toHaveCount(0)
  await platform.selectOption('Nintendo Switch')
  await expect(version.locator('option')).toHaveText(['< 1.6.6', '1.6.6', '> 1.6.6'])
  await platform.selectOption('PC')
  await expect(version.locator('option')).toHaveText(['< 1.6.6', '1.6.6', '> 1.6.6'])
  for (const pack of SWITCH_MOD_PACKS) {
    const group = panel.locator('.game-setup-mod-pack').filter({ hasText: pack.name })
    await expect(group.locator(':scope > summary small')).toHaveText(`0 of ${pack.mods.length} enabled · ${pack.mods.length} need review`)
    await expect(group.getByRole('combobox')).toHaveCount(pack.mods.length)
    for (const name of pack.mods) await expect(group.getByRole('combobox', { name, exact: true })).toHaveValue('unknown')
  }
  await panel.getByLabel('Game Setup label', { exact: false }).fill('Synthetic Switch choices')
  await panel.getByRole('button', { name: 'Apply Nintendo eShop defaults', exact: true }).click()
  for (const name of CONFIRMED_SWITCH_MOD_SETUP.enabledMods) await expect(panel.getByRole('combobox', { name, exact: true })).toHaveValue('enabled')
  for (const name of CONFIRMED_SWITCH_MOD_SETUP.disabledMods) await expect(panel.getByRole('combobox', { name, exact: true })).toHaveValue('disabled')
  await expect(platform).toHaveValue('Nintendo Switch')
  await expect(version).toHaveValue('1.6.6')
  const shield = panel.getByRole('combobox', { name: 'Doge Shield', exact: true })
  await shield.focus()
  await shield.press('d')
  await shield.press('Tab')
  await expect(shield).toHaveValue('disabled')
  await panel.getByRole('combobox', { name: 'Pointier Hat', exact: true }).selectOption('unknown')
  await expect(panel.getByRole('combobox', { name: 'Bloodmage', exact: true })).toHaveValue('enabled')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await panel.locator('.game-setup-mod-choice select').evaluateAll(controls => controls.every(control => {
    const bounds = control.getBoundingClientRect()
    return bounds.height >= 44 && bounds.x >= 0 && bounds.right <= innerWidth
  }))).toBe(true)
  await context.setOffline(true)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic storage failure', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await panel.getByRole('button', { name: /^(Create Game Setup|Save new Game Setup revision)$/ }).click()
  await expect(panel.getByText('Game Setup not saved', { exact: true })).toBeVisible()
  await openSwitchModPacks(panel)
  await expect(shield).toHaveValue('disabled')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await page.reload()
  panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Game Setup', exact: true }).click()
  await openSwitchModPacks(panel)
  await expect(panel.getByRole('combobox', { name: 'Doge Shield', exact: true })).toHaveValue('disabled')
  await expect(panel.getByRole('combobox', { name: 'Pointier Hat', exact: true })).toHaveValue('unknown')
  await expect(panel.getByRole('combobox', { name: 'Bloodmage', exact: true })).toHaveValue('enabled')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const saved = await exportLocalData(page)
  expect(saved.gameSetups[saved.planningGameSetupRevisionId!].mods).toEqual(known(CONFIRMED_SWITCH_MOD_SETUP.enabledMods.filter(name => name !== 'Doge Shield' && name !== 'Pointier Hat')))
  expect(saved.gameSetups[saved.planningGameSetupRevisionId!].disabledMods).toEqual(known([...CONFIRMED_SWITCH_MOD_SETUP.disabledMods, 'Doge Shield']))
  expect(externalRequests).toEqual([])
  await context.setOffline(false)
})

test('Switch selections retain other imported names and unrelated conflicting claims', async ({ page }) => {
  const localData = updateGameSetupRevision(createTestLocalData(), {
    sourceRevisionId: TEST_GAME_SETUP_REVISION_ID,
    mods: { state: 'conflicting', claims: [{ value: ['Doge Shield', 'Synthetic imported mod'], sources: [] }, { value: ['Tempest'], sources: [] }] },
    disabledMods: known(['Synthetic disabled mod']),
  })
  await page.goto('/')
  await importBackup(page, backup(localData))
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Game Setup', exact: true }).click()
  await openSwitchModPacks(panel)
  await expect(panel.getByRole('combobox', { name: 'Doge Shield', exact: true })).toHaveValue('conflicting')
  await panel.getByText('Other imported mod names (preserved)', { exact: true }).click()
  await expect(panel).toContainText('Synthetic imported mod')
  await expect(panel).toContainText('Synthetic disabled mod')
  await panel.getByRole('combobox', { name: 'Doge Shield', exact: true }).selectOption('disabled')
  await panel.getByRole('combobox', { name: 'Bloodmage', exact: true }).selectOption('enabled')
  await expect(panel.getByRole('combobox', { name: 'Tempest', exact: true })).toHaveValue('conflicting')
  await panel.getByRole('button', { name: 'Save new Game Setup revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.reload()
  const saved = await exportLocalData(page)
  expect(saved.gameSetups[saved.planningGameSetupRevisionId!].mods).toEqual({ state: 'conflicting', claims: [{ value: ['Synthetic imported mod', 'Bloodmage'], sources: [] }, { value: ['Tempest', 'Bloodmage'], sources: [] }] })
  expect(saved.gameSetups[saved.planningGameSetupRevisionId!].disabledMods).toEqual(known(['Synthetic disabled mod', 'Doge Shield']))
  expect(saved.gameSetups[localData.planningGameSetupRevisionId!]).toEqual(localData.gameSetups[localData.planningGameSetupRevisionId!])
})

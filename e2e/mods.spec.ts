import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { STARTER_CATALOG } from '../src/catalog/starter'
import { CONFIRMED_SWITCH_MOD_SETUP, SWITCH_MOD_PACKS } from '../src/catalog/mods'
import { asId, captureCharacter, createCharacter, updateRulesetRevision } from '../src/domain'
import { createTestProfile, HAND_SLOT, known, TEST_NOW, TEST_RULESET_REVISION_ID } from '../src/domain/test-helpers'
import type { CatalogRef, CharacterId, EntityId, Profile } from '../src/domain/types'

const CHARACTER = asId<CharacterId>('synthetic-mod-rowan')
const SHIELD: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: asId<EntityId>('mod-pack-2:item:doge-shield') }
const BACKBREAKER: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: asId<EntityId>('equipment-expansion:item:backbreaker') }

function backup(profile: Profile): Uint8Array {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  return zipSync({ 'manifest.json': encode({ format: 'crystal-companion-backup', formatVersion: '1.0.0', exportedAt: TEST_NOW, payload: 'bundle.json', sources: [] }), 'bundle.json': encode({ profile: { ...profile, changes: [] }, lineage: { rootProfileId: profile.id }, catalogs: [STARTER_CATALOG], evidence: [], history: [] }) })
}

async function dataPanel(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportProfile(page: Page): Promise<Profile> {
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const bytes = await readFile((await (await downloaded).path())!)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return (JSON.parse(strFromU8(unzipSync(bytes)['bundle.json'])) as { profile: Profile }).profile
}

async function importBackup(page: Page, bytes: Uint8Array) {
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-mods.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) })
  await expect(panel.getByText('native-backup-1.0.0', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(panel).not.toBeVisible()
}

async function search(page: Page, query: string) {
  await page.getByRole('button', { name: /^(Search|Search planner)$/ }).filter({ visible: true }).click()
  const palette = page.getByRole('dialog', { name: 'Search Crystal Companion', exact: true })
  await palette.getByRole('searchbox').fill(query)
  return palette
}

test('recorded mod help opens settings and preserves the snapshot after a mod choice changes', async ({ page, isMobile }) => {
  const original = createTestProfile()
  let profile = updateRulesetRevision(original, { sourceRevisionId: TEST_RULESET_REVISION_ID, catalogLock: { [STARTER_CATALOG.id]: STARTER_CATALOG.revisionId }, slots: original.rulesets[TEST_RULESET_REVISION_ID].slots.map(slot => ({ ...slot, label: slot.id === HAND_SLOT ? 'Accessory 1' : slot.label })) })
  profile = createCharacter(profile, { id: CHARACTER, name: 'Synthetic Rowan', now: TEST_NOW })
  profile = captureCharacter(profile, { characterId: CHARACTER, level: known(12), ppCapacity: known(4), displayedStats: {}, selections: { [HAND_SLOT]: BACKBREAKER }, now: TEST_NOW })
  profile = { ...profile, changes: [] }
  await page.goto('/')
  await importBackup(page, backup(profile))
  await page.goto(`/#/characters/${CHARACTER}/current`)
  const help = page.locator('.member-menu .recorded-mod')
  const summary = help.locator('summary')
  await expect(summary).toHaveText('Equipment Expansion mod: enabled status not recorded')
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
  await help.getByRole('link', { name: 'Data & settings > Ruleset', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(settings.getByRole('combobox', { name: 'Equipment Expansion', exact: true })).toHaveValue('unknown')
  await settings.getByRole('combobox', { name: 'Equipment Expansion', exact: true }).selectOption('enabled')
  await settings.getByRole('button', { name: 'Save new ruleset revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/characters/${CHARACTER}/current$`))
  await expect(summary).toHaveText('Equipment Expansion mod: enabled status not recorded')
  await expect(page.getByText('Slot context has changed', { exact: true })).toBeVisible()
  expect((await exportProfile(page)).characters).toEqual(profile.characters)
})

test('mod settings control search and choices while sheets retain recorded context across backup restore', async ({ page }) => {
  let profile = updateRulesetRevision(createTestProfile(), { sourceRevisionId: TEST_RULESET_REVISION_ID, mods: known(['Doge Shield']), disabledMods: known(['Equipment Expansion']), catalogLock: { [STARTER_CATALOG.id]: STARTER_CATALOG.revisionId } })
  profile = createCharacter(profile, { id: CHARACTER, name: 'Synthetic Rowan', now: TEST_NOW })
  profile = captureCharacter(profile, { characterId: CHARACTER, level: known(12), ppCapacity: known(4), displayedStats: {}, selections: { [HAND_SLOT]: SHIELD }, note: 'Synthetic mod observation', now: TEST_NOW })
  profile = captureCharacter(profile, { characterId: CHARACTER, level: known(14), ppCapacity: known(4), displayedStats: {}, selections: { [HAND_SLOT]: SHIELD }, note: 'Synthetic later mod observation', now: '2026-01-03T00:00:00.000Z' })
  profile = { ...profile, changes: [] }
  await page.goto('/')
  await importBackup(page, backup(profile))
  let palette = await search(page, 'Doge Shield')
  await expect(palette.locator('.universal-search__result')).toHaveCount(1)
  await page.keyboard.press('Escape')
  palette = await search(page, 'Heavy Edge')
  await expect(palette.locator('.universal-search__result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  const settings = await dataPanel(page)
  await settings.getByRole('button', { name: 'Ruleset', exact: true }).click()
  await expect(settings.getByRole('combobox', { name: 'Doge Shield', exact: true })).toHaveValue('enabled')
  await settings.getByRole('combobox', { name: 'Doge Shield', exact: true }).selectOption('disabled')
  await settings.getByRole('combobox', { name: 'Bloodmage', exact: true }).selectOption('enabled')
  await settings.getByRole('combobox', { name: 'Equipment Expansion', exact: true }).selectOption('unknown')
  await settings.getByRole('button', { name: 'Save new ruleset revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.goto(`/#/characters/${CHARACTER}/current`)
  await expect(page.locator('.member-slot-warning').filter({ hasText: 'Doge Shield mod: enabled' })).toBeVisible()
  await page.locator('.member-record > summary').filter({ hasText: 'Observation details' }).click()
  await expect(page.locator('.recorded-sheet')).toContainText('Equipment Expansion')
  await page.getByRole('link', { name: 'Doge Shield', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Doge Shield', exact: true })).toBeVisible()
  await expect(page.getByText('Doge Shield mod: disabled', { exact: true })).toBeVisible()
  await page.goto('/#/reference')
  const referenceSearch = page.getByRole('searchbox', { name: 'Search reference', exact: true })
  if (!await referenceSearch.isVisible()) await page.getByRole('button', { name: /Refine|Filters/ }).click()
  await referenceSearch.fill('Doge Shield')
  await expect(page.locator('button.reference-card')).toHaveCount(0)
  await referenceSearch.fill('Heavy Edge')
  await expect(page.locator('button.reference-card')).toHaveCount(1)
  await expect(page.locator('button.reference-card')).toContainText('Equipment Expansion mod: enabled status not recorded')
  palette = await search(page, 'Doge Shield')
  await expect(palette.locator('.universal-search__result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  palette = await search(page, 'Bloodmage')
  await expect(palette.locator('.universal-search__result').filter({ hasText: 'Bloodmage mod: enabled' })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.goto(`/#/characters/${CHARACTER}/current`)
  await page.getByRole('button', { name: 'Capture snapshot', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
  await form.getByRole('button', { name: 'Choose Hand', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose Hand', exact: true })
  await picker.getByRole('button', { name: /^Unknown or unrecorded/ }).click()
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
  await expect(page.getByRole('region', { name: 'Hand', exact: true }).getByText('Doge Shield mod: enabled', { exact: true })).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const bytes = await readFile((await (await downloaded).path())!)
  const saved = (JSON.parse(strFromU8(unzipSync(bytes)['bundle.json'])) as { profile: Profile }).profile
  expect(saved.characters).toEqual(profile.characters)
  expect(saved.rulesets[saved.activeRulesetRevisionId!].disabledMods).toEqual(known(['Doge Shield']))
  expect(saved.rulesets[profile.activeRulesetRevisionId!].mods).toEqual(known(['Doge Shield']))
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await importBackup(page, bytes)
  await page.reload()
  palette = await search(page, 'Doge Shield')
  await expect(palette.locator('.universal-search__result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.goto(`/#/characters/${CHARACTER}/current`)
  await expect(page.locator('.member-slot-warning').filter({ hasText: 'Doge Shield mod: enabled' })).toBeVisible()
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
  await panel.getByRole('button', { name: 'Ruleset', exact: true }).click()
  await expect(panel.locator('textarea')).toHaveCount(0)
  for (const pack of SWITCH_MOD_PACKS) {
    const group = panel.getByRole('group', { name: pack.name, exact: true })
    await expect(group.getByRole('combobox')).toHaveCount(pack.mods.length)
    for (const name of pack.mods) await expect(group.getByRole('combobox', { name, exact: true })).toHaveValue('unknown')
  }
  await panel.getByLabel('Ruleset label', { exact: false }).fill('Synthetic Switch choices')
  await panel.getByRole('button', { name: 'Use confirmed Switch setup', exact: true }).click()
  for (const name of CONFIRMED_SWITCH_MOD_SETUP.enabledMods) await expect(panel.getByRole('combobox', { name, exact: true })).toHaveValue('enabled')
  for (const name of CONFIRMED_SWITCH_MOD_SETUP.disabledMods) await expect(panel.getByRole('combobox', { name, exact: true })).toHaveValue('disabled')
  await expect(panel.getByLabel('Platform', { exact: true })).toHaveValue('Nintendo Switch')
  await expect(panel.getByLabel('Game version', { exact: true })).toHaveValue('')
  const shield = panel.getByRole('combobox', { name: 'Doge Shield', exact: true })
  await shield.focus()
  await shield.press('d')
  await shield.press('Tab')
  await expect(shield).toHaveValue('disabled')
  await panel.getByRole('combobox', { name: 'Pointier Hat', exact: true }).selectOption('unknown')
  await expect(panel.getByRole('combobox', { name: 'Bloodmage', exact: true })).toHaveValue('enabled')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await panel.locator('.ruleset-mod-choice select').evaluateAll(controls => controls.every(control => {
    const bounds = control.getBoundingClientRect()
    return bounds.height >= 44 && bounds.x >= 0 && bounds.right <= innerWidth
  }))).toBe(true)
  await context.setOffline(true)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'profiles') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic storage failure', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await panel.getByRole('button', { name: /^(Create ruleset|Save new ruleset revision)$/ }).click()
  await expect(panel.getByText('Ruleset not saved', { exact: true })).toBeVisible()
  await expect(shield).toHaveValue('disabled')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await page.reload()
  panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Ruleset', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Doge Shield', exact: true })).toHaveValue('disabled')
  await expect(panel.getByRole('combobox', { name: 'Pointier Hat', exact: true })).toHaveValue('unknown')
  await expect(panel.getByRole('combobox', { name: 'Bloodmage', exact: true })).toHaveValue('enabled')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const saved = await exportProfile(page)
  expect(saved.rulesets[saved.activeRulesetRevisionId!].mods).toEqual(known(CONFIRMED_SWITCH_MOD_SETUP.enabledMods.filter(name => name !== 'Doge Shield' && name !== 'Pointier Hat')))
  expect(saved.rulesets[saved.activeRulesetRevisionId!].disabledMods).toEqual(known([...CONFIRMED_SWITCH_MOD_SETUP.disabledMods, 'Doge Shield']))
  expect(externalRequests).toEqual([])
  await context.setOffline(false)
})

test('Switch selections retain other imported names and unrelated conflicting claims', async ({ page }) => {
  const profile = updateRulesetRevision(createTestProfile(), {
    sourceRevisionId: TEST_RULESET_REVISION_ID,
    mods: { state: 'conflicting', claims: [{ value: ['Doge Shield', 'Synthetic imported mod'], sources: [] }, { value: ['Tempest'], sources: [] }] },
    disabledMods: known(['Synthetic disabled mod']),
  })
  await page.goto('/')
  await importBackup(page, backup(profile))
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Ruleset', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Doge Shield', exact: true })).toHaveValue('conflicting')
  await panel.getByText('Other imported mod names (preserved)', { exact: true }).click()
  await expect(panel).toContainText('Synthetic imported mod')
  await expect(panel).toContainText('Synthetic disabled mod')
  await panel.getByRole('combobox', { name: 'Doge Shield', exact: true }).selectOption('disabled')
  await panel.getByRole('combobox', { name: 'Bloodmage', exact: true }).selectOption('enabled')
  await expect(panel.getByRole('combobox', { name: 'Tempest', exact: true })).toHaveValue('conflicting')
  await panel.getByRole('button', { name: 'Save new ruleset revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.reload()
  const saved = await exportProfile(page)
  expect(saved.rulesets[saved.activeRulesetRevisionId!].mods).toEqual({ state: 'conflicting', claims: [{ value: ['Synthetic imported mod', 'Bloodmage'], sources: [] }, { value: ['Tempest', 'Bloodmage'], sources: [] }] })
  expect(saved.rulesets[saved.activeRulesetRevisionId!].disabledMods).toEqual(known(['Synthetic disabled mod', 'Doge Shield']))
  expect(saved.rulesets[profile.activeRulesetRevisionId!]).toEqual(profile.rulesets[profile.activeRulesetRevisionId!])
})

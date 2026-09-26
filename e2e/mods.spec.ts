import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { STARTER_CATALOG } from '../src/catalog/starter'
import { asId, captureCharacter, createCharacter, updateRulesetRevision } from '../src/domain'
import { createTestProfile, HAND_SLOT, known, TEST_NOW, TEST_RULESET_REVISION_ID } from '../src/domain/test-helpers'
import type { CatalogRef, CharacterId, EntityId, Profile } from '../src/domain/types'

const CHARACTER = asId<CharacterId>('synthetic-mod-rowan')
const SHIELD: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: asId<EntityId>('mod-pack-2:item:doge-shield') }

async function dataPanel(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
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

test('mod settings control search and choices while sheets retain recorded context across backup restore', async ({ page }) => {
  let profile = updateRulesetRevision(createTestProfile(), { sourceRevisionId: TEST_RULESET_REVISION_ID, mods: known(['Doge Shield']), disabledMods: known(['Equipment Expansion']), catalogLock: { [STARTER_CATALOG.id]: STARTER_CATALOG.revisionId } })
  profile = createCharacter(profile, { id: CHARACTER, name: 'Synthetic Rowan', now: TEST_NOW })
  profile = captureCharacter(profile, { characterId: CHARACTER, level: known(12), ppCapacity: known(4), displayedStats: {}, selections: { [HAND_SLOT]: SHIELD }, note: 'Synthetic mod observation', now: TEST_NOW })
  profile = captureCharacter(profile, { characterId: CHARACTER, level: known(14), ppCapacity: known(4), displayedStats: {}, selections: { [HAND_SLOT]: SHIELD }, note: 'Synthetic later mod observation', now: '2026-01-03T00:00:00.000Z' })
  profile = { ...profile, changes: [] }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const archive = zipSync({ 'manifest.json': encode({ format: 'crystal-companion-backup', formatVersion: '1.0.0', exportedAt: TEST_NOW, payload: 'bundle.json', sources: [] }), 'bundle.json': encode({ profile, lineage: { rootProfileId: profile.id }, catalogs: [STARTER_CATALOG], evidence: [], history: [] }) })
  await page.goto('/')
  await importBackup(page, archive)
  let palette = await search(page, 'Doge Shield')
  await expect(palette.locator('.universal-search__result')).toHaveCount(1)
  await page.keyboard.press('Escape')
  palette = await search(page, 'Heavy Edge')
  await expect(palette.locator('.universal-search__result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  const settings = await dataPanel(page)
  await settings.getByRole('button', { name: 'Ruleset', exact: true }).click()
  await settings.getByLabel('Disabled mods', { exact: true }).fill('Doge Shield')
  await settings.getByRole('button', { name: 'Save new ruleset revision', exact: true }).click()
  await expect(settings.getByText('Ruleset not saved', { exact: true })).toBeVisible()
  await expect(settings).toContainText('both enabled and disabled: Doge Shield')
  await settings.getByLabel('Enabled mods', { exact: true }).fill('Bloodmage')
  await settings.getByRole('button', { name: 'Save new ruleset revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.goto(`/#/characters/${CHARACTER}/current`)
  await expect(page.getByText('Doge Shield: enabled', { exact: true })).toBeVisible()
  await page.getByText('Recorded mods', { exact: true }).click()
  await expect(page.locator('.recorded-sheet')).toContainText('Equipment Expansion')
  await page.getByRole('link', { name: 'Doge Shield', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Doge Shield', exact: true })).toBeVisible()
  await expect(page.getByText('Doge Shield: disabled', { exact: true })).toBeVisible()
  await page.goto('/#/reference')
  const referenceSearch = page.getByRole('searchbox', { name: 'Search reference', exact: true })
  if (!await referenceSearch.isVisible()) await page.getByRole('button', { name: /Refine|Filters/ }).click()
  await referenceSearch.fill('Doge Shield')
  await expect(page.locator('button.reference-card')).toHaveCount(0)
  await referenceSearch.fill('Heavy Edge')
  await expect(page.locator('button.reference-card')).toHaveCount(1)
  await expect(page.locator('button.reference-card')).toContainText('Equipment Expansion: setting unknown')
  palette = await search(page, 'Doge Shield')
  await expect(palette.locator('.universal-search__result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  palette = await search(page, 'Bloodmage')
  await expect(palette.locator('.universal-search__result').filter({ hasText: 'Bloodmage: enabled' })).toHaveCount(1)
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
  await page.getByRole('tab', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: 'Compare snapshots', exact: true }).click()
  await page.getByLabel('Show unchanged fields', { exact: true }).check()
  await expect(page.getByRole('region', { name: 'Hand', exact: true }).getByText('Doge Shield: enabled', { exact: true })).toHaveCount(2)
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
  await expect(page.getByText('Doge Shield: enabled', { exact: true })).toBeVisible()
})

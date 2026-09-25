import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { addRulesetRevision, asId, captureCharacter, createCharacter } from '../src/domain'
import { addTestBuild, addTestDefinition, createTestProfile, HAND_SLOT, known, personalRef, TEST_NOW, TEST_RULESET_REVISION_ID } from '../src/domain/test-helpers'
import type { CharacterId, CharacterSnapshotId, Profile, RulesetRevisionId } from '../src/domain/types'

const CHARACTER_ID = asId<CharacterId>('synthetic-rowan')
const BEFORE_ID = asId<CharacterSnapshotId>('before')
const AFTER_ID = asId<CharacterSnapshotId>('after')
const BEFORE_DATE = '2026-01-01T10:00:00.000Z'

function syntheticProfile(changedContext = false): Profile {
  let profile = createTestProfile()
  profile = addTestDefinition(profile, 'Synthetic blade')
  profile = createCharacter(profile, { id: CHARACTER_ID, name: 'Synthetic Rowan', now: TEST_NOW })
  profile = createCharacter(profile, { id: asId<CharacterId>('synthetic-mira'), name: 'Synthetic Mira', now: TEST_NOW })
  profile = captureCharacter(profile, { characterId: CHARACTER_ID, snapshotId: BEFORE_ID, level: known(24), ppCapacity: known(8), displayedStats: { 'Max HP': { value: known(540), unit: 'points' }, Luck: { value: { state: 'unknown' }, unit: 'displayed' } }, selections: { [HAND_SLOT]: personalRef('Synthetic blade'), 'second-hand': null }, observedAt: BEFORE_DATE, note: 'Synthetic earlier observation', now: BEFORE_DATE })
  profile = captureCharacter(profile, { characterId: CHARACTER_ID, snapshotId: AFTER_ID, level: known(26), ppCapacity: { state: 'unknown' }, displayedStats: { 'Max HP': { value: known(620), unit: 'points' }, Luck: { value: { state: 'unknown' }, unit: 'displayed' } }, selections: { [HAND_SLOT]: personalRef('Synthetic blade') }, observedAt: TEST_NOW, note: 'Synthetic later observation', now: TEST_NOW })
  profile = addTestBuild(profile, 'Synthetic Rowan proposal', CHARACTER_ID, {})
  profile = addTestBuild(profile, 'Synthetic Mira proposal', 'synthetic-mira', {})
  if (changedContext) {
    const character = profile.characters[CHARACTER_ID]!
    const { rulesetRevisionId: _context, ...legacy } = character.snapshots[BEFORE_ID]!
    profile = { ...profile, characters: { ...profile.characters, [CHARACTER_ID]: { ...character, snapshots: { ...character.snapshots, [BEFORE_ID]: legacy } } } }
    profile = addRulesetRevision(profile, { ...profile.rulesets[TEST_RULESET_REVISION_ID]!, id: asId<RulesetRevisionId>('revised-ruleset'), activate: true, slots: profile.rulesets[TEST_RULESET_REVISION_ID]!.slots.map((slot) => ({ ...slot, label: `Revised ${slot.label}` })), now: TEST_NOW })
  }
  return { ...profile, changes: [] }
}

async function dataPanel(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function loadFixture(page: Page, changedContext = false) {
  await page.goto('/')
  const profile = syntheticProfile(changedContext)
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const archive = zipSync({
    'manifest.json': encode({ format: 'crystal-companion-backup', formatVersion: '1.0.0', exportedAt: TEST_NOW, payload: 'bundle.json', sources: [] }),
    'bundle.json': encode({ profile, lineage: { rootProfileId: profile.id }, catalogs: [], evidence: [], history: [] }),
  })
  const panel = await dataPanel(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-sheet.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) })
  await expect(panel.getByText('native-backup-1.0.0', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await page.goto(`/#/characters/${CHARACTER_ID}/current`)
  await expect(page.getByRole('heading', { name: 'Synthetic Rowan', exact: true })).toBeVisible()
  return profile
}

async function exportProfile(page: Page): Promise<Profile> {
  const panel = await dataPanel(page)
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const path = await (await download).path()
  if (!path) throw new Error('Backup download failed')
  const archive = unzipSync(await readFile(path))
  const payload = JSON.parse(strFromU8(archive['bundle.json']!)) as { profile: Profile }
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return payload.profile
}

test('recorded sheets inspect and compare exact snapshots without changing observations or proposals', async ({ page, isMobile }) => {
  const original = await loadFixture(page)
  const stats = page.getByRole('region', { name: 'Displayed final stats', exact: true })
  const equipment = page.getByRole('region', { name: 'Equipment and equipped passives', exact: true })
  await expect(stats.getByText('620', { exact: false })).toBeVisible()
  await expect(page.getByText('Synthetic later observation', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Synthetic Rowan proposal', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Synthetic Mira proposal', exact: true })).toHaveCount(0)
  const statBounds = await stats.boundingBox()
  const equipmentBounds = await equipment.boundingBox()
  expect(statBounds).not.toBeNull()
  expect(equipmentBounds).not.toBeNull()
  if (!isMobile) expect(Math.abs(statBounds!.y - equipmentBounds!.y)).toBeLessThan(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('tab', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: 'Inspect snapshot', exact: true }).last().click()
  await expect(page).toHaveURL(new RegExp(`/history/snapshots/${BEFORE_ID}$`))
  await expect(page.getByText('Synthetic earlier observation', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit Hand', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(stats.getByText('540 points', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to snapshot history', exact: true }).click()
  await page.getByRole('button', { name: 'Compare snapshots', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/history/compare/${BEFORE_ID}/${AFTER_ID}$`))
  const hp = page.getByRole('region', { name: 'Max HP', exact: true })
  await expect(hp).toContainText('Observed difference (B minus A): +80')
  const pp = page.getByRole('region', { name: 'PP capacity', exact: true })
  await expect(pp).toContainText('Unknown')
  await expect(pp).not.toContainText('Observed difference')
  await expect(page.getByRole('region', { name: 'Second hand', exact: true })).toContainText('Observed empty')
  await expect(page.getByRole('region', { name: 'Second hand', exact: true })).toContainText('Unknown or unrecorded')
  await expect(page.getByRole('region', { name: 'Luck', exact: true })).toHaveCount(0)
  await page.getByLabel('Show unchanged fields', { exact: true }).check()
  await expect(page.getByRole('region', { name: 'Luck', exact: true })).toContainText('Unchanged')
  const values = hp.locator('.snapshot-difference__values > div')
  expect(Math.abs((await values.nth(0).boundingBox())!.y - (await values.nth(1).boundingBox())!.y)).toBeLessThan(2)
  await page.reload()
  await expect(hp).toContainText('+80')
  await page.getByRole('combobox', { name: 'Snapshot A', exact: true }).selectOption(AFTER_ID)
  await expect(page.getByText('Same snapshot selected', { exact: true })).toBeVisible()
  const exported = await exportProfile(page)
  expect(exported.characters).toEqual(original.characters)
  expect(exported.buildRevisions).toEqual(original.buildRevisions)
  expect(exported.inventory).toEqual({})
})

test('direct slot editing protects a draft and saves a new observation offline', async ({ page, isMobile, context }) => {
  const original = await loadFixture(page)
  const storage = await dataPanel(page)
  await storage.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await storage.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expect(storage.getByText('Offline ready', { exact: true })).toBeVisible()
  await storage.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  expect(await page.evaluate(() => navigator.onLine)).toBe(false)
  expect(await page.evaluate(() => fetch('/synthetic-uncached-offline-probe').then(() => false, () => true))).toBe(true)
  await page.getByRole('button', { name: 'Edit Hand', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose Hand', exact: true })
  const form = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
  await expect(picker.getByRole('searchbox')).toBeFocused()
  await picker.getByRole('button', { name: /^Observed empty/ }).click()
  await expect(form.getByRole('button', { name: 'Choose Hand', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(form.getByText('Unsaved snapshot', { exact: true })).toBeAttached()
  await expect(form).toBeVisible()
  if (!isMobile) {
    const bounds = await form.boundingBox()
    expect(bounds!.x).toBeGreaterThan(0)
    await page.mouse.click(bounds!.x - 8, bounds!.y + 20)
    await expect(form).toBeVisible()
  }
  await page.goBack()
  await expect(form).toBeVisible()
  await expect(page).toHaveURL(/\/current\/snapshots\/new$/)
  await form.getByLabel('Snapshot note', { exact: true }).fill('Synthetic changed hand')
  await form.getByRole('button', { name: 'Save snapshot', exact: true }).click()
  await expect(form).not.toBeVisible()
  await page.reload()
  await expect(page.getByText('Synthetic changed hand', { exact: true })).toBeVisible()
  const saved = await exportProfile(page)
  const character = saved.characters[CHARACTER_ID]!
  expect(character.snapshots[BEFORE_ID]).toEqual(original.characters[CHARACTER_ID]!.snapshots[BEFORE_ID])
  expect(character.snapshots[AFTER_ID]).toEqual(original.characters[CHARACTER_ID]!.snapshots[AFTER_ID])
  expect(character.snapshots[character.currentSnapshotId!]!.selections[HAND_SLOT]).toBeNull()
  expect(character.snapshots[character.currentSnapshotId!]!.rulesetRevisionId).toBe(TEST_RULESET_REVISION_ID)
  expect(character.learnedNodes).toEqual({})
  expect(saved.inventory).toEqual({})
  await page.getByRole('tab', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: 'Compare snapshots', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Hand', exact: true })).toContainText('Observed empty')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Hand', exact: true })).toContainText('Observed empty')
  await context.setOffline(false)
})

test('legacy and missing snapshots keep explicit context and never fall back to current', async ({ page }) => {
  await loadFixture(page, true)
  await expect(page.getByText('Slot context has changed', { exact: true })).toBeVisible()
  await page.goto(`/#/characters/${CHARACTER_ID}/history/snapshots/${BEFORE_ID}`)
  await expect(page.getByText('Slot hand', { exact: true })).toBeVisible()
  await expect(page.getByText('Slot context was not recorded', { exact: true })).toBeVisible()
  await expect(page.getByText('Revised Hand', { exact: true })).toHaveCount(0)
  await page.goto(`/#/characters/${CHARACTER_ID}/history/compare/${BEFORE_ID}/${BEFORE_ID}`)
  await expect(page.getByText('Slot context is unrecorded', { exact: true })).toBeVisible()
  await page.goto(`/#/characters/${CHARACTER_ID}/history/snapshots/missing`)
  await expect(page.getByText('Snapshot unavailable', { exact: true })).toBeVisible()
  await expect(page.locator('.recorded-sheet')).toHaveCount(0)
  await page.goto(`/#/characters/synthetic-mira/history/snapshots/${AFTER_ID}`)
  await expect(page.getByText('Snapshot unavailable', { exact: true })).toBeVisible()
  await page.goto(`/#/characters/${CHARACTER_ID}/history/compare/missing/${AFTER_ID}`)
  await expect(page.getByText('Snapshot unavailable', { exact: true }).filter({ visible: true })).toBeVisible()
  await expect(page.locator('.snapshot-difference')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Snapshot A', exact: true }).selectOption(BEFORE_ID)
  await expect(page.getByText('Different slot contexts', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Capture snapshot', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
  await expect(form.getByText('Record selections again', { exact: true })).toBeVisible()
  await expect(form.getByRole('button', { name: 'Choose Revised Hand', exact: true })).toContainText('Unknown or unrecorded')
  await form.getByRole('button', { name: 'Save snapshot', exact: true }).click()
  const saved = await exportProfile(page)
  const character = saved.characters[CHARACTER_ID]!
  expect(character.snapshots[character.currentSnapshotId!]!.rulesetRevisionId).toBe('revised-ruleset')
  expect(character.snapshots[character.currentSnapshotId!]!.selections).toEqual({})
  expect(character.snapshots[AFTER_ID]!.selections[HAND_SLOT]).toEqual(personalRef('Synthetic blade'))
})

test('snapshot save failure retains entered fields and retries a single observation', async ({ page }) => {
  await loadFixture(page)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    let failOnce = true
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'profiles' && failOnce) { failOnce = false; throw new DOMException('Synthetic storage limit', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Capture snapshot', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
  await form.getByLabel('Snapshot note', { exact: true }).fill('Synthetic retained observation')
  await form.getByLabel('Level', { exact: true }).fill('30')
  await form.getByRole('button', { name: 'Save snapshot', exact: true }).click()
  await expect(form.getByText('Snapshot not saved', { exact: true })).toBeVisible()
  await expect(form.getByLabel('Snapshot note', { exact: true })).toHaveValue('Synthetic retained observation')
  await expect(form.getByLabel('Level', { exact: true })).toHaveValue('30')
  await form.getByRole('button', { name: 'Close form', exact: true }).click()
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.reload()
  const profile = await exportProfile(page)
  const snapshots = Object.values(profile.characters[CHARACTER_ID]!.snapshots)
  expect(snapshots.filter((snapshot) => snapshot.note === 'Synthetic retained observation')).toHaveLength(1)
  expect(snapshots).toHaveLength(3)
})

test('recording a proposal retains its ruleset and requires in-game confirmation', async ({ page }) => {
  const original = await loadFixture(page, true)
  await page.getByRole('button', { name: 'Synthetic Rowan proposal', exact: true }).click()
  await page.getByRole('button', { name: 'Record as current', exact: true }).click()
  const recording = page.getByRole('dialog', { name: 'Record build as current', exact: true })
  await expect(recording.getByRole('button', { name: 'Record as current', exact: true })).toBeDisabled()
  await recording.getByRole('checkbox', { name: /I made these changes in game/ }).check()
  await recording.getByRole('button', { name: 'Record as current', exact: true }).click()
  await expect(recording).not.toBeVisible()
  const saved = await exportProfile(page)
  const character = saved.characters[CHARACTER_ID]!
  const snapshot = character.snapshots[character.currentSnapshotId!]!
  expect(saved.activeRulesetRevisionId).toBe('revised-ruleset')
  expect(snapshot.rulesetRevisionId).toBe(TEST_RULESET_REVISION_ID)
  expect(snapshot.displayedStats).toEqual({})
  expect(snapshot.ppCapacity).toEqual({ state: 'unknown' })
  expect(character.snapshots[AFTER_ID]).toEqual(original.characters[CHARACTER_ID]!.snapshots[AFTER_ID])
  expect(character.learnedNodes).toEqual({})
  expect(saved.inventory).toEqual({})
})

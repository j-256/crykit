import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import { addRulesetRevision, asId, captureCharacter, createCharacter, upsertCharacterClassProgress, upsertLearnedNode } from '../src/domain'
import { createSampleProfile } from '../src/domain/sample-profile'
import { addTestDefinition, known, personalRef, TEST_NOW } from '../src/domain/test-helpers'
import type { CharacterId, CharacterSnapshotId, Profile } from '../src/domain/types'
import { createBlankPlaythrough } from './profile-helpers'

const CURRENT_SNAPSHOT = asId<CharacterSnapshotId>('synthetic-overview-current')

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportProfile(page: Page): Promise<Profile> {
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const archive = unzipSync(await readFile((await (await download).path())!))
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return (JSON.parse(strFromU8(archive['bundle.json']!)) as { profile: Profile }).profile
}

function syntheticOverview(): Profile {
  let profile = createSampleProfile(DEFAULT_CATALOG, TEST_NOW)
  const rowan = Object.values(profile.characters).find(character => character.name === 'Rowan')!
  const original = rowan.snapshots[rowan.currentSnapshotId!]!
  if (original.primaryClass.state !== 'known') throw new Error('The synthetic starter requires a known class')
  const primary = original.primaryClass.value
  for (const name of ['Synthetic focus', 'Synthetic unknown', 'Synthetic conflict', 'Synthetic not learned']) profile = addTestDefinition(profile, name, { kind: 'passive' })
  profile = captureCharacter(profile, {
    characterId: rowan.id, snapshotId: CURRENT_SNAPSHOT, level: known(35), primaryClass: original.primaryClass, secondaryClass: { state: 'notApplicable' },
    displayedStats: {
      HP: { value: known(0), unit: 'points' }, 'Max HP': { value: known(620), unit: 'points' },
      'Max. MP': { value: known(88), unit: 'points' }, Attack: { value: known(151), unit: 'displayed' },
      Speed: { value: { state: 'unknown' }, unit: 'displayed' }, Luck: { value: { state: 'conflicting', claims: [{ value: 5, sources: [] }, { value: 7, sources: [] }] }, unit: 'displayed' },
    },
    ppCapacity: known(7), equipment: { 'plan-main-hand': original.equipment['plan-main-hand']!, 'plan-off-hand': null }, passives: known([personalRef('Synthetic focus')]),
    observedAt: '2026-01-01T12:00:00.000Z', now: TEST_NOW,
  })
  profile = upsertCharacterClassProgress(profile, { characterId: rowan.id, classRef: primary, observedLp: known(0), mastered: known(true), now: TEST_NOW })
  for (const [index, name] of ['Synthetic focus', 'Synthetic unknown', 'Synthetic conflict', 'Synthetic not learned'].entries()) {
    profile = upsertLearnedNode(profile, { characterId: rowan.id, ref: personalRef(name), kind: 'passive', learned: index === 0 ? known(true) : index === 1 ? { state: 'unknown' } : index === 2 ? { state: 'conflicting', claims: [{ value: true, sources: [] }, { value: false, sources: [] }] } : known(false), now: TEST_NOW })
  }
  profile = captureCharacter(profile, { characterId: rowan.id, level: known(99), displayedStats: { HP: { value: known(9999), unit: 'points' } }, now: '2026-02-01T12:00:00.000Z' })
  profile = { ...profile, label: 'Synthetic overview', characters: { ...profile.characters, [rowan.id]: { ...profile.characters[rowan.id]!, currentSnapshotId: CURRENT_SNAPSHOT } } }
  profile = createCharacter(profile, { id: asId<CharacterId>('synthetic-neri'), name: 'Synthetic Neri', now: TEST_NOW })
  profile = upsertLearnedNode(profile, { characterId: asId<CharacterId>('synthetic-neri'), ref: personalRef('Synthetic focus'), kind: 'passive', learned: known(true), now: TEST_NOW })
  const ruleset = profile.rulesets[profile.activeRulesetRevisionId!]!
  profile = addRulesetRevision(profile, { ...ruleset, id: undefined, label: 'Different slot context', slots: ruleset.slots.map(slot => ({ ...slot, label: `Changed ${slot.label}` })), activate: true, now: TEST_NOW })
  return { ...profile, changes: [] }
}

async function importProfile(page: Page, profile: Profile) {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const archive = zipSync({
    'manifest.json': encode({ format: 'crystal-companion-backup', formatVersion: '1.0.0', exportedAt: TEST_NOW, payload: 'bundle.json', sources: [] }),
    'bundle.json': encode({ profile, lineage: { rootProfileId: profile.id }, catalogs: [DEFAULT_CATALOG], evidence: [], history: [] }),
  })
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-overview.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) })
  await expect(panel.getByText('native-backup-1.0.0', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await page.goto('/#/characters')
}

function field(container: Locator, label: string) {
  return container.locator('dl > div').filter({ has: container.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')
}

test('overview preserves the selected snapshot, slot context, knowledge states and independent learning records', async ({ page }, testInfo) => {
  await page.goto('/')
  const original = syntheticOverview()
  await importProfile(page, original)
  await expect(page).toHaveURL(/#\/characters$/)
  const rowan = page.getByRole('article', { name: 'Rowan', exact: true })
  const stats = rowan.getByRole('region', { name: 'Rowan: recorded stats', exact: true })
  await expect(field(rowan, 'Lv')).toHaveText('35')
  await expect(field(stats, 'HP')).toHaveText('0 points')
  await expect(field(stats, 'Max HP')).toHaveText('620 points')
  await expect(field(stats, 'Max. MP')).toHaveText('88 points')
  await expect(field(stats, 'Speed')).toHaveText('Unknown')
  await expect(field(stats, 'Luck')).toHaveText('Conflicting claims')
  await expect(field(stats, 'PP capacity')).toHaveText('7')
  await expect(rowan).not.toContainText('9999')
  await expect(rowan).not.toContainText('Changed Main hand')
  await expect(field(rowan, 'Main hand')).toHaveText('Short Sword')
  await expect(field(rowan, 'Off hand')).toHaveText('Empty')
  await expect(field(rowan, 'Head')).toHaveText('Unknown')
  await expect(field(rowan, 'Primary class LP')).toHaveText('0')
  await expect(field(rowan, 'Primary class mastered')).toHaveText('Yes')
  await expect(field(rowan, 'Learned skills')).toHaveText('1 confirmed · 1 not learned · 1 unknown · 1 conflicting')
  await expect(field(rowan, 'Secondary class')).toHaveText('Not applicable')
  await expect(rowan.getByText('Synthetic focus', { exact: true })).toBeVisible()
  await expect(rowan.locator('.roster-observation')).toContainText('Observed Jan 1, 2026')
  const passives = rowan.getByRole('region', { name: 'Rowan: recorded passives', exact: true })
  await expect(field(passives, 'Equipped passive 1')).toHaveText('Synthetic focus')
  const mira = page.getByRole('article', { name: 'Mira', exact: true })
  await expect(field(mira, 'HP')).toHaveText('Unknown')
  await expect(field(mira, 'Learned skills')).toHaveText('Unrecorded')
  const neri = page.getByRole('article', { name: 'Synthetic Neri', exact: true })
  await expect(neri.getByText('No snapshot recorded', { exact: true })).toBeVisible()
  await expect(neri).toContainText('Learned skills: 1 confirmed')
  await page.screenshot({ path: testInfo.outputPath('overview-recorded.png'), fullPage: true })
  const saved = await exportProfile(page)
  expect(saved.characters).toEqual(original.characters)
  expect(saved.inventory).toEqual(original.inventory)
  expect(saved.buildRevisions).toEqual(original.buildRevisions)
  expect(saved.scenarios).toEqual(original.scenarios)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('overview links support keyboard, history, offline reload and dirty member guards', async ({ page, context }, testInfo) => {
  const errors: string[] = []
  const external: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (!['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname)) external.push(request.url()) })
  await page.goto('/#/characters')
  await expect(page.getByRole('heading', { name: 'Characters', exact: true })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(4)
  const rowan = page.getByRole('article', { name: 'Rowan', exact: true })
  const mira = page.getByRole('article', { name: 'Mira', exact: true })
  await expect(rowan.getByText('Short Sword', { exact: true })).toBeVisible()
  await expect(mira.getByText('Short Staff', { exact: true })).toBeVisible()
  const member = mira.getByRole('link', { name: 'Member', exact: true })
  await member.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Mira', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose Main hand', exact: true })).toContainText('Short Staff')
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await rowan.getByRole('link', { name: 'Learn', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Learn', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.goBack()
  await rowan.getByRole('link', { name: 'History', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await rowan.getByRole('link', { name: 'Member', exact: true }).click()
  await page.getByRole('button', { name: 'Choose Main hand', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose Main hand', exact: true }).getByRole('button', { name: /^Empty/ }).click()
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Discard changes', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/current$/)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(field(rowan, 'Main hand')).toHaveText('Empty')
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expect(panel.getByText('Offline ready', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(4)
  await expect(field(rowan, 'Main hand')).toHaveText('Empty')
  await page.screenshot({ path: testInfo.outputPath('overview-offline.png'), fullPage: true })
  expect(errors).toEqual([])
  expect(external).toEqual([])
})

test('blank profiles and new characters stay blank and the roster is independent of scenario selection', async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/#/characters')
  await page.getByRole('button', { name: /^Scenario:/ }).click()
  await page.getByRole('dialog', { name: 'Choose scenario', exact: true }).getByRole('button', { name: /^None selected/ }).click()
  await expect(page.getByRole('article')).toHaveCount(4)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await createBlankPlaythrough(page)
  await page.goto('/#/characters')
  await expect(page.getByRole('heading', { name: 'Your roster is blank', exact: true })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(0)
  await page.getByRole('button', { name: 'Add character', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Add character', exact: true })
  await form.getByLabel('Character name').fill('Synthetic new character with a long name')
  await form.getByRole('button', { name: 'Add character', exact: true }).click()
  await expect(form).not.toBeVisible()
  const card = page.getByRole('article', { name: 'Synthetic new character with a long name', exact: true })
  await expect(card.getByText('No snapshot recorded', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await card.getByRole('link', { name: 'Capture snapshot', exact: true }).click()
  const capture = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
  await capture.getByLabel('Level certainty', { exact: true }).selectOption('known')
  await capture.getByLabel('Level', { exact: true }).fill('3')
  await capture.getByRole('button', { name: 'Save snapshot', exact: true }).click()
  await expect(capture).not.toBeVisible()
  await expect(page).toHaveURL(/\/current$/)
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(field(card, 'Lv')).toHaveText('3')
  await expect(field(card, 'HP')).toHaveText('Unknown')
  await expect(field(card, 'Primary class')).toHaveText('Unknown')
  await expect(field(card, 'Primary class mastered')).toHaveText('Unknown')
  await expect(card).not.toContainText('Short Sword')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

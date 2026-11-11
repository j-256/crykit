import { skipInitialModSetup, waitForPlannerReady, readLocalData as storedData } from './local-data-helpers'
import { chooseTeamCheckpoint } from './team-helpers'
import { expect, test, type Locator } from '@playwright/test'
import { createPublicSnapshot, createPublicShareUrl } from '../src/interchange/public-share'
import { readManagedGuestPlanner } from './guest-planner-reader'
import { CURRENT_CATALOG, BUNDLED_CATALOGS } from '../src/catalog/bundled'
import { MOBILE_TEST_TAG } from './test-tags'

async function checkLoadoutOrder(sheet: Locator) {
  const equipment = sheet.getByRole('region', { name: 'Equipment', exact: true })
  const stats = sheet.locator('.loadout-stats')
  expect((await equipment.boundingBox())!.y).toBeLessThan((await stats.boundingBox())!.y)
  await stats.locator(':scope > summary').click()
  await expect(stats).not.toHaveAttribute('open')
  await expect(sheet.getByRole('region', { name: 'Calculated stats', exact: true })).not.toBeVisible()
  await sheet.getByRole('navigation', { name: 'Loadout sections', exact: true }).getByRole('button', { name: 'Jump to stats', exact: true }).click()
  await expect(stats).toHaveAttribute('open')
  await expect(stats).toBeFocused()
  await expect(sheet.getByRole('region', { name: 'Calculated stats', exact: true })).toBeVisible()
  await expect(sheet.locator('.loadout-stat-breakdown')).not.toHaveAttribute('open')
  await expect(sheet.getByRole('table', { name: 'Gender stat comparison', exact: true })).not.toBeVisible()
}

test('build, character, and shared loadouts put controls before collapsible stats', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL, isMobile }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await page.getByRole('button', { name: 'Rowan: sample Warrior', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toBeInViewport()
  await checkLoadoutOrder(page.locator('.loadout-sheet'))
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === 'Rowan: sample Warrior')!
  const wizard = Object.values(before.builds).find(build => build.title === 'Sol: sample Wizard')!
  const wizardClass = before.buildRevisions[wizard.latestRevisionId!]!.content.primaryClass
  const revision = before.buildRevisions[build.latestRevisionId!]!
  const nativeRef = (ref: typeof wizardClass) => ref?.kind === 'catalog' ? { ...ref, catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId } : ref
  const setup = before.gameSetups[revision.gameSetupRevisionId]!
  const sharedData = { ...before, gameSetups: { ...before.gameSetups, [setup.id]: { ...setup, modComposition: undefined, modSourceReceipts: undefined, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId } } }, buildRevisions: { ...before.buildRevisions, [revision.id]: { ...revision, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, content: { ...revision.content, primaryClass: nativeRef(revision.content.primaryClass), secondaryClass: nativeRef(wizardClass), equipment: {}, passives: [] } } } }
  const share = createPublicShareUrl(createPublicSnapshot({ planner: { localData: sharedData, catalogs: BUNDLED_CATALOGS } }, { kind: 'build', revisionId: build.latestRevisionId! }, { includeNotes: false }), `${baseURL}/`)
  await page.goto(share)
  await expect(page.getByRole('region', { name: 'Shared build loadout', exact: true })).toBeVisible()
  await checkLoadoutOrder(page.locator('.loadout-sheet'))
  await page.getByRole('button', { name: 'Inspect Sub-command: Black Magic (Wizard)', exact: true }).click()
  await expect(page.locator('.build-field').filter({ has: page.getByRole('button', { name: 'Inspect Sub-command: Black Magic (Wizard)', exact: true }) }).locator('.build-selection-facts')).toHaveCount(0)
  const sharedDetails = isMobile ? page.locator('.build-field').filter({ has: page.getByRole('button', { name: 'Inspect Sub-command: Black Magic (Wizard)', exact: true }) }).locator('details') : page.getByRole('complementary', { name: 'Selection details', exact: true })
  const sharedPermissions = sharedDetails.locator('.build-selection-details > .definition-list > .definition-row').filter({ has: page.locator('dt', { hasText: /^(Weapons|Armor)$/ }) })
  await expect(sharedDetails).toContainText('Black Magic')
  await expect(sharedDetails).not.toContainText('equipment permissions')
  await expect(sharedDetails.locator('.stat-ratings')).toHaveCount(0)
  await page.locator('summary').filter({ hasText: /^Class growth$/ }).click()
  await expect(page.getByRole('region', { name: 'Warrior growth', exact: true })).toBeVisible()
  await expect(sharedPermissions).toHaveCount(0)
  await page.getByRole('button', { name: 'Inspect Class: Warrior', exact: true }).click()
  const classDetails = isMobile ? page.locator('.build-field').filter({ has: page.getByRole('button', { name: 'Inspect Class: Warrior', exact: true }) }).locator('details') : sharedDetails
  const classPermissions = classDetails.locator('.build-selection-details > .definition-list > .definition-row').filter({ has: page.locator('dt', { hasText: /^(Weapons|Armor)$/ }) })
  await expect(classPermissions).toHaveCount(2)
  await expect(classPermissions.filter({ hasText: 'Swords' })).toBeVisible()
  await expect(sharedDetails).not.toContainText("The sub-command does not grant class equipment permissions.")
  const playthrough = before.playthroughs[before.selectedPlaythroughId!]!
  const character = Object.values(playthrough.characters).find(character => character.name === 'Rowan')!
  await page.goto(`/#/characters/${character.id}/current`)
  await expect(page.locator('.loadout-sheet')).toBeVisible()
  await checkLoadoutOrder(page.locator('.loadout-sheet'))
  expect(await storedData(page)).toEqual(before)
})

test('new and shared plans report their own persistence until explicitly saved', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  await page.goto('/#/builds/library/new')
  await waitForPlannerReady(page)
  await expect(page.locator('.context-status')).toHaveText('Not yet saved')
  await page.goto('/#/teams/new')
  await expect(page.locator('.context-status')).toHaveText('Not yet saved')
  const before = await storedData(page)
  const build = Object.values(before.builds)[0]!
  const viewer = await readManagedGuestPlanner(page)
  if (!viewer) throw new Error('The managed synthetic planner is unavailable')
  const share = createPublicShareUrl(createPublicSnapshot({ planner: { localData: before, catalogs: viewer.catalogs } }, { kind: 'build', revisionId: build.latestRevisionId! }, { includeNotes: false }), `${baseURL}/`)
  await page.goto(share)
  await expect(page.locator('.context-status')).toHaveText('Read-only snapshot')
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.locator('.context-status')).toHaveText('Saved locally')
  const saved = await storedData(page)
  expect(Object.keys(saved.builds)).toHaveLength(Object.keys(before.builds).length + 1)
  await page.goto('/#/teams/new')
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic saved draft Team')
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.locator('.context-status')).toHaveText('Saved locally')
  await page.getByRole('button', { name: 'Edit Team', exact: true }).click()
  await page.getByRole('region', { name: 'Team slot 1 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await expect(page.locator('.context-status')).toHaveText('Not yet saved')
  await page.getByRole('button', { name: 'Return to Team', exact: true }).click()
  await expect(page.locator('.context-status')).toHaveText('Saved locally')
  expect(Object.keys((await storedData(page)).builds)).toHaveLength(Object.keys(saved.builds).length)
})

test('character sub-commands identify the source class without implying equipment permissions', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('button', { name: 'Rowan: sample Warrior', exact: true })).toBeVisible()
  const before = await storedData(page)
  const playthrough = before.playthroughs[before.selectedPlaythroughId!]!
  const character = Object.values(playthrough.characters).find(character => character.name === 'Rowan')!
  await page.goto(`/#/characters/${character.id}/current`)
  const subCommand = page.getByRole('button', { name: 'Choose Sub-Command', exact: true })
  await expect(subCommand).toContainText('Not applicable')
  await subCommand.click()
  const picker = page.getByRole('dialog', { name: 'Choose Sub-Command', exact: true })
  await picker.getByRole('searchbox').fill('Wizard')
  await picker.getByRole('button', { name: /^Black Magic \(Wizard\)/ }).filter({ hasNot: page.locator('[data-mod-badge]') }).click()
  await expect(subCommand).toContainText('Black Magic (Wizard)')
  const details = isMobile ? page.locator('[data-field-key="secondary-class"] .member-mobile-detail') : page.getByRole('complementary', { name: 'Selection details', exact: true })
  if (isMobile) await details.locator(':scope > summary').click()
  await expect(details).toContainText('Black Magic')
  await expect(details).not.toContainText('equipment permissions')
  await expect(details.locator('.stat-ratings')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Warrior growth', exact: true })).toBeVisible()
  await expect(details.locator('.build-selection-details > .definition-list > .definition-row').filter({ has: page.locator('dt', { hasText: /^(Weapons|Armor)$/ }) })).toHaveCount(0)
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(subCommand).toContainText('Not applicable')
  expect(await storedData(page)).toEqual(before)
})

test('team equipment names remain visible and keyboard activation opens exact details without changing a checkpoint', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('button', { name: 'Rowan: sample Warrior', exact: true })).toBeVisible()
  await page.goto('/#/teams/new')
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toBeVisible()
  const before = await storedData(page)
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  const build = Object.values(before.builds).find(build => build.title === 'Rowan: sample Warrior')!
  await chooseTeamCheckpoint(page, 1, build.latestRevisionId!)
  const slot = page.getByRole('region', { name: 'Team slot 1 loadout', exact: true })
  const sword = slot.getByRole('button', { name: 'Open Main hand: Short Sword', exact: true })
  await expect(sword.locator('.build-card__selection-name')).toBeVisible()
  await sword.focus()
  await sword.press('Enter')
  const details = page.getByRole('dialog', { name: 'Main hand: Short Sword', exact: true })
  await expect(details).toBeVisible()
  await expect(details).toContainText('Attack')
  await details.press('Escape')
  await expect(details).not.toBeVisible()
  await expect(sword).toBeFocused()
  expect((await storedData(page)).buildRevisions).toEqual(before.buildRevisions)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

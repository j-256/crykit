import { skipInitialModSetup } from './local-data-helpers'
import { chooseTeamCheckpoint } from './team-helpers'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { createSharePayload, createShareUrl } from '../src/interchange/share'
import { MOBILE_TEST_TAG } from './test-tags'

async function storedData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction('localDatas', 'readonly').objectStore('localDatas').getAll()
      read.onerror = () => { database.close(); reject(read.error) }
      read.onsuccess = () => { database.close(); resolve(read.result[0].localData) }
    }
  }))
}

async function checkLoadoutOrder(sheet: Locator) {
  const equipment = sheet.getByRole('region', { name: 'Equipment', exact: true })
  const stats = sheet.locator('.loadout-stats')
  expect((await equipment.boundingBox())!.y).toBeLessThan((await stats.boundingBox())!.y)
  await stats.locator(':scope > summary').click()
  await expect(stats).not.toHaveAttribute('open')
  await expect(sheet.getByRole('region', { name: 'Class stats', exact: true })).not.toBeVisible()
  await sheet.getByRole('navigation', { name: 'Loadout sections', exact: true }).getByRole('button', { name: 'Jump to stats and growth', exact: true }).click()
  await expect(stats).toHaveAttribute('open')
  await expect(stats).toBeFocused()
  await expect(sheet.getByRole('region', { name: 'Class stats', exact: true })).toBeVisible()
}

test('build, character, and shared loadouts put controls before collapsible stats', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
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
  const sharedData = { ...before, buildRevisions: { ...before.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, secondaryClass: wizardClass } } } }
  const share = createShareUrl(createSharePayload(sharedData, { kind: 'build', revisionId: build.latestRevisionId! }), `${baseURL}/`)
  await page.goto(share)
  await expect(page.getByRole('region', { name: 'Shared build loadout', exact: true })).toBeVisible()
  await checkLoadoutOrder(page.locator('.loadout-sheet'))
  await page.getByRole('button', { name: 'Inspect Sub-command: Black Magic (Wizard)', exact: true }).click()
  const sharedDetails = page.getByRole('complementary', { name: 'Selection details', exact: true })
  const sharedPermissions = sharedDetails.locator('.build-selection-details > .definition-list > .definition-row').filter({ has: page.locator('dt', { hasText: /^(Weapons|Armor)$/ }) })
  await expect(sharedDetails).toContainText('Class equipment permissions are not granted by the sub-command.')
  await expect(sharedPermissions).toHaveCount(0)
  await page.getByRole('button', { name: 'Inspect Class: Warrior', exact: true }).click()
  await expect(sharedPermissions).toHaveCount(2)
  await expect(sharedPermissions.filter({ hasText: 'Swords' })).toBeVisible()
  await expect(sharedDetails).not.toContainText('Class equipment permissions are not granted by the sub-command.')
  const playthrough = before.playthroughs[before.selectedPlaythroughId!]!
  const character = Object.values(playthrough.characters).find(character => character.name === 'Rowan')!
  await page.goto(`/#/characters/${character.id}/current`)
  await expect(page.locator('.loadout-sheet')).toBeVisible()
  await checkLoadoutOrder(page.locator('.loadout-sheet'))
  expect(await storedData(page)).toEqual(before)
})

test('new and shared plans report their own persistence until explicitly saved', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  await page.goto('/#/builds/library/new')
  await expect(page.locator('.context-status')).toHaveText('Not yet saved')
  await page.goto('/#/teams/new')
  await expect(page.locator('.context-status')).toHaveText('Not yet saved')
  const before = await storedData(page)
  const build = Object.values(before.builds)[0]!
  const share = createShareUrl(createSharePayload(before, { kind: 'build', revisionId: build.latestRevisionId! }), `${baseURL}/`)
  await page.goto(share)
  await expect(page.locator('.context-status')).toHaveText('Read-only snapshot')
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.locator('.context-status')).toHaveText('Saved locally')
  const saved = await storedData(page)
  expect(Object.keys(saved.builds)).toHaveLength(Object.keys(before.builds).length + 1)
  await page.goto('/#/teams/new')
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
  await expect(details).toContainText('Class equipment permissions are not granted by the sub-command.')
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

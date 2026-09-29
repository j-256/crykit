import { expect, test, type Page } from '@playwright/test'

const COLLAPSED_RAIL_MAX_WIDTH_PX = 80
const DENSE_LIBRARY_CARD_MAX_HEIGHT_PX = 230
const DENSE_TEAM_CARD_MAX_HEIGHT_PX = 190

async function choose(page: Page, label: string, name: string) {
  const field = page.getByRole('combobox', { name: label, exact: true })
  await field.fill(name)
  await page.getByRole('listbox', { name: `Choose ${label}`, exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click()
}

test('team and library summaries show every equipment slot and PP crystal', async ({ page }) => {
  await page.goto('/#/builds/teams')
  const rowan = page.getByRole('region', { name: 'Rowan loadout', exact: true })
  await expect(rowan.locator('.build-card__equipment .build-card__selection')).toHaveCount(6)
  const shortSword = rowan.locator('[data-tooltip^="Main hand: Short Sword"]')
  await expect(shortSword).toBeVisible()
  await expect(shortSword).toHaveAttribute('data-tooltip', /Attack: 30/)
  await expect(rowan.locator('[data-tooltip^="Head: Empty"]')).toBeVisible()
  await expect(rowan.locator('.passive-capacity__crystals svg')).toHaveCount(10)
  await expect(rowan.locator('.passive-capacity__crystals svg.is-lit')).toHaveCount(0)

  await page.getByRole('button', { name: 'Build library', exact: true }).click()
  const card = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card').filter({ hasText: 'Rowan: sample Warrior' })
  await expect(card.locator('.build-card__equipment .build-card__selection')).toHaveCount(6)
  await expect(card.locator('[data-tooltip^="Accessory 2: Empty"]')).toBeVisible()

  await page.getByRole('button', { name: 'Compare revisions', exact: true }).click()
  await page.getByLabel('Revision A').selectOption({ index: 1 })
  await page.getByLabel('Revision B').selectOption({ index: 2 })
  const comparedLoadouts = page.locator('.comparison-grid--loadouts .comparison-column')
  await expect(comparedLoadouts).toHaveCount(2)
  await expect(comparedLoadouts.nth(0).locator('.build-card__equipment .build-card__selection')).toHaveCount(6)
  await expect(comparedLoadouts.nth(1).locator('.build-card__equipment .build-card__selection')).toHaveCount(6)
  await expect(page.locator('.comparison-evidence')).not.toHaveAttribute('open', '')
})

test('desktop build summaries use the available width and keep passing checks compact', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The mobile layout intentionally uses one full-width card')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#/builds/library')

  const libraryCards = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card')
  await expect(libraryCards).toHaveCount(4)
  const libraryBoxes = await libraryCards.evaluateAll(cards => cards.map(card => ({ y: card.getBoundingClientRect().y, height: card.getBoundingClientRect().height })))
  expect(new Set(libraryBoxes.map(box => box.y)).size).toBe(1)
  expect(Math.max(...libraryBoxes.map(box => box.height))).toBeLessThanOrEqual(DENSE_LIBRARY_CARD_MAX_HEIGHT_PX)

  await page.getByRole('button', { name: 'Team scenarios', exact: true }).click()
  const teamCards = page.locator('.scenario-member-card')
  await expect(teamCards).toHaveCount(4)
  const teamBoxes = await teamCards.evaluateAll(cards => cards.map(card => ({ y: card.getBoundingClientRect().y, height: card.getBoundingClientRect().height })))
  expect(new Set(teamBoxes.map(box => box.y)).size).toBe(1)
  expect(Math.max(...teamBoxes.map(box => box.height))).toBeLessThanOrEqual(DENSE_TEAM_CARD_MAX_HEIGHT_PX)
  await expect(page.locator('.validation-item--valid')).toHaveCount(0)
  await expect(page.locator('.validation-overview')).toContainText('checks clear')
})

test('selected builds open as loadouts and the desktop icon rail labels do not cover content', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The desktop icon rail is replaced by bottom navigation')
  await page.goto('/#/builds/library')
  await page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card').filter({ hasText: 'Rowan: sample Warrior' }).click()
  await expect(page.getByRole('region', { name: 'Equipment', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Build mechanics', exact: true })).not.toBeVisible()
  await expect(page.locator('.build-layout > .build-library')).toHaveCSS('position', 'sticky')

  const rail = page.locator('.rail')
  const main = page.locator('.main-shell')
  const collapsed = (await rail.boundingBox())!
  const mainBefore = (await main.boundingBox())!
  expect(collapsed.width).toBeLessThanOrEqual(COLLAPSED_RAIL_MAX_WIDTH_PX)
  const buildsNav = page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Builds', exact: true })
  await buildsNav.hover()
  await expect(buildsNav.locator('span')).toHaveCSS('opacity', '1')
  expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(COLLAPSED_RAIL_MAX_WIDTH_PX)
  expect((await main.boundingBox())!.x).toBe(mainBefore.x)

  const referenceNav = page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Reference', exact: true })
  await referenceNav.focus()
  await expect(referenceNav.locator('span')).toHaveCSS('opacity', '1')
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Build mechanics', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Equipment', exact: true })).not.toBeVisible()
})

test('invalid builds remain saveable and stay red in the library and team', async ({ page }) => {
  await page.goto('/#/builds/library/new')
  await choose(page, 'Equipped passive 1', 'Attack Focus')
  await choose(page, 'Equipped passive 2', 'Backstabber')
  await choose(page, 'Equipped passive 3', 'Duel Ready')
  await choose(page, 'Equipped passive 4', 'Counter')

  const editor = page.locator('.build-sheet')
  await expect(editor).toHaveAttribute('data-validity', 'invalid')
  await expect(editor).toHaveCSS('background-color', 'rgba(198, 111, 85, 0.1)')
  await expect(page.getByRole('region', { name: 'Build validity', exact: true })).toContainText('Build needs changes')
  await expect(page.getByRole('button', { name: 'Save build', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Save build', exact: true }).click()

  await page.getByRole('button', { name: 'Build library', exact: true }).click()
  const card = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card').filter({ hasText: 'Untitled build' })
  await expect(card.locator('.build-loadout-summary')).toHaveAttribute('data-validity', 'invalid')
  await expect(card).toContainText('Needs changes')
  await expect(card).toHaveCSS('background-color', 'rgba(198, 111, 85, 0.16)')

  await page.getByRole('button', { name: 'Team scenarios', exact: true }).click()
  const rowan = page.getByRole('region', { name: 'Rowan loadout', exact: true })
  const invalidRevisionId = await rowan.getByRole('option').filter({ hasText: 'Untitled build' }).getAttribute('value')
  expect(invalidRevisionId).toBeTruthy()
  await rowan.getByRole('combobox', { name: 'Rowan', exact: true }).selectOption(invalidRevisionId!)
  await expect(rowan.locator('.build-loadout-summary')).toHaveAttribute('data-validity', 'invalid')
  await expect(rowan).toContainText('Needs changes')
  await expect(rowan).toHaveCSS('background-color', 'rgba(198, 111, 85, 0.16)')
})

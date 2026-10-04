import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'

const COLLAPSED_RAIL_MAX_WIDTH_PX = 80
const RAIL_CONTROL_WIDTH_PX = 48
const RAIL_TOGGLE_WIDTH_PX = 32
const EXPANDED_RAIL_WIDTH_PX = 232
const DENSE_LIBRARY_CARD_MAX_HEIGHT_PX = 230
const DENSE_TEAM_CARD_MAX_HEIGHT_PX = 190

async function choose(page: Page, label: string, name: string) {
  const field = page.getByRole('combobox', { name: label, exact: true })
  await field.fill(name)
  await page.getByRole('listbox', { name: `Choose ${label}`, exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click()
}

async function railControlGeometry(page: Page) {
  return page.locator('.rail .nav-link').evaluateAll(controls => controls.map(control => {
    const box = control.getBoundingClientRect()
    const icon = control.querySelector('svg')!.getBoundingClientRect()
    return {
      isToggle: control.classList.contains('rail__toggle'),
      isTool: control.closest('.nav-tools') !== null,
      isFooter: control.closest('.rail__footer') !== null,
      y: box.y,
      width: box.width,
      height: box.height,
      centerX: box.x + box.width / 2,
      iconY: icon.y,
      iconWidth: icon.width,
      iconHeight: icon.height,
    }
  }))
}

async function visibleArtworkOffset(locator: ReturnType<Page['locator']>) {
  return locator.evaluate(async (container) => {
    const image = container.querySelector('img')
    if (!(image instanceof HTMLImageElement)) throw new Error('Artwork image was not found')
    if (!image.complete) await new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => reject(new Error('Artwork image failed to load')), { once: true })
    })
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas context was unavailable')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let minX = canvas.width
    let maxX = -1
    let minY = canvas.height
    let maxY = -1
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    if (maxX < 0 || maxY < 0) throw new Error('Artwork image had no visible pixels')
    const imageBounds = image.getBoundingClientRect()
    const containerBounds = container.getBoundingClientRect()
    const visibleCenterX = imageBounds.left + ((minX + maxX + 1) / 2) * (imageBounds.width / canvas.width)
    const visibleCenterY = imageBounds.top + ((minY + maxY + 1) / 2) * (imageBounds.height / canvas.height)
    return {
      x: visibleCenterX - (containerBounds.left + containerBounds.width / 2),
      y: visibleCenterY - (containerBounds.top + containerBounds.height / 2),
    }
  })
}

test('team and library summaries show every equipment slot and PP crystal', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/teams')
  const rowan = page.getByRole('region', { name: 'Rowan loadout', exact: true })
  await expect(rowan.locator('.build-card__equipment .build-card__selection')).toHaveCount(6)
  const shortSword = rowan.locator('[data-tooltip^="Main hand: Short Sword"]')
  await expect(shortSword).toBeVisible()
  await expect(shortSword).toHaveAttribute('data-tooltip', /Attack: \+30/)
  await expect(shortSword).toHaveAttribute('data-tooltip', /One-handed/)
  await expect(shortSword).not.toHaveAttribute('data-tooltip', /Hands: 1/)
  await expect(shortSword.locator('.build-card__hand-badge')).toHaveCount(0)
  const centeredArtwork = await visibleArtworkOffset(shortSword)
  expect(Math.abs(centeredArtwork.x)).toBeLessThan(1)
  expect(Math.abs(centeredArtwork.y)).toBeLessThan(1)
  await expect(rowan.locator('[data-tooltip^="Head: Empty"]')).toBeVisible()
  await expect(rowan.locator('.passive-capacity__crystals svg')).toHaveCount(10)
  await expect(rowan.locator('.passive-capacity__crystals svg.is-lit')).toHaveCount(0)

  await page.getByRole('button', { name: 'Build library', exact: true }).click()
  const card = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card').filter({ hasText: 'Rowan: sample Warrior' })
  await expect(card.locator('.build-card__equipment .build-card__selection')).toHaveCount(6)
  await expect(card.locator('[data-tooltip^="Accessory 2: Empty"]')).toBeVisible()
  await expect(card.locator('[data-tooltip^="Accessory 2: Empty"] [data-empty-slot-icon="ring"]')).toBeVisible()
  await expect(card.locator('[data-tooltip^="Accessory 2: Empty"] [data-ring-gem="true"]')).toBeVisible()
  const mira = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card').filter({ hasText: 'Mira: sample Cleric' })
  const miraMainHand = mira.locator('[data-tooltip^="Main hand: Short Staff"]')
  const miraOffHand = mira.locator('[data-occupied-by-two-handed="Short Staff"]')
  await expect(miraMainHand).toHaveAttribute('data-tooltip', /Two-handed/)
  await expect(mira.locator('.build-card__hand-badge')).toHaveCount(0)
  await expect(miraOffHand).toHaveAttribute('data-tooltip', /Off hand: Occupied by Short Staff/)
  expect(await miraOffHand.locator('img').getAttribute('src')).toBe(await miraMainHand.locator('img').getAttribute('src'))
  await expect(miraOffHand.locator('.wiki-sprite, .game-icon, .artwork-placeholder')).toHaveCSS('filter', 'grayscale(1)')
  await expect(miraOffHand.locator('.wiki-sprite, .game-icon, .artwork-placeholder')).toHaveCSS('opacity', '0.46')
  const sol = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card').filter({ hasText: 'Sol: sample Wizard' })
  await expect(sol.locator('[data-tooltip^="Main hand: Oak Wand"]')).toHaveAttribute('data-tooltip', 'Main hand: Oak Wand\nOne-handed\nAttack: +42\nMind: +12\nMax. MP: +4\nCost: 60 Copper')

  await page.getByRole('button', { name: 'Compare revisions', exact: true }).click()
  await page.getByLabel('Revision A').selectOption({ index: 1 })
  await page.getByLabel('Revision B').selectOption({ index: 2 })
  const comparedLoadouts = page.locator('.comparison-grid--loadouts .comparison-column')
  await expect(comparedLoadouts).toHaveCount(2)
  await expect(comparedLoadouts.nth(0).locator('.build-card__equipment .build-card__selection')).toHaveCount(6)
  await expect(comparedLoadouts.nth(1).locator('.build-card__equipment .build-card__selection')).toHaveCount(6)
  await expect(page.locator('.comparison-evidence')).not.toHaveAttribute('open', '')
})

test('desktop character and build summaries share a compact card width', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The mobile layout intentionally uses one full-width card')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/#/builds/library')

  const libraryCards = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card')
  await expect(libraryCards).toHaveCount(4)
  const libraryBoxes = await libraryCards.evaluateAll(cards => cards.map(card => ({ y: card.getBoundingClientRect().y, width: card.getBoundingClientRect().width, height: card.getBoundingClientRect().height })))
  expect(new Set(libraryBoxes.map(box => box.y)).size).toBe(1)
  expect(Math.max(...libraryBoxes.map(box => box.height))).toBeLessThanOrEqual(DENSE_LIBRARY_CARD_MAX_HEIGHT_PX)

  await page.goto('/#/builds/teams')
  const teamCards = page.locator('.scenario-member-card')
  await expect(teamCards).toHaveCount(4)
  const teamBoxes = await teamCards.evaluateAll(cards => cards.map(card => ({ y: card.getBoundingClientRect().y, height: card.getBoundingClientRect().height })))
  expect(new Set(teamBoxes.map(box => box.y)).size).toBe(1)
  expect(Math.max(...teamBoxes.map(box => box.height))).toBeLessThanOrEqual(DENSE_TEAM_CARD_MAX_HEIGHT_PX)
  await expect(page.locator('.validation-item--valid')).toHaveCount(0)
  await expect(page.locator('.validation-overview')).toContainText('checks clear')

  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  const characterCards = page.getByRole('region', { name: 'Character overview', exact: true }).getByRole('article')
  const characterBoxes = await characterCards.evaluateAll(cards => cards.map(card => ({ y: card.getBoundingClientRect().y, width: card.getBoundingClientRect().width })))
  expect(new Set(characterBoxes.map(box => box.y)).size).toBe(1)
  expect(Math.abs(characterBoxes[0]!.width - libraryBoxes[0]!.width)).toBeLessThan(1)
  const miraCard = characterCards.filter({ hasText: 'Mira' })
  await expect(miraCard.locator('.roster-equipment .roster-slot__hand-badge')).toHaveCount(0)
  await expect(miraCard.locator('.roster-equipment [data-occupied-by-two-handed="Short Staff"]')).toBeVisible()
  await expect(miraCard.locator('.roster-equipment [data-empty-slot-icon="ring"]')).toHaveCount(2)
  await expect(miraCard.locator('.roster-equipment [data-ring-gem="true"]')).toHaveCount(2)
})

test('selected builds open as loadouts and the desktop sidebar starts expanded and remains collapsible', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The desktop sidebar is replaced by bottom navigation')
  await page.goto('/#/builds/library')
  const rowan = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card').filter({ hasText: 'Rowan: sample Warrior' })
  await rowan.getByRole('button', { name: 'Open Main hand: Short Sword', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Equipment', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Build mechanics', exact: true })).not.toBeVisible()
  await expect(page.locator('.build-layout > .build-library')).not.toHaveAttribute('open')
  await expect(page.locator('.build-layout > .build-library')).toHaveCSS('position', 'static')
  const mainHand = page.getByRole('combobox', { name: 'Main hand', exact: true })
  const focusedSlot = page.locator('.slot-entry').filter({ has: mainHand })
  await expect(page).toHaveURL(/focus=slot%3A/)
  await expect(focusedSlot).toBeFocused()
  await expect(mainHand).toHaveValue('Short Sword')
  await expect(mainHand).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('complementary', { name: 'Selection details', exact: true })).toContainText('Short Sword')
  const detailArtwork = page.getByRole('complementary', { name: 'Selection details', exact: true }).locator('.wiki-sprite')
  const centeredDetailArtwork = await visibleArtworkOffset(detailArtwork)
  expect(Math.abs(centeredDetailArtwork.x)).toBeLessThan(1)
  expect(Math.abs(centeredDetailArtwork.y)).toBeLessThan(1)

  const scrollBeforeAccessory = await page.evaluate(() => window.scrollY)
  await page.locator('.build-library > summary').click()
  const selectedRowan = page.locator('.build-library .build-card').filter({ hasText: 'Rowan: sample Warrior' })
  await selectedRowan.getByRole('button', { name: 'Open Accessory 1: Empty', exact: true }).click()
  const accessory = page.getByRole('combobox', { name: 'Accessory 1', exact: true })
  const focusedAccessory = page.locator('.slot-entry').filter({ has: accessory })
  await expect(focusedAccessory).toBeFocused()
  await expect(accessory).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBeforeAccessory)
  await expect.poll(() => focusedAccessory.evaluate(element => {
    const box = element.getBoundingClientRect()
    return Math.abs(box.top + box.height / 2 - window.innerHeight / 2)
  })).toBeLessThanOrEqual(2)

  const rail = page.locator('.rail')
  const main = page.locator('.main-shell')
  const desktopBrandHeader = page.locator('.desktop-brand-header')
  const footer = rail.locator('.rail__footer')
  const progressSublist = rail.getByRole('list', { name: 'Progress pages', exact: true })
  await expect(progressSublist).toBeVisible()
  const progressSublistSpace = await progressSublist.evaluate(element => {
    const style = getComputedStyle(element)
    return element.getBoundingClientRect().height + Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom)
  })
  const expanded = (await rail.boundingBox())!
  const expandedMain = (await main.boundingBox())!
  const expandedBrandHeader = (await desktopBrandHeader.boundingBox())!
  const expandedFooter = (await footer.boundingBox())!
  const expandedControls = await railControlGeometry(page)
  expect(expanded.width).toBe(EXPANDED_RAIL_WIDTH_PX)
  expect(expanded.y).toBe(expandedBrandHeader.y + expandedBrandHeader.height)
  await expect(rail).toHaveCSS('border-right-width', '1px')
  await expect(page.locator('.rail .menu-window')).toHaveCSS('box-shadow', 'none')
  await expect(page.locator('.rail__footer')).toHaveCSS('box-shadow', 'none')
  const planningLabel = rail.locator('.nav-section__label').filter({ hasText: 'Planning' })
  const trackingLabel = rail.locator('.nav-section__label').filter({ hasText: 'Tracking' })
  await expect(planningLabel).toBeVisible()
  await expect(trackingLabel).toBeVisible()
  const buildsNav = page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Builds', exact: true })
  await expect(buildsNav.locator('span')).toBeVisible()
  const collapseToggle = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
  const dataButton = page.getByRole('button', { name: 'Data & settings', exact: true })
  expect((await collapseToggle.boundingBox())!.y).toBeGreaterThan((await dataButton.boundingBox())!.y)
  await collapseToggle.click()
  await expect(page.locator('.rail__toggle svg')).toHaveCSS('transform', 'matrix(-1, 0, 0, -1, 0, 0)')
  const collapsedRail = (await rail.boundingBox())!
  const collapsedBrandHeader = (await desktopBrandHeader.boundingBox())!
  const collapsedFooter = (await footer.boundingBox())!
  const railBottomPadding = await rail.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingBottom))
  expect(collapsedRail.width).toBeLessThanOrEqual(COLLAPSED_RAIL_MAX_WIDTH_PX)
  expect(collapsedFooter.y + collapsedFooter.height + railBottomPadding).toBe(collapsedRail.y + collapsedRail.height)
  expect(collapsedBrandHeader).toEqual(expandedBrandHeader)
  await expect(desktopBrandHeader.locator('.brand__name')).toBeVisible()
  await expect(planningLabel).toBeHidden()
  await expect(trackingLabel).toBeHidden()
  await expect(progressSublist).toBeHidden()
  const collapsedControls = await railControlGeometry(page)
  expect(collapsedControls).toHaveLength(expandedControls.length)
  for (const [index, control] of collapsedControls.entries()) {
    const expandedControl = expandedControls[index]
    const shiftY = control.isTool ? -progressSublistSpace : control.isFooter ? collapsedFooter.y - expandedFooter.y : 0
    expect(control.width).toBe(control.isToggle ? RAIL_TOGGLE_WIDTH_PX : RAIL_CONTROL_WIDTH_PX)
    expect(control.y).toBe(expandedControl.y + shiftY)
    expect(control.height).toBe(expandedControl.height)
    expect(control.iconY).toBe(expandedControl.iconY + shiftY)
    expect(control.iconWidth).toBe(expandedControl.iconWidth)
    expect(control.iconHeight).toBe(expandedControl.iconHeight)
    expect(control.centerX).toBe(collapsedRail.x + collapsedRail.width / 2)
  }
  expect((await main.boundingBox())!.x).toBeLessThan(expandedMain.x)
  await buildsNav.hover()
  await expect(buildsNav.locator('span')).toHaveCSS('opacity', '1')
  expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(COLLAPSED_RAIL_MAX_WIDTH_PX)

  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await expect(progressSublist).toBeVisible()
  expect((await rail.boundingBox())!.width).toBe(EXPANDED_RAIL_WIDTH_PX)
  expect((await main.boundingBox())!.x).toBe(expandedMain.x)

  const referenceNav = page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Reference', exact: true })
  await expect(referenceNav.locator('span')).toBeVisible()
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

  await page.getByRole('button', { name: 'Back to Build library', exact: true }).click()
  const card = page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card').filter({ hasText: 'Untitled build' })
  await expect(card.locator('.build-loadout-summary')).toHaveAttribute('data-validity', 'invalid')
  await expect(card).toContainText('Needs changes')
  await expect(card).toHaveCSS('background-color', 'rgba(198, 111, 85, 0.16)')

  await page.goto('/#/teams/new')
  const slot = page.getByRole('region', { name: 'Team slot 1 loadout', exact: true })
  const invalidRevisionId = await slot.getByRole('option').filter({ hasText: 'Untitled build' }).getAttribute('value')
  expect(invalidRevisionId).toBeTruthy()
  await slot.getByRole('combobox', { name: 'Team slot 1', exact: true }).selectOption(invalidRevisionId!)
  await expect(slot.locator('.build-loadout-summary')).toHaveAttribute('data-validity', 'invalid')
  await expect(slot).toContainText('Needs changes')
  await expect(slot).toHaveCSS('background-color', 'rgba(198, 111, 85, 0.16)')
})

import { skipInitialModSetup } from './local-data-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test } from '@playwright/test'

test('home opens the build library and separates tracking on desktop and touch', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }, testInfo) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page).toHaveURL(/#\/builds\/library$/)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const library = page.getByRole('region', { name: 'Build library', exact: true })
  const warriorButton = page.getByRole('button', { name: /Rowan: sample Warrior/ })
  const warrior = library.getByRole('article').filter({ has: warriorButton })
  await expect(warriorButton).toBeVisible()
  await expect(warrior.locator('.build-card__classes')).toContainText('Warrior')
  const equipment = warrior.locator('.build-card__summary-group').filter({ hasText: 'Equipment' })
  await expect(equipment).toContainText('Short Sword')
  await expect(equipment).toContainText('Buckler')
  await expect(equipment).toContainText('Breastplate')
  await expect(warrior.locator('.build-card__summary-group').filter({ hasText: 'Passives' })).toContainText('No passives selected')
  await expect(warrior.locator('.wiki-sprite img')).toHaveCount(4)
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Playthrough: Sample playthrough', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Party plan:/ })).toHaveCount(0)
  const menu = page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true })
  const destinations = ['Builds', 'Teams', 'Reference', 'World Map', 'Mods', 'Save Editor', 'Characters', 'Inventory', 'Progress']
  await expect(menu.getByRole('button')).toHaveText(isMobile ? [...destinations, 'More'] : destinations)
  await expect(menu.getByRole('group', { name: 'Tracking', exact: true }).getByRole('button')).toHaveText(['Characters', 'Inventory', 'Progress'])
  await expect(menu.getByRole('button', { name: 'Builds', exact: true })).toHaveAttribute('aria-current', 'page')
  if (isMobile) {
    const mainBounds = (await page.locator('.main-shell').boundingBox())!
    const menuBounds = (await menu.boundingBox())!
    expect(mainBounds.y + mainBounds.height).toBeLessThanOrEqual(menuBounds.y)
    expect(menuBounds.height).toBeLessThanOrEqual(70)
    for (const button of await menu.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded()
      const bounds = (await button.boundingBox())!
      expect(bounds.height).toBeGreaterThanOrEqual(44)
      expect(bounds.width).toBeGreaterThanOrEqual(44)
      expect(await button.evaluate((target) => {
        const bounds = target.getBoundingClientRect()
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        return hit === target || target.contains(hit)
      })).toBe(true)
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('build-library-navigation.png'), fullPage: true })

  const reference = menu.getByRole('button', { name: 'Reference', exact: true })
  if (isMobile) await reference.tap()
  else await reference.press('Enter')
  await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Party plan:/ })).toHaveCount(0)
  const inventory = menu.getByRole('button', { name: 'Inventory', exact: true })
  if (isMobile) await inventory.tap()
  else await inventory.press('Enter')
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await expect(inventory).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Party plan: Sample starter team', exact: true })).toBeVisible()
  await page.goBack()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  await expect(reference).toHaveAttribute('aria-current', 'page')
  const inspector = menu.getByRole('button', { name: 'Mods', exact: true })
  if (isMobile) await inspector.tap()
  else await inspector.press('Enter')
  await expect(page.getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
  await expect(page.locator('.context-bar').getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Playthrough:/ })).toHaveCount(0)
})

test('direct settings return to Builds and saved build tracking requires an explicit choice', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  await page.goto('/#/settings/data')
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/library$/)
  await page.getByRole('region', { name: 'Build library', exact: true }).getByRole('button', { name: /Rowan: sample Warrior/ }).click()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
  await expect(page.getByRole('button', { name: 'Record as current', exact: true })).not.toBeVisible()
  const readiness = page.locator('.build-readiness')
  await expect(readiness).not.toHaveAttribute('open')
  if (isMobile) {
    await page.locator('.main-shell').evaluate((element) => element.scrollTo(0, 0))
    await expect(readiness).not.toBeInViewport()
  }
  await readiness.locator('summary').first().click()
  await expect(readiness.getByRole('heading', { name: 'Tracking and readiness', exact: true })).toBeVisible()
  await readiness.getByRole('button', { name: 'Compare / record on a character', exact: true }).click()
  const recording = page.locator('dialog').filter({ has: page.getByRole('heading', { name: 'Compare and record Build', exact: true }) })
  await expect(recording.getByRole('button', { name: 'Record as current', exact: true })).toBeDisabled()
  await recording.getByRole('button', { name: 'Close comparison', exact: true }).click()
  await expect(recording).not.toBeVisible()
})

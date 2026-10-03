import { referencePath } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Locator, type Page } from '@playwright/test'

async function loadedIcons(container: Locator, count: number) {
  const images = container.locator('img')
  await expect(images).toHaveCount(count)
  await expect.poll(() => images.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0))).toBe(true)
  expect(await images.evaluateAll(nodes => nodes.every(node => new URL((node as HTMLImageElement).src).origin === location.origin))).toBe(true)
}

async function characterDetails(page: Page) {
  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  await page.getByRole('article', { name: 'Rowan', exact: true }).getByRole('link', { name: 'Rowan', exact: true }).click()
  const desktop = page.getByRole('complementary', { name: 'Selection details', exact: true }).filter({ visible: true })
  if (await desktop.count() === 0) {
    await page.getByText('About Warrior', { exact: true }).click()
    return page.locator('.member-mobile-detail[open] .build-selection-details')
  }
  return desktop
}

test('game icons accompany character equipment, inventory, and both pickers without external requests', { tag: MOBILE_TEST_TAG }, async ({ page, context, isMobile }) => {
  const external: string[] = []
  page.on('request', request => { if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url()) })
  await page.goto('/#/inventory')
  const sword = page.locator('.list-row').filter({ has: page.getByText('Short Sword', { exact: true }) })
  await loadedIcons(sword, 1)
  const details = await characterDetails(page)
  const facts = details.locator('.definition-list').first()
  const weapons = facts.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Weapons$/ }) })
  await expect(weapons).toContainText('Swords, Axes, Daggers, Spears')
  await loadedIcons(weapons, 4)
  const armor = facts.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Armor$/ }) })
  await loadedIcons(armor, 3)
  for (const image of await armor.locator('img').all()) await expect(image).toHaveAttribute('src', /equipment-types-[^/]+\.png$/)
  await details.getByText('All reference fields & sources', { exact: true }).click()
  await details.getByText('Menu icon sources', { exact: true }).click()
  await expect(details.getByRole('link', { name: 'swords', exact: true })).toHaveAttribute('href', /File.*SwordAbilityIcon.*oldid=/)

  await page.getByRole('button', { name: 'Choose Main hand', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose Main hand', exact: true })
  await picker.getByRole('searchbox').fill('Short Sword')
  const choice = picker.locator('[data-definition-result]').filter({ has: page.getByText('Short Sword', { exact: true }) })
  await loadedIcons(choice, 1)
  await choice.click()
  await page.goto('/#/builds/library/new')
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Warrior')
  const warrior = page.getByRole('option').filter({ has: page.getByText('Warrior', { exact: true }) })
  await loadedIcons(warrior, 9)
  await warrior.click()
  const selectedDetails = isMobile ? page.locator('.build-field').filter({ has: page.getByRole('combobox', { name: 'Class', exact: true }) }).locator('.build-field__evidence > details > summary') : page.getByRole('complementary', { name: 'Selection details', exact: true }).getByRole('heading', { name: 'Warrior', exact: true })
  if (isMobile) {
    await expect(selectedDetails).toHaveText('Details')
    await expect(selectedDetails).toHaveAccessibleName('Details for Warrior')
  } else {
    await loadedIcons(selectedDetails, 1)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Cancel and discard', exact: true }).click()

  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.goto(referencePath('base:job:0'))
  await page.reload()
  await loadedIcons(page.locator('.icon-values').filter({ hasText: 'Swords, Axes, Daggers, Spears' }), 4)
  expect(external).toEqual([])
})

test('failed menu icons retain readable equipment labels', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.route(/\.(?:gif|png|webp)(?:\?|$)/, route => route.abort())
  await page.goto(`${baseURL}${referencePath('base:job:0')}`)
  const weapons = page.locator('.icon-values').filter({ hasText: 'Swords, Axes, Daggers, Spears' })
  await expect(weapons).toBeVisible()
  await expect(weapons.locator('img')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toBeVisible()
  await context.close()
})

import { MOBILE_TEST_TAG } from './test-tags'
import { referencePath as detail } from './reference-helpers'
import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Page } from '@playwright/test'

const WARRIOR = detail('base:class:warrior')

async function expectArtwork(page: Page, name: string, source: 'game' | 'wiki' = 'game') {
  const image = page.getByRole('img', { name: `${name} ${source} artwork`, exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  expect(await image.evaluate(element => new URL((element as HTMLImageElement).src).origin === location.origin)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('native artwork stays quiet and wiki fallbacks retain attribution offline', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  const external: string[] = []
  page.on('request', request => { if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) external.push(request.url()) })
  await page.goto(WARRIOR)
  await expectArtwork(page, 'Warrior')
  await expect(page.getByText('Artwork source', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/fingerprint|job\.dat record/)).toHaveCount(0)

  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expectArtwork(page, 'Warrior')
  for (const [id, name, source] of [['base:item:short-sword', 'Short Sword', 'game'], ['base:monster:slime', 'Slime', 'wiki']] as const) {
    await page.goto(detail(id))
    await expectArtwork(page, name, source)
    if (source === 'wiki') {
      await page.getByText('Artwork source', { exact: true }).click()
      await expect(page.getByRole('link', { name: 'Slime.png', exact: true })).toHaveAttribute('href', /oldid=\d+$/)
    }
  }
  expect(external).toEqual([])
})

test('reference results retain names and unmatched definitions use placeholders without inventing images', async ({ page }) => {
  await page.goto('/#/reference?v=1&kind=class')
  const card = page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Aegis', exact: true }) })
  await expect(card).toHaveCount(1)
  await expect(card).toBeVisible()
  await expect(card.locator('img')).toHaveAttribute('alt', '')
  await card.click()
  await expectArtwork(page, 'Aegis')
  await page.goto(detail('mod:barbarian:class:barbarian'))
  await expect(page.getByRole('heading', { name: 'Barbarian', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Barbarian artwork placeholder', exact: true })).toBeVisible()
  await expect(page.getByText('No exact artwork linked.', { exact: true })).toBeVisible()
  await expect(page.locator('.wiki-sprite img')).toHaveCount(0)
})

test('the baseline includes the versioned innate unlock evidence', async ({ page }) => {
  await page.goto(detail('base:warrior:innate:fighter'))
  await expect(page.getByRole('heading', { name: 'Fighter', exact: true })).toBeVisible()
  const unlockCost = page.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Learnable Innate Skill v1\.0 JP cost$/ }) })
  await expect(unlockCost).toContainText('500')
})

test('failed sprite loading preserves the definition and an explicit fallback', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.route(/\.(?:gif|png|webp)(?:\?|$)/, route => route.abort())
  await page.goto(`${baseURL}${WARRIOR}`)
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Warrior artwork placeholder', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Definition facts', exact: true })).toBeVisible()
  await context.close()
})

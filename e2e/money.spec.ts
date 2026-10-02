import { referencePath } from './reference-helpers'
import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Locator, type Page } from '@playwright/test'
import gameArtwork from '../src/catalog/game-artwork.json' with { type: 'json' }

const COIN_ARTWORK = { gold: gameArtwork.uiArtwork.goldCoin.asset, silver: gameArtwork.uiArtwork.silverCoin.asset, copper: gameArtwork.uiArtwork.copperCoin.asset }

function costRow(page: Page) {
  return page.getByRole('region', { name: 'Definition facts', exact: true }).locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Cost \(copper\)$/ }) })
}

async function loadedCoins(container: Locator, count: number) {
  const images = container.locator('.money-coin img')
  await expect(images).toHaveCount(count)
  await expect.poll(() => images.evaluateAll(nodes => nodes.every(node => {
    const image = node as HTMLImageElement
    return image.complete && image.naturalWidth === 16 && image.naturalHeight === 18 && new URL(image.src).origin === location.origin
  }))).toBe(true)
  for (const [coin, asset] of Object.entries(COIN_ARTWORK)) {
    const image = container.locator(`.money-coin[data-coin="${coin}"] img`)
    if (await image.count()) await expect(image).toHaveAttribute('src', new RegExp(`${asset}-[^/]+\\.png$`))
  }
}

test('whole and mixed coin prices use local icons and remain available offline', async ({ page, context }) => {
  const external: string[] = []
  page.on('request', request => { if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url()) })
  for (const [entityId, label, coins] of [
    ['base:item:cosplay-garb', '10 silver', 1],
    ['base:item:acrobat-shoes', '3 gold, 50 silver', 2],
    ['base:item:bronze-suit', '7 silver, 10 copper', 2],
    ['base:item:archmage-vest', '25 gold', 1],
  ] as const) {
    await page.goto(referencePath(entityId))
    await expect(costRow(page).getByRole('img', { name: label, exact: true })).toBeVisible()
    await loadedCoins(costRow(page), coins)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }

  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.goto(referencePath('base:item:bronze-suit'))
  await page.reload()
  await expect(costRow(page).getByRole('img', { name: '7 silver, 10 copper', exact: true })).toBeVisible()
  await loadedCoins(costRow(page), 2)
  expect(external).toEqual([])
})

test('shop tables and descriptions show coins while editing retains the original source value', async ({ page }) => {
  await page.goto(referencePath('base:location:delende-camp-armor-shop'))
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Stout Shield', exact: true }) })
  await expect(row.getByRole('img', { name: '30 copper', exact: true })).toBeVisible()
  await loadedCoins(row, 1)

  await page.goto(referencePath('base:item:gold-bow'))
  const description = page.locator('.reference-detail > div').filter({ has: page.getByRole('heading', { name: 'Gold Bow', exact: true }) }).locator('p').first()
  await expect(description.getByRole('img', { name: '30 silver', exact: true })).toBeVisible()
  await expect(description).toContainText('Silver Bow x1')
  await expect(description).toContainText('Gold Ingot x3')

  await page.goto(referencePath('base:item:cosplay-garb'))
  await page.getByRole('button', { name: 'Quick edit', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Cost (copper)', exact: true }).getByRole('img', { name: '10 silver', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'New Cost (copper)', exact: true })).toHaveText('1000')
})

test('definition picker descriptions use the same coin display', async ({ page }) => {
  await page.goto('/#/inventory')
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  await page.getByRole('button', { name: 'Choose Item definition', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search available definitions', exact: true }).fill('Gold Bow')
  const choice = page.locator('[data-definition-result]').filter({ has: page.getByText('Gold Bow', { exact: true }) }).first()
  await expect(choice.getByRole('img', { name: '30 silver', exact: true })).toBeAttached()
  await loadedCoins(choice, 1)
  await expect(choice.locator('.picker-result__description')).toHaveAttribute('title', /30 silver/)
})

test('failed coin images preserve readable denomination labels', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.route(url => Object.values(COIN_ARTWORK).some(asset => url.pathname.startsWith(`/assets/${asset}-`)), route => route.abort())
  await page.goto(`${baseURL}${referencePath('base:item:acrobat-shoes')}`)
  const cost = costRow(page)
  await expect(cost.getByRole('img', { name: '3 gold, 50 silver', exact: true })).toBeVisible()
  await expect(cost.locator('.money-coin img')).toHaveCount(0)
  await expect(cost.locator('.money-coin__fallback')).toHaveText(['gold', 'silver'])
  await context.close()
})

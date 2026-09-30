import { expect, test, type Page } from '@playwright/test'

const detail = (id: string) => `/#/reference/catalog/crystal-project-public-starter/revisions/bundled-v2/entities/${encodeURIComponent(id)}`

async function expectArtwork(page: Page, name: string, type: 'game' | 'mod') {
  const image = page.getByRole('img', { name: `${name} ${type} artwork`, exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

test('Equipment Expansion hides base-game proof and retains custom artwork attribution', async ({ page }) => {
  await page.goto(detail('equipment-expansion:item:heavy-edge'))
  await expectArtwork(page, 'Heavy Edge', 'game')
  await expect(page.getByText('Artwork source', { exact: true })).toHaveCount(0)

  await page.goto(detail('equipment-expansion:item:triton-s-cloak'))
  await expectArtwork(page, "Triton's Cloak", 'mod')
  await page.getByText('Artwork source', { exact: true }).click()
  await expect(page.locator('.wiki-sprite-source')).toContainText('Equipment/zrghr-2-32x32, cell 43')
})

import { referencePath as detail } from './reference-helpers'
import { expect, test, type Page } from '@playwright/test'

async function expectArtwork(page: Page, name: string, type: 'game' | 'mod') {
  const image = page.getByRole('img', { name: `${name} ${type} artwork`, exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

test('Equipment Expansion hides base-game proof and retains custom artwork attribution', async ({ page }) => {
  await page.goto(detail('mod:equipment-expansion:equipment:592'))
  await expectArtwork(page, 'Heavy Edge', 'game')
  await expect(page.getByText('Artwork source', { exact: true })).toHaveCount(0)

  await page.goto(detail('mod:equipment-expansion:equipment:642'))
  await expectArtwork(page, "Triton's Cloak", 'mod')
  await page.getByRole('button', { name: "Sources for Triton's Cloak", exact: true }).click()
  await expect(page.getByRole('dialog', { name: "Sources for Triton's Cloak", exact: true })).toContainText('Equipment/zrghr-2-32x32, cell 43')
})

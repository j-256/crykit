import { referencePath as detail } from './reference-helpers'
import { expect, test, type Page } from '@playwright/test'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectOfflineReady } from './offline-helpers'

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

test('Moonlight artwork appears in class pickers, saved loadouts, and Reference offline', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(detail('mod:moonlight-project:class:26'))
  await expectArtwork(page, 'Freelancer', 'mod')
  const referenceUrl = await page.getByRole('img', { name: 'Freelancer mod artwork', exact: true }).getAttribute('src')
  await page.getByRole('button', { name: 'Sources for Freelancer', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sources for Freelancer', exact: true })).toContainText('Actor/MP_Ai_Overworld')
  await page.getByRole('dialog', { name: 'Sources for Freelancer', exact: true }).getByRole('button', { name: 'Close sources', exact: true }).click()
  await page.goto('/#/builds/library/new')
  const field = page.getByRole('combobox', { name: 'Class', exact: true })
  await field.fill('Freelancer')
  const choices = page.getByRole('listbox', { name: 'Choose Class', exact: true })
  const option = choices.getByRole('option').filter({ has: page.locator('strong', { hasText: /^Freelancer$/ }) })
  const portrait = option.locator('[data-artwork-source="mod"] img')
  await expect(portrait).toBeVisible()
  await expect(portrait).toHaveAttribute('src', referenceUrl!)
  await expect.poll(() => portrait.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await option.click()
  await page.getByRole('dialog', { name: 'Enable Moonlight Project?', exact: true }).getByRole('button', { name: 'Enable and select Freelancer', exact: true }).click()
  await expect(field).toHaveValue('Freelancer')
  await expect(page.locator('.build-field__artwork [data-artwork-source="mod"] img').first()).toHaveAttribute('src', referenceUrl!)
  await page.getByLabel('Build title', { exact: true }).fill('Synthetic mod artwork build')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Synthetic mod artwork build', exact: true })).toBeVisible()
  const checkpointUrl = page.url()
  await expect(page.locator('.build-field__artwork [data-artwork-source="mod"] img').first()).toHaveAttribute('src', referenceUrl!)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Synthetic mod artwork build', exact: true })).toBeVisible()
  const savedPortrait = page.locator('.build-field__artwork [data-artwork-source="mod"] img').first()
  await expect(savedPortrait).toHaveAttribute('src', referenceUrl!)
  await expect.poll(() => savedPortrait.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.goto(detail('mod:moonlight-project:class:26'))
  await expectArtwork(page, 'Freelancer', 'mod')
  expect(checkpointUrl).toContain('#/builds/')
  expect(errors).toEqual([])
})

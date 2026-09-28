import { createBlankPlaythrough } from './profile-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import type { Profile } from '../src/domain/types'

async function navigate(page: Page, destination: string) {
  await page.getByRole('button', { name: new RegExp(`^${destination}$`) }).filter({ visible: true }).click()
}

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportProfile(page: Page): Promise<Profile> {
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const path = await (await downloaded).path()
  if (!path) throw new Error('Expected a completed backup download')
  const entries = unzipSync(await readFile(path))
  const bundle = JSON.parse(strFromU8(entries['bundle.json']!)) as { profile: Profile }
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return bundle.profile
}

async function setHash(page: Page, hash: string) {
  await page.evaluate((nextHash) => { window.location.hash = nextHash }, hash)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(hash)
}

async function expectActiveDialog(page: Page, title: string) {
  await expect.poll(() => page.evaluate(() => {
    const dialog = document.activeElement?.closest('dialog[open], [role="dialog"][popover]')
    if (!dialog) return null
    const labelledBy = dialog.getAttribute('aria-labelledby')
    if (labelledBy) return document.getElementById(labelledBy)?.textContent?.trim() ?? null
    return dialog.getAttribute('aria-label') ?? dialog.querySelector('h1, h2, h3')?.textContent?.trim() ?? null
  })).toBe(title)
}

async function addInventoryItem(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
  await form.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await form.getByRole('textbox', { name: 'Item name', exact: true }).fill(name)
  await form.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(form).not.toBeVisible()
}

async function addProgressRecord(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add progress', exact: true }).first().click()
  const form = page.getByRole('dialog', { name: 'Add class progress', exact: true })
  await form.getByRole('textbox', { name: 'Class display name', exact: true }).fill(name)
  await form.getByLabel('Tracking group').selectOption('inProgress')
  await form.getByRole('button', { name: 'Save progress', exact: true }).click()
  await expect(form).not.toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/inventory')
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
})

test('inventory edit routes hydrate exact records and reject missing identities', async ({ page }) => {
  await addInventoryItem(page, 'Synthetic inventory alpha')
  await addInventoryItem(page, 'Synthetic inventory beta')
  const initial = await exportProfile(page)
  const alpha = Object.values(initial.inventory).find((entry) => entry.observedName === 'Synthetic inventory alpha')!
  const beta = Object.values(initial.inventory).find((entry) => entry.observedName === 'Synthetic inventory beta')!

  await setHash(page, `#/inventory/items/${encodeURIComponent(alpha.id)}/edit`)
  const editor = page.getByRole('dialog', { name: 'Edit inventory observation', exact: true })
  await expect(editor.getByRole('button', { name: 'Choose Item definition', exact: true })).toContainText('Synthetic inventory alpha')
  await editor.getByRole('button', { name: 'Customize display name', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue('Synthetic inventory alpha')
  await editor.getByRole('textbox', { name: 'Display name', exact: true }).fill('Unsaved alpha draft')

  await setHash(page, `#/inventory/items/${encodeURIComponent(beta.id)}/edit`)
  await expect(editor.getByRole('button', { name: 'Choose Item definition', exact: true })).toContainText('Synthetic inventory beta')
  await expect(editor.getByRole('textbox', { name: 'Display name', exact: true })).not.toBeVisible()
  await editor.getByRole('button', { name: 'Customize display name', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue('Synthetic inventory beta')
  await editor.getByRole('textbox', { name: 'Display name', exact: true }).fill('Synthetic inventory beta updated')
  await editor.getByRole('button', { name: 'Save observation', exact: true }).click()
  await expect(editor).not.toBeVisible()

  const saved = await exportProfile(page)
  expect(saved.inventory[alpha.id]?.observedName).toBe('Synthetic inventory alpha')
  expect(saved.inventory[beta.id]?.observedName).toBe('Synthetic inventory beta updated')

  await setHash(page, '#/inventory/items/synthetic-missing-position/edit')
  await expect(page.getByText('Inventory entry unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit inventory observation', exact: true })).not.toBeVisible()
})

test('progress edit routes hydrate exact records and reject missing identities', async ({ page }) => {
  await navigate(page, 'Progress')
  await addProgressRecord(page, 'Synthetic progress alpha')
  await addProgressRecord(page, 'Synthetic progress beta')
  const initial = await exportProfile(page)
  const alpha = Object.values(initial.progress).find((entry) => entry.displayName === 'Synthetic progress alpha')!
  const beta = Object.values(initial.progress).find((entry) => entry.displayName === 'Synthetic progress beta')!

  await setHash(page, `#/progress/${encodeURIComponent(alpha.id)}/edit`)
  const editor = page.getByRole('dialog', { name: 'Edit progress record', exact: true })
  await expect(editor.getByRole('textbox', { name: 'Class display name', exact: true })).toHaveValue('Synthetic progress alpha')
  await editor.getByRole('textbox', { name: 'Class display name', exact: true }).fill('Unsaved progress alpha')

  await setHash(page, `#/progress/${encodeURIComponent(beta.id)}/edit`)
  await expect(editor.getByRole('textbox', { name: 'Class display name', exact: true })).toHaveValue('Synthetic progress beta')
  await editor.getByRole('textbox', { name: 'Class display name', exact: true }).fill('Synthetic progress beta updated')
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(editor).not.toBeVisible()

  const saved = await exportProfile(page)
  expect(saved.progress[alpha.id]?.displayName).toBe('Synthetic progress alpha')
  expect(saved.progress[beta.id]?.displayName).toBe('Synthetic progress beta updated')

  await setHash(page, '#/progress/synthetic-missing-record/edit')
  await expect(page.getByText('Progress record unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit progress record', exact: true })).not.toBeVisible()
})

test('direct nested modal routes restore the top layer and close one layer at a time', async ({ page }) => {
  await page.goto('/#/inventory/new/pick/item-definition/definitions/new?q=Synthetic')
  await page.reload()
  const inventoryForm = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
  const definitionPicker = page.getByRole('dialog', { name: 'Choose Item definition', exact: true })
  const definitionEditor = page.getByRole('dialog', { name: 'Create personal definition', exact: true })
  await expect(definitionEditor).toBeVisible()
  await expectActiveDialog(page, 'Create personal definition')

  await page.keyboard.press('Escape')
  await expect(definitionEditor).not.toBeVisible()
  await expect(definitionPicker).toBeVisible()
  await expectActiveDialog(page, 'Choose Item definition')

  await page.keyboard.press('Escape')
  await expect(definitionPicker).not.toBeVisible()
  await expect(inventoryForm).toBeVisible()
  await expectActiveDialog(page, 'Add inventory item')

  await page.goto('/#/settings/data/search?q=blade')
  await page.reload()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  const search = page.getByRole('dialog', { name: 'Search Crystal Companion', exact: true })
  await expect(search).toBeVisible()
  await expectActiveDialog(page, 'Search Crystal Companion')

  await page.keyboard.press('Escape')
  await expect(search).not.toBeVisible()
  await expect(settings).toBeVisible()
  await expectActiveDialog(page, 'Data & settings')
})

test('reference source options remain readable, bounded, and exact', async ({ page, isMobile }) => {
  await navigate(page, 'Reference')
  if (isMobile) await page.getByRole('button', { name: /^Filters/ }).click()
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  const sourceSearch = page.getByRole('searchbox', { name: 'Search reference sources', exact: true })
  const sources = page.getByRole('group', { name: 'Reference source filters', exact: true })
  const aegisSource = sources.getByRole('button', { name: /^Community wiki · Aegis\. Full source: https:\/\/crystal-project\.fandom\.com\/wiki\/Aegis\. \d+ matches$/ })
  if (!isMobile) {
    const viewport = page.viewportSize()!
    const facetPanel = page.locator('.facet-panel')
    const panelBox = (await facetPanel.boundingBox())!
    expect(panelBox.height).toBeLessThanOrEqual(viewport.height)
    await sourceSearch.scrollIntoViewIfNeeded()
    await expect(sourceSearch).toBeInViewport()
    const searchBox = (await sourceSearch.boundingBox())!
    expect(searchBox.y).toBeGreaterThanOrEqual(0)
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(viewport.height)
  }
  await expect(aegisSource).toBeVisible()
  const geometry = await sources.evaluate((element) => {
    const rows = [...element.querySelectorAll('button')].map((button) => button.getBoundingClientRect())
    return {
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      heights: rows.map((row) => row.height),
      widths: rows.map((row) => row.width),
      gaps: rows.slice(1).map((row, index) => row.top - rows[index]!.bottom),
    }
  })
  expect(geometry.clientHeight).toBeLessThanOrEqual(320)
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
  expect(Math.min(...geometry.heights)).toBeGreaterThanOrEqual(44)
  expect(Math.min(...geometry.widths)).toBeGreaterThan(180)
  expect(Math.min(...geometry.gaps)).toBeGreaterThanOrEqual(5.5)

  await sourceSearch.fill('docs.google.com')
  await expect(sources.getByRole('button', { name: /Equipment Expansion\. Full source: https:\/\/docs\.google\.com\// })).toBeVisible()
  await sourceSearch.fill('Community wiki · Aegis')
  await expect(aegisSource).toBeVisible()
})

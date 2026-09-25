import { expect, test, type Locator, type Page } from '@playwright/test'

const BACKDROP_VIEWPORT = { width: 1280, height: 900 }

async function activatePoint(page: Page, touch: boolean, point: { x: number; y: number }) {
  if (touch) await page.touchscreen.tap(point.x, point.y)
  else await page.mouse.click(point.x, point.y)
}

async function clickOutside(page: Page, panel: Locator, touch: boolean) {
  const bounds = await panel.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThan(0)
  await activatePoint(page, touch, { x: bounds!.x / 2, y: bounds!.y + bounds!.height / 2 })
}

test('backdrop dismissal ignores panel clicks and drags and restores focus without activating the page', async ({ page, isMobile }) => {
  await page.setViewportSize(BACKDROP_VIEWPORT)
  await page.goto('/')
  const reference = page.getByRole('button', { name: 'Reference', exact: true }).filter({ visible: true })
  const referenceBounds = await reference.boundingBox()
  expect(referenceBounds).not.toBeNull()
  const outside = { x: referenceBounds!.x + referenceBounds!.width / 2, y: referenceBounds!.y + referenceBounds!.height / 2 }
  const trigger = page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true })
  await trigger.click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  const heading = panel.getByRole('heading', { name: 'Data & settings', exact: true })
  await heading.click()
  await expect(panel).toBeVisible()
  const headingBounds = await heading.boundingBox()
  expect(headingBounds).not.toBeNull()
  const inside = { x: headingBounds!.x + headingBounds!.width / 2, y: headingBounds!.y + headingBounds!.height / 2 }
  for (const [start, end] of [[inside, outside], [outside, inside]]) {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y)
    await page.mouse.up()
    await expect(panel).toBeVisible()
  }
  await activatePoint(page, isMobile, outside)
  await expect(panel).not.toBeVisible()
  await expect(page).toHaveURL(/#\/inventory$/)
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
})

test('definition search is ready for typing on opening, reopening, and direct links', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  const observation = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
  const trigger = observation.getByRole('button', { name: 'Choose Item definition', exact: true })
  const picker = page.getByRole('dialog', { name: 'Choose Item definition', exact: true })
  const search = picker.getByRole('searchbox', { name: 'Search available definitions', exact: true })
  await trigger.click()
  await expect(search).toBeFocused()
  await page.keyboard.type('Potion')
  await expect(search).toHaveValue('Potion')
  await page.keyboard.press('ArrowDown')
  await expect(picker.locator('[data-definition-result="true"]').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('Potion')
  await page.reload()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('Potion')
})

test('backdrop dismissal closes only the top panel and respects unsaved definition guards', async ({ page, isMobile }) => {
  await page.setViewportSize(BACKDROP_VIEWPORT)
  await page.goto('/#/inventory/new/pick/item-definition/definitions/new?q=Synthetic')
  const editor = page.getByRole('dialog', { name: 'Create personal definition', exact: true })
  const picker = page.getByRole('dialog', { name: 'Choose Item definition', exact: true })
  const observation = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
  await expect(editor).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('dialog')?.querySelector('h2')?.textContent)).toBe('Create personal definition')
  await editor.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Retain this synthetic definition')
  await clickOutside(page, editor, isMobile)
  await expect(editor.getByText('Definition draft still open', { exact: true })).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'Definition name', exact: true })).toHaveValue('Retain this synthetic definition')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('searchbox', { name: 'Search available definitions', exact: true })).toHaveValue('Synthetic')
  await picker.getByRole('button', { name: 'Create "Synthetic"', exact: true }).click()
  await expect(editor).toBeVisible()
  await clickOutside(page, editor, isMobile)
  await expect(editor).not.toBeVisible()
  await expect(picker).toBeVisible()
  await expect(page).toHaveURL(/#\/inventory\/new\/pick\/item-definition\?q=Synthetic$/)
  await clickOutside(page, picker, isMobile)
  await expect(picker).not.toBeVisible()
  await expect(observation).toBeVisible()
  await expect(page).toHaveURL(/#\/inventory\/new$/)
})

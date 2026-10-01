import { expect, test, type Locator, type Page } from '@playwright/test'

const REFERENCE = '/#/reference/catalog/crystal-project-public-starter/revisions/catalog-v1/entities/'
const RAPIER = `${REFERENCE}base/item/artisan-rapier`
const SWORD = `${REFERENCE}base/item/iron-sword`

async function edit(page: Page, personal = false) {
  const action = personal ? 'Create personal version' : page.url().includes('/reference/personal/') ? 'Edit personal version' : 'Correct shared reference'
  await page.getByRole('button', { name: action, exact: true }).click()
  return page.getByRole('dialog', { name: /^(Correct shared reference|Create personal version|Edit personal version):/ })
}

async function setFact(editor: Locator, field: string, mode: string, value?: string) {
  await editor.getByLabel('Fact to edit').selectOption(field)
  await editor.getByRole('combobox', { name: `Knowledge for ${field}`, exact: true }).selectOption(mode)
  if (value !== undefined) await editor.getByLabel(`Value for ${field}`).fill(value)
}

function fact(page: Page, name: string) {
  return page.getByRole('region', { name: 'Definition facts', exact: true }).locator('.definition-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) })
}

test('uses matching detail sections and typed editors for catalog and personal definitions', async ({ page }) => {
  await page.goto(RAPIER)
  const sections = ['Definition facts', 'Source trail', 'Planning fields']
  for (const name of sections) await expect(page.getByRole('region', { name, exact: true })).toBeVisible()
  await page.getByRole('region', { name: 'Source trail', exact: true }).locator('summary').filter({ hasText: /^Source and version details$/ }).click()
  await expect(page.locator('summary').filter({ hasText: /^Supplemental claims$/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Planning fields', exact: true }).locator('.badge').getByText('known', { exact: true })).toHaveCount(0)
  const artwork = await page.locator('.reference-title img').getAttribute('src')
  const catalog = await edit(page)
  await catalog.getByLabel('Fact to edit').selectOption('Attack')
  await expect(catalog.getByLabel('Value for Attack')).toHaveAttribute('type', 'number')
  await page.keyboard.press('Escape')
  await expect(catalog).not.toBeVisible()

  const personal = await edit(page, true)
  await expect(personal.getByRole('region', { name: 'Definition overview' })).toBeVisible()
  await personal.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic edited rapier')
  await setFact(personal, 'Attack', 'known', '123')
  await personal.getByRole('button', { name: 'Create personal version', exact: true }).click()
  await expect(personal).not.toBeVisible()
  await expect(page.getByRole('heading', { name: 'Synthetic edited rapier', exact: true })).toBeVisible()
  for (const name of sections) await expect(page.getByRole('region', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Imported claims', exact: true })).not.toBeVisible()
  await expect(page.locator('summary').filter({ hasText: /^Supplemental claims$/ })).toHaveCount(0)
  await expect(page.locator('.reference-title img')).toHaveAttribute('src', artwork!)
  await expect(fact(page, 'Attack')).toContainText('123')
  await expect(fact(page, 'Location')).toContainText('2 differing source values')
  await expect(page.getByRole('region', { name: 'Planning fields', exact: true })).toContainText('123')

  const revision = await edit(page)
  await setFact(revision, 'Attack', 'unknown')
  await revision.getByLabel('Reason for Attack').fill('Synthetic observation needed')
  await revision.getByRole('button', { name: 'Save personal revision', exact: true }).click()
  await expect(fact(page, 'Attack')).toContainText('Synthetic observation needed')
  await expect(page.getByRole('region', { name: 'Planning fields', exact: true })).not.toContainText('123')
  await page.getByRole('region', { name: 'Source trail', exact: true }).locator('summary').filter({ hasText: /^Source and version details$/ }).click()
  await page.locator('summary').filter({ hasText: /^Definition history$/ }).click()
  await page.getByRole('button', { name: 'View previous revision', exact: true }).click()
  await expect(fact(page, 'Attack')).toContainText('123')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  const personalCards = page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Synthetic edited rapier', exact: true }) })
  await expect(personalCards).toHaveCount(2)
  for (const card of await personalCards.all()) await expect(card.locator('.reference-title img')).toHaveAttribute('src', artwork!)
})

test('keeps validation and close recovery beside the fixed save controls', async ({ page }) => {
  await page.goto(RAPIER)
  const editor = await edit(page)
  await setFact(editor, 'Attack', 'known', '')
  await editor.getByRole('button', { name: 'Save correction', exact: true }).click()
  await expect(editor.getByText('Correction not saved', { exact: true })).toBeVisible()
  await expect(editor.getByLabel('Value for Attack')).toHaveValue('')
  await editor.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Save and continue', exact: true })).toBeInViewport()
  await expect(editor.getByRole('button', { name: 'Discard and continue', exact: true })).toBeInViewport()
  await editor.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await editor.getByLabel('Value for Attack').fill('99')
  await editor.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await editor.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(fact(page, 'Attack')).toContainText('99')
})

test('keeps class research available and uses the exact personal class for growth', async ({ page }) => {
  await page.goto('/#/reference/catalog/crystal-project-public-starter/revisions/catalog-v1/entities/base/class/warrior')
  const editor = await edit(page, true)
  await editor.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic personal Warrior')
  await editor.getByRole('button', { name: 'Create personal version', exact: true }).click()
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Growth calculator', { exact: true }).click()
  await research.getByRole('button', { name: 'Use Synthetic personal Warrior for all growth levels', exact: true }).click()
  await expect(research.getByRole('button', { name: 'Choose Growth class 1', exact: true })).toContainText('Synthetic personal Warrior')
  await expect(research.getByRole('table', { name: 'Estimated base stats', exact: true })).toContainText('1,244.38')
  await research.getByText('Learn tree', { exact: true }).click()
  await expect(research.getByRole('list', { name: 'Learn tree skills' })).toBeVisible()
})

test('continues the requested navigation after saving a quick correction', async ({ page }) => {
  await page.goto(RAPIER)
  await page.getByRole('button', { name: 'Quick edit', exact: true }).click()
  await page.getByRole('button', { name: 'Edit name', exact: true }).click()
  const editor = page.getByRole('form', { name: 'Correct name in place' })
  await editor.getByRole('textbox', { name: 'New name', exact: true }).fill('Synthetic quick correction')
  await page.getByRole('button', { name: 'Inventory', exact: true }).filter({ visible: true }).click()
  await editor.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await page.goto(RAPIER)
  await expect(page.getByRole('heading', { name: 'Synthetic quick correction', exact: true })).toBeVisible()
})

test('merges unrelated tab edits and preserves a draft when the same definition changes', async ({ page, context }) => {
  await page.goto(RAPIER)
  const first = await edit(page)
  await first.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic first correction')
  const other = await context.newPage()
  await other.goto(SWORD)
  const unrelated = await edit(other)
  await unrelated.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic unrelated correction')
  await unrelated.getByRole('button', { name: 'Save correction', exact: true }).click()
  await expect(unrelated).not.toBeVisible()
  await first.getByRole('button', { name: 'Save correction', exact: true }).click()
  await expect(first).not.toBeVisible()

  const draft = await edit(page)
  await draft.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic unsaved draft')
  await other.goto(RAPIER)
  const competing = await edit(other)
  await competing.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic newer saved correction')
  await competing.getByRole('button', { name: 'Save correction', exact: true }).click()
  await expect(competing).not.toBeVisible()
  await expect(draft.getByText('This definition changed in another tab', { exact: true })).toBeVisible()
  await expect(draft.getByRole('textbox', { name: 'Definition name', exact: true })).toHaveValue('Synthetic unsaved draft')
  await expect(draft.getByRole('button', { name: 'Save correction', exact: true })).toBeDisabled()
  await draft.getByRole('button', { name: 'Discard draft and reload', exact: true }).click()
  await expect(draft.getByRole('textbox', { name: 'Definition name', exact: true })).toHaveValue('Synthetic newer saved correction')
  await other.close()
})

import { referencePath } from './reference-helpers'
import { openCustomDefinition, openSavedCatalogVersion } from './definition-fixtures'
import { formatAppRoute, parseAppRoute, routeWithOverlay } from '../src/ui/navigation'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Locator, type Page } from '@playwright/test'

async function edit(page: Page) {
  await page.getByRole('button', { name: 'Edit custom definition', exact: true }).click()
  return page.getByRole('dialog', { name: /^Edit custom definition:/ })
}

async function setFact(editor: Locator, field: string, mode: string, value?: string) {
  await editor.getByLabel('Fact to edit').selectOption(field)
  await editor.getByRole('combobox', { name: `Knowledge for ${field}`, exact: true }).selectOption(mode)
  if (value !== undefined) await editor.getByLabel(`Value for ${field}`).fill(value)
}

function fact(page: Page, name: string) {
  return page.getByRole('region', { name: 'Definition facts', exact: true }).locator('.definition-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) })
}

test('custom definitions retain typed facts, failed drafts, and immutable revisions', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:equipment:160'))
  await openCustomDefinition(page)
  const personal = await edit(page)
  await expect(personal.getByRole('region', { name: 'Definition overview' })).toBeVisible()
  await personal.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic edited sword')
  await setFact(personal, 'Attack', 'known', '123')
  await expect(personal.getByLabel('Value for Attack')).toHaveAttribute('type', 'number')
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic storage failure', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await personal.getByRole('button', { name: 'Save personal revision', exact: true }).click()
  await expect(personal.getByText('Definition not saved', { exact: true })).toBeVisible()
  await expect(personal.getByLabel('Value for Attack')).toHaveValue('123')
  await personal.getByRole('button', { name: 'Save personal revision', exact: true }).click()
  await expect(personal).not.toBeVisible()
  await expect(page.getByRole('heading', { name: 'Synthetic edited sword', exact: true })).toBeVisible()
  await expect(page.locator('.reference-technical')).toHaveCount(0)
  for (const name of ['Definition facts', 'Planning fields']) await expect(page.getByRole('region', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sources for Synthetic edited sword', exact: true })).toHaveCount(0)
  await expect(page.getByText('Definition history', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Sources for Synthetic edited sword', exact: true })).toHaveCount(0)
  await expect(fact(page, 'Attack')).toContainText('123')
  await expect(page.getByRole('region', { name: 'Planning fields', exact: true })).toContainText('123')

  const revision = await edit(page)
  await setFact(revision, 'Attack', 'unknown')
  await revision.getByLabel('Reason for Attack').fill('Synthetic observation needed')
  await revision.getByRole('button', { name: 'Save personal revision', exact: true }).click()
  await expect(fact(page, 'Attack')).toContainText('Synthetic observation needed')
  await expect(page.getByRole('region', { name: 'Planning fields', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Planning fields', exact: true })).not.toContainText('123')
  await page.reload()
  await expect(fact(page, 'Attack')).toContainText('Synthetic observation needed')
  await page.getByText('Definition history', { exact: true }).click()
  await page.getByRole('button', { name: 'View previous revision', exact: true }).click()
  await expect(fact(page, 'Attack')).toContainText('123')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('keeps custom validation and close recovery beside the fixed save controls', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:equipment:160'))
  await openCustomDefinition(page)
  const editor = await edit(page)
  await setFact(editor, 'Attack', 'known', '')
  await editor.getByRole('button', { name: 'Save personal revision', exact: true }).click()
  await expect(editor.getByText('Definition not saved', { exact: true })).toBeVisible()
  await expect(editor.getByLabel('Value for Attack')).toHaveValue('')
  await editor.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Save and continue', exact: true })).toBeInViewport()
  await expect(editor.getByRole('button', { name: 'Discard and continue', exact: true })).toBeInViewport()
  await editor.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await editor.getByLabel('Value for Attack').fill('99')
  await editor.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await editor.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(fact(page, 'Attack')).toContainText('10')
  await page.getByRole('button', { name: 'Edit latest custom definition', exact: true }).click()
  await editor.getByLabel('Fact to edit').selectOption('Attack')
  await expect(editor.getByLabel('Value for Attack')).toHaveValue('99')
})

test('saved catalog versions retain research and reject direct editing', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:job:0'))
  const definition = await openSavedCatalogVersion(page, 'base:job:0', 'Synthetic personal Warrior')
  await expect(page.getByRole('button', { name: /Edit.*(definition|version)/ })).toHaveCount(0)
  await expect(page.getByText(/Saved catalog version. This record is read-only/)).toBeVisible()
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Growth calculator', { exact: true }).click()
  await research.getByRole('button', { name: 'Use Synthetic personal Warrior for all growth levels', exact: true }).click()
  await expect(research.getByRole('button', { name: 'Choose Growth class 1', exact: true })).toContainText('Synthetic personal Warrior')
  await expect(research.getByRole('table', { name: 'Native base stats', exact: true })).toContainText('1,244')
  await research.getByText('Learn tree', { exact: true }).click()
  await expect(research.getByRole('list', { name: 'Learn tree skills' })).toBeVisible()
  const route = routeWithOverlay(parseAppRoute(new URL(page.url()).hash), { kind: 'definition-editor', mode: 'override', ref: { kind: 'personal', definitionId: definition.id } })
  await page.goto(`/${formatAppRoute(route)}`)
  const readOnly = page.getByRole('dialog', { name: 'Definition is read-only', exact: true })
  await expect(readOnly).toBeVisible()
  await expect(readOnly.getByRole('textbox')).toHaveCount(0)
  await expect(readOnly.getByRole('button', { name: /Save/ })).toHaveCount(0)
})

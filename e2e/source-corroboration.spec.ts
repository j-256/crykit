import { openSavedCatalogVersion } from './definition-fixtures'
import { referencePath } from './reference-helpers'
import { CURRENT_CATALOG } from '../src/catalog/bundled'
import { CLASS_FIELDS } from '../src/domain/crystal-edit'
import { expect, test, type Page } from '@playwright/test'

const WARRIOR_PATH = referencePath('base:job:0')

function fact(page: Page, name: string) {
  return page.getByRole('region', { name: 'Definition facts', exact: true }).locator('.definition-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) })
}

test('native facts omit disclosures and retain their exact definition after reload', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toBeVisible()
  for (const name of ['Equipment permissions', 'Class command', 'Growth ratings']) {
    await expect(fact(page, name)).toHaveCount(1)
    await expect(fact(page, name).locator('.sources-trigger')).toHaveCount(0)
  }
  await expect(fact(page, 'Equipment permissions')).toContainText('Sword')
  await expect(fact(page, 'Equipment permissions')).toContainText('Heavy Body')
  await expect(fact(page, 'Class command')).toContainText('Battle Skill')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(fact(page, 'Equipment permissions').locator('.sources-trigger')).toHaveCount(0)
})

test('a personal value retains its evidence without replacing the corroborated source', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  await openSavedCatalogVersion(page, 'base:job:0', 'Synthetic personal Warrior', { fields: { [CLASS_FIELDS.equipment]: { state: 'known', value: ['Synthetic equipment permission'], sources: [{ sourceId: 'synthetic-observation', locator: 'Synthetic equipment notes' }] } } })
  const equipment = fact(page, 'Equipment permissions')
  await expect(equipment).toContainText('Synthetic equipment permission')
  await expect(equipment.locator('.sources-trigger')).toHaveCount(1)
  await page.reload()
  await expect(equipment).toContainText('Synthetic equipment permission')
  await expect(equipment.locator('.sources-trigger')).toHaveCount(1)
  await page.goto(WARRIOR_PATH)
  await expect(equipment).not.toContainText('Synthetic equipment permission')
  await expect(equipment).toHaveCount(1)
  await expect(equipment).toContainText('Sword')
  await expect(equipment).toContainText('Heavy Body')
  await expect(equipment.locator('.sources-trigger')).toHaveCount(0)
})

test('a personal mechanic description retains its own evidence', async ({ page }) => {
  const id = 'mechanic:stat:467'
  await page.goto(referencePath(id))
  await expect(page.getByRole('heading', { name: 'Flat AbilityAPCost [X] [Y]', exact: true })).toBeVisible()
  const description = page.locator('.reference-description')
  await expect(description).toContainText('Value1 (X) is the native ability ID.')
  await expect(description.locator('.sources-trigger')).toHaveCount(0)
  await openSavedCatalogVersion(page, id, 'Synthetic personal mechanic', { fields: { Description: { state: 'known', value: CURRENT_CATALOG.entities[id]!.rawDescription!, sources: [{ sourceId: 'synthetic-observation', locator: 'Synthetic mechanic notes' }] } } })
  const personalDescription = fact(page, 'Description')
  await expect(personalDescription).toContainText('Value1 (X) is the native ability ID.')
  await personalDescription.getByRole('button', { name: 'Sources for Description', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sources for Description', exact: true })).toContainText('Synthetic mechanic notes')
})

test('an edited personal mechanic keeps inherited native provenance inspectable', async ({ page }) => {
  const id = 'mechanic:stat:467'
  const original = CURRENT_CATALOG.entities[id]!
  const nativeSource = original.sources.find(source => source.sourceId.startsWith('native-game:'))
  if (!nativeSource?.locator || !nativeSource.snapshot) throw new Error('The native mechanic fixture needs its original locator and snapshot')
  await page.goto(referencePath(id))
  await openSavedCatalogVersion(page, id, 'Synthetic edited mechanic', { fields: { Description: { state: 'known', value: 'Synthetic changed mechanic description', sources: original.sources } } })
  await expect(fact(page, 'Description')).toContainText('Synthetic changed mechanic description')
  const identity = page.locator('.reference-card__meta')
  await expect(identity).toContainText('Custom definition')
  await expect(identity).not.toContainText(/verified|native/i)
  const sources = page.locator('.reference-detail__toolbar').getByRole('button', { name: 'Sources for Synthetic edited mechanic', exact: true })
  await expect(sources).toBeVisible()
  await sources.click()
  const evidence = page.getByRole('dialog', { name: 'Sources for Synthetic edited mechanic', exact: true })
  await expect(evidence).toContainText(nativeSource.locator)
  await expect(evidence).toContainText(nativeSource.snapshot)
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(fact(page, 'Description')).toContainText('Synthetic changed mechanic description')
  await expect(sources).toBeVisible()
})

test('native mechanic descriptions preserve exact arithmetic', async ({ page }) => {
  await page.goto(referencePath('mechanic:stat:526'))
  await expect(page.getByRole('heading', { name: 'StealChanceUp [X]', exact: true })).toBeVisible()
  await expect(page.locator('.reference-detail .reference-description')).toContainText('100 * (base chance + bonus) / (100 + bonus)')
  await expect(page.locator('.reference-detail .reference-description')).toContainText('A base chance of 20 and bonus of 50 gives 46%.')
  await expect(fact(page, 'Description')).toHaveCount(0)
  await expect(page.locator('.reference-description .sources-trigger')).toHaveCount(0)
})

test('retains useful missing descriptions without repeating native absence placeholders', async ({ page }) => {
  await page.goto(referencePath('base:passive:0'))
  await expect(page.getByRole('heading', { name: 'Counter', exact: true })).toBeVisible()
  await expect(page.locator('.reference-description')).toContainText('Counter')
  await expect(page.locator('.reference-description').getByRole('button', { name: 'Sources for Description', exact: true })).toBeVisible()
  await expect(page.getByText('No authored description; see the definition values and effects', { exact: true })).toHaveCount(0)
})

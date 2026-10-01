import { referencePath } from './reference-helpers'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import type { CatalogCorrection } from '../src/domain/corrections'
import { exportCorrections } from '../src/interchange/corrections'

const WARRIOR_PATH = '/#/reference/catalog/crystal-project-public-starter/revisions/catalog-v1/entities/base/class/warrior'

function fact(page: Page, name: string) {
  return page.getByRole('region', { name: 'Definition facts', exact: true }).locator('.definition-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) })
}

test('corroborated facts omit disclosures while acquisition evidence and source attribution remain accessible', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toBeVisible()
  for (const name of ['Weapons', 'Armor', 'Command', 'Growth ratings']) {
    await expect(fact(page, name)).toHaveCount(1)
    await expect(fact(page, name).locator('.definition-fact-sources')).toHaveCount(0)
  }
  const master = fact(page, 'Master').filter({ has: page.getByText('Capital Sequoia', { exact: true }) })
  await expect(master).toHaveCount(1)
  await master.locator('.definition-fact-sources summary').click()
  await expect(master.getByRole('link', { name: /Community wiki/ })).toBeVisible()
  await page.getByText('Source and version details', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'Source trail', exact: true })).toContainText('Community wiki')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(fact(page, 'Weapons').locator('.definition-fact-sources')).toHaveCount(0)
})

test('a local correction loses corroboration without changing surrounding facts or the baseline', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  const warrior = DEFAULT_CATALOG.entities['base:class:warrior']!
  const correction: CatalogCorrection = {
    id: 'synthetic-weapons-correction', target: { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: warrior.id },
    baselineChecksum: DEFAULT_CATALOG.checksum, baselineName: warrior.name, baselineSources: warrior.sources, baselineClaims: DEFAULT_CATALOG.claims.filter(claim => claim.entityId === warrior.id),
    decision: 'correction', confidence: 'tentative', supersedes: [], reason: 'Synthetic test correction', evidence: '', context: { platform: '', gameVersion: '', mods: '' }, updatedAt: '2026-01-02T03:04:05.000Z',
    changes: [{ path: 'field', field: 'Weapons', before: warrior.fields.Weapons!, after: { state: 'known', value: 'Synthetic weapons', sources: [{ sourceId: 'manual:synthetic-observation' }] } }],
  }
  await page.getByRole('button', { name: /^Corrections(?: \(\d+\))?$/ }).click()
  const manager = page.getByRole('dialog', { name: 'Corrections', exact: true })
  await manager.getByLabel('Choose corrections file', { exact: true }).setInputFiles({ name: 'synthetic-corrections.json', mimeType: 'application/json', buffer: Buffer.from(exportCorrections([correction])) })
  await manager.getByRole('button', { name: /^Import selected/ }).click()
  await expect(manager.getByText('Corrections imported locally.', { exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const weapons = fact(page, 'Weapons')
  await expect(weapons).toContainText('Synthetic weapons')
  await expect(weapons.locator('.definition-fact-sources')).toHaveCount(1)
  await expect(fact(page, 'Armor').locator('.definition-fact-sources')).toHaveCount(0)
  await page.reload()
  await expect(weapons.locator('.definition-fact-sources')).toHaveCount(1)
  await page.getByRole('button', { name: 'View original', exact: true }).click()
  await expect(weapons).not.toContainText('Synthetic weapons')
  await expect(weapons.locator('.definition-fact-sources')).toHaveCount(0)
})

test('partial mechanic evidence keeps the source disclosure', async ({ page }) => {
  await page.goto(referencePath('base:mechanic:stat:StealChanceUp%20%5BX%5D'))
  await expect(fact(page, 'Description').locator('.definition-fact-sources')).toHaveCount(1)
  await page.goto(referencePath('base:mechanic:stat:Addi%20PVariance%20%5BX%5D'))
  await expect(fact(page, 'Description').locator('.definition-fact-sources')).toHaveCount(0)
})

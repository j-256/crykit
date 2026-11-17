import { CONFLICTING_LOCATIONS, REFERENCE_EVIDENCE_ENTITIES, REFERENCE_EVIDENCE_SOURCES, evidenceReferencePath, installReferenceEvidence } from './reference-evidence-fixtures'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'

const ITEM_PATH = evidenceReferencePath(REFERENCE_EVIDENCE_ENTITIES.conflicting)
const EQUIVALENT_ITEM_PATH = evidenceReferencePath(REFERENCE_EVIDENCE_ENTITIES.equivalent)
const ITEM_SOURCE = REFERENCE_EVIDENCE_SOURCES[1]!.sourceId
const TABLE_SOURCE = REFERENCE_EVIDENCE_SOURCES[0]!.sourceId
const SELECTED_LOCATION = CONFLICTING_LOCATIONS[0]

function locationRow(page: Page) {
  return page.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Location$/ }) })
}

test('equivalent source wording is shown as one fact with known implied', async ({ page }) => {
  await installReferenceEvidence(page)
  await page.goto(EQUIVALENT_ITEM_PATH)
  const location = locationRow(page)
  await expect(location.getByText('Drop: synthetic guardian in the northern ruins', { exact: true })).toBeVisible()
  await expect(location.locator('.badge').getByText('known', { exact: true })).toHaveCount(0)
  await expect(location.getByText('differing source values')).toHaveCount(0)
  await expect(page.getByText('Source descriptions differ', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review source differences', exact: true })).toHaveCount(0)
  const sources = page.getByRole('dialog', { name: 'Sources for Synthetic agreed blade', exact: true })
  await expect(sources).toHaveCount(0)
  await page.getByRole('button', { name: 'Sources for Synthetic agreed blade', exact: true }).click()
  await expect(sources.getByRole('link', { name: 'source-a.example.test', exact: true })).toHaveAttribute('href', TABLE_SOURCE)
  await expect(sources.getByRole('link', { name: 'source-b.example.test', exact: true })).toHaveAttribute('href', ITEM_SOURCE)
})

test('conflicting fields retain every claim and its exact source evidence', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const externalRequests: string[] = []
  page.on('request', (request) => { if (!request.url().startsWith(`${baseURL}/`)) externalRequests.push(request.url()) })
  await installReferenceEvidence(page)
  await page.goto(ITEM_PATH)
  const location = locationRow(page)
  await expect(location.getByText(SELECTED_LOCATION, { exact: true })).toBeVisible()
  await expect(location.getByText(CONFLICTING_LOCATIONS[1])).toBeVisible()
  await expect(location.getByRole('link')).toHaveCount(0)
  await expect(location.locator('.badge').getByText('Sources differ', { exact: true })).toBeVisible()
  for (const claim of [{ text: SELECTED_LOCATION, name: 'source-a.example.test', href: TABLE_SOURCE, revision: 'revision 12' }, { text: CONFLICTING_LOCATIONS[1], name: 'source-b.example.test', href: ITEM_SOURCE, revision: 'revision 24' }]) {
    const row = location.locator('.knowledge-claim').filter({ hasText: claim.text })
    await row.getByRole('button', { name: /^Sources for Location [12]$/ }).click()
    const sources = page.getByRole('dialog', { name: /^Sources for Location [12]$/ })
    await expect(sources.getByRole('link', { name: claim.name, exact: true })).toHaveAttribute('href', claim.href)
    await expect(sources).toContainText(claim.revision)
    await page.keyboard.press('Escape')
    await expect(sources).toHaveCount(0)
  }
  await expect(page.getByText('Applicability unknown', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await expect(page.getByRole('button', { name: /Review source differences|Create personal version/ })).toHaveCount(0)
  await page.locator('.reference-actions').getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Report a data issue', exact: true })).toBeVisible()
  await page.reload()
  await expect(location.getByText('2 differing source values', { exact: true })).toBeVisible()
  expect(externalRequests).toEqual([])
})

import { MOBILE_TEST_TAG } from './test-tags'
import { referencePath } from './reference-helpers'
import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import { activeCorrections, type CatalogCorrection } from '../src/domain/corrections'
import { exportCorrections, readCorrections } from '../src/interchange/corrections'

const ENTITY_ID = 'base:item:artisan-rapier'
const ITEM_PATH = referencePath(ENTITY_ID)
const CORRECTED_LOCATION = 'Luxury Martial Weapon Shop, Capital Sequoia'
const VENDOR_SOURCE = 'https://crystal-project.fandom.com/wiki/Luxury_Martial_Weapon_Shop?oldid=10431'

function locationRow(page: Page) {
  return page.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Location$/ }) })
}
async function editLocation(page: Page, value: string) {
  await page.getByRole('button', { name: 'Quick edit', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Location', exact: true }).press('Enter')
  const editor = page.getByRole('form', { name: 'Correct Location in place' })
  await editor.getByRole('textbox', { name: 'New Location', exact: true }).fill(value)
  return editor
}
async function openCorrections(page: Page) {
  await page.getByRole('button', { name: /^Corrections(?: \(\d+\))?$/ }).click()
  return page.getByRole('dialog', { name: 'Corrections', exact: true })
}
async function exportSelected(page: Page) {
  const manager = page.getByRole('dialog', { name: 'Corrections', exact: true })
  const download = page.waitForEvent('download')
  await manager.getByRole('button', { name: /^Export selected/ }).click()
  const path = await (await download).path()
  if (!path) throw new Error('The corrections download did not finish')
  return readCorrections(await readFile(path))
}
function proposal(id: string, value: string, stale = false): CatalogCorrection {
  const entity = DEFAULT_CATALOG.entities[ENTITY_ID]!
  return {
    id, target: { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: entity.id },
    baselineChecksum: stale ? 'old-catalog-checksum' : DEFAULT_CATALOG.checksum, baselineName: entity.name, baselineSources: entity.sources, baselineClaims: DEFAULT_CATALOG.claims.filter(claim => claim.entityId === entity.id),
    decision: 'refinement', confidence: 'tentative', supersedes: [], reason: '', evidence: '', context: { platform: '', gameVersion: '', mods: '' }, updatedAt: '2026-01-02T03:04:05.000Z',
    changes: [{ path: 'field', field: 'Location', before: entity.fields.Location!, after: { state: 'known', value } }],
  }
}
async function importProposal(page: Page, entries: readonly CatalogCorrection[]) {
  const manager = page.getByRole('dialog', { name: 'Corrections', exact: true })
  await manager.getByLabel('Choose corrections file', { exact: true }).setInputFiles({ name: 'synthetic-corrections.json', mimeType: 'application/json', buffer: Buffer.from(exportCorrections(entries)) })
  await manager.getByRole('button', { name: /^Import selected/ }).click()
  await expect(manager.getByText('Corrections imported locally.', { exact: true })).toBeVisible()
}

test('edits in place with minimal input, adds provenance later, and exports exact decisions', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }, testInfo) => {
  const external: string[] = []
  page.on('request', request => { if (!request.url().startsWith(`${baseURL}/`)) external.push(request.url()) })
  await page.goto(ITEM_PATH)
  const editor = await editLocation(page, CORRECTED_LOCATION)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(editor.getByLabel('Evidence / provenance')).not.toBeVisible()
  await page.getByRole('button', { name: 'Inventory', exact: true }).filter({ visible: true }).click()
  await expect(editor.getByText('Correction draft still open', { exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(locationRow(page)).toContainText(CORRECTED_LOCATION)
  await expect(page.getByText('Tentative correction', { exact: true })).toBeVisible()
  await expect(page.getByText('Windows 1.6.9 · base database', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View original', exact: true }).click()
  await expect(locationRow(page)).toContainText('Shop: Luxury Martial Weapon Shop')
  await expect(locationRow(page)).not.toContainText('differing source values')
  await locationRow(page).locator('summary').filter({ hasText: /^Sources$/ }).click()
  await expect(locationRow(page).getByRole('link', { name: 'Community wiki · Rapiers/table' })).toHaveAttribute('href', 'https://crystal-project.fandom.com/wiki/Rapiers/table?oldid=13313')
  await page.getByRole('button', { name: 'View corrected', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Location', exact: true }).press('Enter')
  const incremental = page.getByRole('form', { name: 'Correct Location in place' })
  await incremental.locator('summary').filter({ hasText: 'Add evidence or detail' }).click()
  await incremental.getByLabel('Evidence / provenance').fill(VENDOR_SOURCE)
  await incremental.getByLabel('Why this correction').fill('The vendor is inside the Luxury shop in Capital Sequoia. The group and vendor are compatible scopes.')
  await incremental.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('refinement')
  await incremental.getByRole('combobox', { name: 'Confidence', exact: true }).selectOption('confirmed')
  await incremental.locator('summary').filter({ hasText: 'Game version & applicability' }).click()
  await incremental.getByLabel('Platform', { exact: true }).fill('Community wiki; Nintendo Switch unverified')
  await incremental.getByLabel('Game version', { exact: true }).fill('Wiki revisions 11808, 13313, and 10431; game version unverified')
  await incremental.getByLabel('Enabled mods / applicability').fill('Enabled-mod applicability unverified')
  await incremental.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Done editing', exact: true }).click()
  const manager = await openCorrections(page)
  await manager.locator('summary').filter({ hasText: 'Changes & evidence' }).click()
  await expect(manager.getByText('Compatible refinement', { exact: true })).toBeVisible()
  await expect(manager.getByText(VENDOR_SOURCE, { exact: true })).toBeVisible()
  const exported = await exportSelected(page)
  const active = activeCorrections(exported)
  expect(active).toHaveLength(1)
  expect(active[0]?.supersedes).toEqual([exported.find(entry => entry.id !== active[0]?.id)!.id])
  expect(active[0]).toMatchObject({ confidence: 'confirmed', decision: 'refinement', evidence: VENDOR_SOURCE })
  expect(active[0]?.changes[0]).toMatchObject({ path: 'field', field: 'Location', before: DEFAULT_CATALOG.entities[ENTITY_ID]!.fields.Location, after: { state: 'known', value: CORRECTED_LOCATION } })
  expect(JSON.stringify(exported)).not.toMatch(/personalDefinitions|inventory|characters|localDataId/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('correction-review.png') })
  await manager.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.reload()
  await expect(locationRow(page)).toContainText(CORRECTED_LOCATION)
  expect(external).toEqual([])
})

test('keeps text on save failure, retries offline, and preserves literal pasted markup', async ({ page, context }) => {
  await page.goto(ITEM_PATH)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const data = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await data.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = data.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(data)
  await data.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  const editor = await editLocation(page, '')
  await editor.getByRole('textbox', { name: 'New Location', exact: true }).evaluate(element => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '<img src=x onerror=alert(1)> Synthetic location')
    clipboardData.setData('text/html', '<img src=x onerror=alert(1)><b>Synthetic location</b>')
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  await expect(editor.locator('img, b')).toHaveCount(0)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'meta' && args[0]?.key === 'catalog-corrections-v1') { IDBObjectStore.prototype.put = put; throw new DOMException('Synthetic quota failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByText('Edit still open', { exact: true })).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'New Location', exact: true })).toContainText('Synthetic location')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await page.reload()
  await expect(locationRow(page)).toContainText('<img src=x onerror=alert(1)> Synthetic location')
  await expect(locationRow(page).locator('img')).toHaveCount(0)
  const manager = await openCorrections(page)
  const exported = await exportSelected(page)
  await manager.getByRole('button', { name: 'Restore baseline', exact: true }).click()
  await expect(manager.getByText('Baseline restored', { exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Undo restore', exact: true }).click()
  await expect(manager.getByText('Correction restored.', { exact: true })).toBeVisible()
  expect(activeCorrections(exported)[0]?.changes[0]).toHaveProperty('after.value', '<img src=x onerror=alert(1)> Synthetic location')
})

test('holds competing and stale imports for review and restores on a fresh browser', async ({ page, browser, baseURL }) => {
  await page.goto(ITEM_PATH)
  const manager = await openCorrections(page)
  const first = proposal('proposal-a', 'Synthetic first location')
  const second = proposal('proposal-b', 'Synthetic second location')
  await importProposal(page, [first, second])
  await expect(manager.getByText('Choose a correction', { exact: true })).toHaveCount(2)
  const winner = manager.locator('.correction-card').filter({ hasText: 'Synthetic second location' })
  await winner.getByRole('button', { name: 'Use this decision', exact: true }).click()
  await expect(manager.getByText('Applied locally', { exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Select matches', exact: true }).click()
  const exported = await exportSelected(page)
  expect([...activeCorrections(exported)[0]!.supersedes].sort()).toEqual(['proposal-a', 'proposal-b'])
  await manager.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(locationRow(page)).toContainText('Synthetic second location')
  const other = await browser.newContext()
  try {
    const restored = await other.newPage()
    await restored.goto(`${baseURL}${ITEM_PATH}`)
    await openCorrections(restored)
    await importProposal(restored, exported)
    await restored.getByRole('dialog', { name: 'Corrections', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expect(locationRow(restored)).toContainText('Synthetic second location')
  } finally { await other.close() }
  await openCorrections(page)
  const stale = proposal('stale-proposal', 'Synthetic stale value', true)
  await importProposal(page, [stale])
  const staleCard = manager.locator('.correction-card').filter({ hasText: 'Synthetic stale value' })
  await staleCard.getByRole('button', { name: 'Use this decision', exact: true }).click()
  await expect(manager.getByText('Needs review', { exact: true })).toBeVisible()
  await page.reload()
  await expect(manager.getByText('Needs review', { exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Review baseline change', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Correct shared reference: Artisan Rapier', exact: true })
  await expect(review.getByText('Review against the changed baseline', { exact: true })).toBeVisible()
  await review.getByRole('button', { name: 'Save correction', exact: true }).click()
  await expect(review).not.toBeVisible()
  await manager.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(locationRow(page)).toContainText('Synthetic stale value')
})

test('keeps hidden entries reachable and restores them from the corrections list', async ({ page }) => {
  await page.goto(referencePath(ENTITY_ID, DEFAULT_CATALOG.id, DEFAULT_CATALOG.revisionId))
  await page.getByRole('button', { name: 'Quick edit', exact: true }).click()
  await page.getByRole('button', { name: 'Correct shared reference', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'Correct shared reference: Artisan Rapier', exact: true })
  await details.locator('summary').filter({ hasText: /^Visibility$/ }).click()
  await details.getByRole('checkbox', { name: /^Hide from browsing and choices/ }).check()
  await details.getByRole('button', { name: 'Save correction', exact: true }).click()
  await expect(details).not.toBeVisible()
  const manager = await openCorrections(page)
  await expect(manager.getByText('Applied locally', { exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Artisan Rapier', exact: true })).toBeVisible()
  await page.goto('/#/reference?v=1&q=Artisan%20Rapier')
  await expect(page.locator('.reference-card').filter({ hasText: 'Artisan Rapier' })).toHaveCount(0)
  await openCorrections(page)
  await manager.getByRole('button', { name: 'Restore baseline', exact: true }).click()
  await manager.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.locator('.reference-card').filter({ hasText: 'Artisan Rapier' })).toBeVisible()
})

test('adds facts gradually and keeps description edits consistent across both views', async ({ page }) => {
  await page.goto(ITEM_PATH)
  await page.getByRole('button', { name: 'Quick edit', exact: true }).click()
  await page.getByRole('button', { name: 'Edit description', exact: true }).click()
  const description = page.getByRole('form', { name: 'Correct description in place' })
  await description.getByRole('textbox', { name: 'New description', exact: true }).fill('Synthetic revised description')
  await description.getByRole('button', { name: 'Save', exact: true }).click()
  const descriptionRow = page.getByRole('region', { name: 'Definition facts', exact: true }).locator('.definition-row').filter({ has: page.locator(':scope > dt', { hasText: /^Description$/ }) })
  await expect(descriptionRow).toContainText('Synthetic revised description')
  await page.getByRole('textbox', { name: 'Missing fact name', exact: true }).fill('Test finding')
  await page.getByRole('button', { name: 'Add fact', exact: true }).click()
  const finding = page.getByRole('form', { name: 'Correct Test finding in place' })
  await finding.getByRole('textbox', { name: 'New Test finding', exact: true }).fill('Synthetic finding recorded while playing')
  await finding.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit Test finding', exact: true })).toContainText('Synthetic finding recorded while playing')
  await openCorrections(page)
  const entries = await exportSelected(page)
  expect(activeCorrections(entries)[0]?.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'field', field: 'Description', after: { state: 'known', value: 'Synthetic revised description' } }),
    expect.objectContaining({ path: 'field', field: 'Test finding', before: null, after: { state: 'known', value: 'Synthetic finding recorded while playing' } }),
  ]))
})

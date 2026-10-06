import { MOBILE_TEST_TAG } from './test-tags'
import { saveAndApplyGameSetup, openCurrentGameSetup, selectedPlaythrough, createBlankPlaythrough, openGameSetupSection, replacePlannerData } from './local-data-helpers'
import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'

const SYNTHETIC_RESEARCH = {
  schema_version: '1.1.0',
  base_equipment: [
    { id: 'synthetic:reed-staff', name: 'Reed Staff', description: 'A synthetic staff for local tests', category: 'Staff' },
    { id: 'synthetic:paper-shield', name: 'Paper Shield', description: '<img src=x onerror=alert(1)>', category: 'Shield' },
  ],
  classes: [{ id: 'synthetic:scribe', name: 'Scribe', description: 'Synthetic class' }],
  passives: [
    { id: 'synthetic:patience', name: 'Patience', pp_cost: null },
    { id: 'synthetic:focus', name: 'Focus', pp_cost: 2 },
  ],
}

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function closeData(page: Page) {
  await page.getByRole('dialog', { name: 'Data & settings', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click()
}

async function stageServiceWorkerUpdate(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration) throw new Error('The offline installation is unavailable')
    // update() confirms script retrieval before the new worker finishes caching its files
    let onUpdateFound: (() => void) | undefined
    const updateFound = new Promise<ServiceWorker>(resolve => {
      onUpdateFound = () => { if (registration.installing) resolve(registration.installing) }
      registration.addEventListener('updatefound', onUpdateFound)
    })
    try {
      await registration.update()
      const worker = registration.waiting ?? registration.installing ?? await updateFound
      if (worker.state !== 'installed') await new Promise<void>((resolve, reject) => {
        const onStateChange = () => {
          if (worker.state !== 'installed' && worker.state !== 'redundant') return
          worker.removeEventListener('statechange', onStateChange)
          if (worker.state === 'redundant') reject(new Error('The offline update failed during installation'))
          else resolve()
        }
        worker.addEventListener('statechange', onStateChange)
        onStateChange()
      })
    } finally {
      if (onUpdateFound) registration.removeEventListener('updatefound', onUpdateFound)
    }
  })
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true)
}

async function addItem(page: Page, name: string, count?: number) {
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add inventory item' })
  await dialog.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await dialog.getByLabel('Item name').fill(name)
  if (count !== undefined) {
    await dialog.getByLabel('Do you own it?').selectOption('owned')
    await dialog.getByLabel('How many?').selectOption('exact')
    await dialog.getByLabel('Current count').fill(String(count))
  }
  await dialog.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
}

async function exportPayload(page: Page) {
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  const path = await download.path()
  if (!path) throw new Error('The local backup download was unavailable')
  const bytes = await readFile(path)
  const files = unzipSync(bytes)
  const payload = JSON.parse(strFromU8(files['bundle.json']!))
  await closeData(page)
  return { bytes, payload }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/inventory')
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
})

test('settings keeps keyboard focus within its sheet and returns focus on escape', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const trigger = page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(dialog).toBeVisible()
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog[open]')))).toBe(true)
  }
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog[open]')))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test('manual observations preserve unknowns and survive reload without horizontal overflow', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await addItem(page, 'Unknown keepsake')
  await expect(page.getByText('Possession unknown', { exact: true })).toBeVisible()
  await addItem(page, 'Known keepsake', 2)
  await page.getByLabel('Search inventory').fill('Known keepsake')
  await expect(page.getByText('Known keepsake', { exact: true })).toBeVisible()
  await page.getByLabel('Search inventory').fill('')
  await page.reload()
  await expect(page.getByText('Unknown keepsake', { exact: true })).toBeVisible()
  await expect(page.getByText('Known keepsake', { exact: true })).toBeVisible()
  const { payload } = await exportPayload(page)
  const inventory = Object.values(selectedPlaythrough(payload.localData).inventory) as { observedName: string; possession: string; quantity: unknown }[]
  expect(inventory.find((item) => item.observedName === 'Unknown keepsake')).toMatchObject({ possession: 'unknown', quantity: { kind: 'unknown' } })
  expect(inventory.find((item) => item.observedName === 'Known keepsake')).toMatchObject({ possession: 'owned', quantity: { kind: 'exact', value: 2 } })
  expect(selectedPlaythrough(payload.localData).characters).toEqual({})
  expect(selectedPlaythrough(payload.localData).inventoryEvents).toEqual({})
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('empty and oversized imports reject before reading file bytes', async ({ page }) => {
  await addItem(page, 'Retained notebook', 1)
  const panel = await openData(page)
  await page.evaluate(() => {
    const state = window as Window & { importFileReads?: number }
    state.importFileReads = 0
    File.prototype.arrayBuffer = async () => {
      state.importFileReads = (state.importFileReads ?? 0) + 1
      throw new Error('The size guard did not run before reading')
    }
  })
  for (const size of [0, 32 * 1024 * 1024 + 1]) {
    await page.evaluate((claimedSize) => {
      Object.defineProperty(File.prototype, 'size', { configurable: true, get: () => claimedSize })
    }, size)
    await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-size-check.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
    await expect(panel.getByRole('alert')).toContainText(size === 0 ? 'The selected file is empty' : 'The selected file exceeds the 32 MiB local import limit')
    expect(await page.evaluate(() => (window as Window & { importFileReads?: number }).importFileReads)).toBe(0)
    await expect(panel.getByText('Import preview', { exact: true })).not.toBeVisible()
  }
  await closeData(page)
  await expect(page.getByText('Retained notebook', { exact: true })).toBeVisible()
})

test('import previews before writing and native restore keeps original source bytes', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-research.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_RESEARCH)) })
  await expect(panel.getByText('Import preview', { exact: true })).toBeVisible()
  await expect(panel.locator('[aria-label="Records in this file"]')).toContainText('Reference records')
  await expect(panel.getByText('Replace your planner data', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Replace planner data', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: 'Replace planner data', exact: true })).toHaveClass(/button--danger/)
  await expect(panel.locator('.import-preview .import-preview__details')).not.toHaveAttribute('open')
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  await expect(page.getByRole('heading', { name: 'Record your first item' })).toBeVisible()
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  await page.getByLabel('Search reference', { exact: true }).fill('synthetic staff')
  await expect(page.getByRole('link', { name: /Reed Staff/ })).toBeVisible()
  await page.getByLabel('Search reference', { exact: true }).fill('Paper Shield')
  const paperShield = page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Paper Shield', exact: true }) })
  await paperShield.click()
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true }).first()).toBeVisible()
  await expect(page.locator('img[src="x"]')).toHaveCount(0)
  await page.goBack()
  await expect(page.getByLabel('Search reference', { exact: true })).toHaveValue('Paper Shield')
  await expect(paperShield).toBeVisible()
  await page.getByRole('button', { name: 'Inventory', exact: true }).click()
  const { bytes, payload } = await exportPayload(page)
  const importedCatalog = payload.catalogs.find((catalog: { entities: Record<string, unknown> }) => catalog.entities['synthetic:reed-staff'])
  expect(importedCatalog.entities['synthetic:reed-staff'].name).toBe('Reed Staff')
  expect(selectedPlaythrough(payload.localData).inventory).toEqual({})
  expect(selectedPlaythrough(payload.localData).characters).toEqual({})
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['manifest.json']!))
  expect(manifest.sources.some((source: { path: string }) => strFromU8(files[source.path]!) === JSON.stringify(SYNTHETIC_RESEARCH))).toBe(true)
  const restore = await openData(page)
  await restore.locator('input[type="file"]').setInputFiles({ name: 'synthetic-backup.zip', mimeType: 'application/zip', buffer: bytes })
  await restore.getByText('File details and source notices', { exact: true }).click()
  await expect(restore.getByText('native-backup-2.1.0', { exact: true })).toBeVisible()
  await replacePlannerData(restore)
  await expect(restore).not.toBeVisible()
  const restored = await exportPayload(page)
  expect(restored.payload.localData.id).toBe(payload.localData.id)
  expect(restored.payload.catalogs).toEqual(payload.catalogs)
  expect(selectedPlaythrough(restored.payload.localData).inventory).toEqual({})
})

test('an imported Game Setup preserves unknown rules while difficulty remains editable', async ({ page }) => {
  const panel = await openData(page)
  const research = { ...SYNTHETIC_RESEARCH, player_context: { platform: 'Nintendo Switch' } }
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-game-setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(research)) })
  await panel.getByRole('combobox', { name: /^Import action/ }).selectOption('replace')
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()

  const settings = await openData(page)
  await openCurrentGameSetup(settings)
  await openGameSetupSection(settings, 'Rules from game data')
  await expect(settings.getByLabel('Build PP limit', { exact: true })).toHaveCount(0)
  await settings.getByLabel('Game Setup label').fill('Synthetic unknown PP setup')
  await settings.getByRole('combobox', { name: 'Difficulty', exact: true }).selectOption('2')
  await saveAndApplyGameSetup(settings)
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await closeData(page)
  const { payload } = await exportPayload(page)
  const setup = payload.localData.gameSetups[payload.localData.planningGameSetupRevisionId]
  expect(setup.ppLimit).toMatchObject({ state: 'unknown' })
  expect(setup.difficulty).toEqual({ version: 1, selection: { state: 'known', value: 2 } })
})

test('large previews bound warning and facet elements while keeping every facet reachable', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  const reference = {
    schema_version: '1.1.0',
    base_equipment: Array.from({ length: 250 }, (_, index) => ({
      id: `synthetic:item-${index}`,
      name: `Synthetic item ${index}`,
      category: `Synthetic category ${String(index).padStart(3, '0')}`,
    })),
    passives: Array.from({ length: 250 }, (_, index) => ({ id: `synthetic:unnamed-${index}` })),
  }
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-large-facets.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reference)) })
  await expect(panel.getByText('Import preview', { exact: true })).toBeVisible()
  await expect(panel.getByText('Additional warnings omitted', { exact: true })).toBeVisible()
  const warningRows = await panel.getByText('passives contains a row without a supported name field', { exact: true }).count()
  expect(warningRows).toBeGreaterThan(0)
  expect(warningRows).toBeLessThanOrEqual(100)
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  if (isMobile) await page.getByRole('button', { name: /^Filters/ }).click()
  const categories = page.getByRole('group', { name: 'Reference category filters', exact: true })
  expect(await categories.getByRole('button').count()).toBeLessThanOrEqual(41)
  await expect(categories.getByRole('button', { name: 'Synthetic category 249 (1)', exact: true })).toHaveCount(0)
  await page.getByLabel('Search reference categories', { exact: true }).fill('249')
  await categories.getByRole('button', { name: 'Synthetic category 249 (1)', exact: true }).click()
  await expect(page.getByRole('link', { name: /Synthetic item 249/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Synthetic item 0 / })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('replacement confirmation belongs to one import preview', async ({ page }) => {
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-first-preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_RESEARCH)) })
  const action = panel.getByRole('combobox', { name: /^Import action/ })
  await action.selectOption('replace')
  await panel.getByRole('checkbox', { name: /Replace all planner data/ }).check()
  await expect(panel.getByRole('button', { name: 'Replace planner data', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: 'Choose another file', exact: true }).click()
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-second-preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...SYNTHETIC_RESEARCH, synthetic_note: 'Different preview' })) })
  await expect(action).toHaveValue('replace')
  await expect(panel.getByRole('checkbox', { name: /Replace all planner data/ })).not.toBeChecked()
  await expect(panel.getByRole('button', { name: 'Replace planner data', exact: true })).toBeDisabled()
})

test('Playthrough switching isolates records and undo restores the previous observation', async ({ page }) => {
  await addItem(page, 'First Playthrough keepsake', 1)
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Playthrough', exact: true }).click()
  const playthroughs = panel.getByRole('combobox', { name: 'Active Playthrough', exact: true })
  const original = await playthroughs.inputValue()
  await panel.locator('.playthrough-create > summary').click()
  await panel.getByLabel('New blank Playthrough').fill('Synthetic second Playthrough')
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(playthroughs).not.toHaveValue(original)
  await closeData(page)
  await expect(page.getByText('First Playthrough keepsake', { exact: true })).not.toBeVisible()
  await addItem(page, 'Second Playthrough keepsake', 2)
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'History', exact: true }).click()
  await settings.getByRole('checkbox', { name: /Restore the previous saved planner state/ }).check()
  await settings.getByRole('button', { name: 'Undo latest', exact: true }).click()
  await expect(settings.getByRole('checkbox', { name: /Restore the previous saved planner state/ })).not.toBeChecked()
  await closeData(page)
  await expect(page.getByText('Second Playthrough keepsake', { exact: true })).not.toBeVisible()
  const switcher = await openData(page)
  await switcher.getByRole('button', { name: 'Playthrough', exact: true }).click()
  await switcher.getByRole('combobox', { name: 'Active Playthrough', exact: true }).selectOption(original)
  await expect(switcher).toBeVisible()
  await closeData(page)
  await page.getByRole('button', { name: 'Inventory', exact: true }).filter({ visible: true }).click()
  await expect(page.getByText('First Playthrough keepsake', { exact: true })).toBeVisible()
  await expect(page.getByText('Second Playthrough keepsake', { exact: true })).not.toBeVisible()
})

test('reference facets combine alternatives and keep unknown numeric values as possible matches', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-facets.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_RESEARCH)) })
  await expect(panel.getByText('Import preview', { exact: true })).toBeVisible()
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  if (isMobile) await page.getByRole('button', { name: /^Filters/ }).click()
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  const sources = page.getByRole('group', { name: 'Reference source filters', exact: true })
  await page.getByLabel('Search reference sources', { exact: true }).fill('source:sha256')
  await sources.getByRole('button', { name: /^(source:sha256:[0-9a-f]{64})\. Full source: \1\. \d+ matches$/ }).click()
  const categories = page.locator('.facet-group').filter({ has: page.getByRole('heading', { name: 'Category', exact: true }) })
  const categorySearch = page.getByLabel('Search reference categories', { exact: true })
  await categorySearch.fill('Staff')
  await categories.getByRole('button', { name: /^Staves \(\d+\)$/ }).click()
  await categorySearch.fill('Shield')
  await categories.getByRole('button', { name: /^Shields \(\d+\)$/ }).click()
  await expect(page.getByRole('link', { name: /Reed Staff/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Paper Shield/ })).toBeVisible()
  await categories.getByRole('button', { name: 'All categories', exact: true }).click()
  await page.getByRole('button', { name: 'Definition type', exact: true }).click()
  const kinds = page.locator('.facet-group').filter({ has: page.getByRole('heading', { name: 'Definition type', exact: true }) })
  await kinds.getByRole('button', { name: /^Passives \d+$/ }).click()
  await page.getByRole('button', { name: 'PP cost', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Maximum', exact: true }).fill('3')
  await expect(page.getByRole('link', { name: /Focus/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Patience/ })).toContainText('Possible match')
  await expect(page.getByRole('link', { name: /Reed Staff/ })).toHaveCount(0)
  await page.getByRole('spinbutton', { name: 'Maximum', exact: true }).fill('1')
  await expect(page.getByRole('link', { name: /Focus/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Patience/ })).toContainText('Possible match')
  await expect(page.getByText('Only possible matches', { exact: true })).toBeVisible()
})

test('inventory facets and search survive browser back navigation', async ({ page }) => {
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-inventory.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_RESEARCH)) })
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  for (const name of ['Reed Staff', 'Paper Shield']) {
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
    await form.getByRole('button', { name: 'Choose Item definition', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose Item definition', exact: true })
    await picker.getByLabel('Search available definitions', { exact: true }).fill(name)
    await picker.getByRole('button', { name: new RegExp(`^${name} `) }).click()
    await expect(picker).not.toBeVisible()
    await form.getByLabel('Do you own it?').selectOption('owned')
    await form.getByRole('button', { name: 'Add item', exact: true }).click()
    await expect(form).not.toBeVisible()
  }
  await page.getByRole('button', { name: 'Linked category: All categories', exact: true }).click()
  await page.getByRole('group', { name: 'Inventory category filters', exact: true }).getByRole('button', { name: 'Staves (1)', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Reed Staff', { exact: true })).toBeVisible()
  await expect(page.getByText('Paper Shield', { exact: true })).not.toBeVisible()
  await page.getByLabel('Search inventory').fill('synthetic staff')
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await expect(page.getByLabel('Search inventory')).toHaveValue('synthetic staff')
  await page.getByRole('button', { name: 'Linked category: Staves', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Inventory category filters', exact: true }).getByRole('button', { name: 'Staves (1)', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Reed Staff', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('a production shell reloads and exports after going offline', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  await addItem(page, 'Offline keepsake', 1)
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(panel)
  await closeData(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText('Offline keepsake', { exact: true })).toBeVisible()
  await addItem(page, 'Recorded offline')
  const { payload } = await exportPayload(page)
  expect(Object.values(selectedPlaythrough(payload.localData).inventory)).toEqual(expect.arrayContaining([expect.objectContaining({ observedName: 'Recorded offline', possession: 'unknown' })]))
  await context.setOffline(false)
})

test('offline preparation repairs missing cached assets before reporting ready', async ({ page, context }) => {
  let panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(panel)
  await closeData(page)
  await page.evaluate(async () => {
    const names = await caches.keys()
    for (const name of names.filter((value) => value.startsWith('crykit-shell-'))) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) if (request.url.endsWith('.css')) await cache.delete(request)
    }
  })
  panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await expect(panel.getByText('Not ready', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(panel)
  await closeData(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0)
  await context.setOffline(false)
})

test('stale tabs cannot overwrite saved planner data and can export their recovery draft', async ({ page, context }) => {
  await addItem(page, 'Shared baseline', 1)
  const stale = await context.newPage()
  await stale.goto('/#/inventory')
  await expect(stale.getByText('Shared baseline', { exact: true })).toBeVisible()
  await addItem(page, 'Saved in first tab', 1)
  await addItem(page, 'Later first-tab observation', 1)
  await expect(stale.getByText('Another tab changed the planner data', { exact: true })).toBeVisible()
  await stale.getByRole('button', { name: 'Add item', exact: true }).click()
  const dialog = stale.getByRole('dialog', { name: 'Add inventory item' })
  await dialog.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await dialog.getByLabel('Item name').fill('Unsaved in stale tab')
  await dialog.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(stale.getByText('Local save failed', { exact: true }).first()).toBeAttached()
  await expect(dialog.getByLabel('Item name')).toHaveValue('Unsaved in stale tab')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  const recovery = await exportPayload(stale)
  expect(Object.values(selectedPlaythrough(recovery.payload.localData).inventory)).toEqual(expect.arrayContaining([expect.objectContaining({ observedName: 'Unsaved in stale tab' })]))
  const stored = await exportPayload(page)
  expect(Object.values(selectedPlaythrough(stored.payload.localData).inventory)).not.toEqual(expect.arrayContaining([expect.objectContaining({ observedName: 'Unsaved in stale tab' })]))
  await stale.close()
})

test('a quota failure keeps the draft exportable and leaves persisted observations intact', async ({ page }) => {
  await addItem(page, 'Before storage failure', 1)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') throw new DOMException('Synthetic storage limit', 'QuotaExceededError')
      return original.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add inventory item' })
  await dialog.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await dialog.getByLabel('Item name').fill('Recovery-only observation')
  await dialog.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(page.getByText('Local save failed', { exact: true }).first()).toBeAttached()
  await expect(dialog.getByLabel('Item name')).toHaveValue('Recovery-only observation')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  const recovery = await exportPayload(page)
  expect(Object.values(selectedPlaythrough(recovery.payload.localData).inventory)).toEqual(expect.arrayContaining([expect.objectContaining({ observedName: 'Recovery-only observation' })]))
  const storage = await openData(page)
  await storage.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await expect(storage.getByRole('button', { name: 'Refresh app', exact: true })).toBeDisabled()
  await closeData(page)
  await page.reload()
  await expect(page.getByText('Before storage failure', { exact: true })).toBeVisible()
  await expect(page.getByText('Recovery-only observation', { exact: true })).not.toBeVisible()
})

test('retry persists one retained observation after a transient storage failure', async ({ page }) => {
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    let failOnce = true
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas' && failOnce) {
        failOnce = false
        throw new DOMException('Synthetic temporary storage failure', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Add inventory item' })
  await form.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await form.getByLabel('Item name').fill('Retry once keepsake')
  await form.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(page.getByText('Local save failed', { exact: true }).first()).toBeAttached()
  await form.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.reload()
  const { payload } = await exportPayload(page)
  expect(Object.values(selectedPlaythrough(payload.localData).inventory)).toHaveLength(1)
  expect(Object.values(payload.localData.personalDefinitions)).toHaveLength(1)
  expect(Object.values(selectedPlaythrough(payload.localData).inventory)[0]).toMatchObject({ observedName: 'Retry once keepsake', possession: 'unknown' })
})

test('subpath installation stages updates without reloading an open draft', async ({ page, context }) => {
  let generation = 1
  const mimeTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname === '/journal/index.html') {
        response.writeHead(307, { Location: '/journal/' }).end()
        return
      }
      const relative = pathname.replace(/^\/journal\//, '') || 'index.html'
      if (!pathname.startsWith('/journal/') || relative.includes('..')) {
        response.writeHead(404).end()
        return
      }
      let bytes = await readFile(join(process.cwd(), 'dist', relative))
      if (relative === 'sw.js') {
        const source = bytes.toString()
        const fileList = source.match(/^const FILES = (.*);$/m)
        if (!fileList) throw new Error('The offline asset list is unavailable')
        const files = JSON.parse(fileList[1]) as string[]
        // This journey checks update staging; full asset caching has separate offline coverage
        const shellFiles = files.filter(file => file === 'index.html' || file === 'icon.svg' || file === 'manifest.webmanifest' || file.endsWith('.js') || file.endsWith('.css'))
        bytes = Buffer.from(source.replace(/^const CACHE_NAME = .*;$/m, `const CACHE_NAME = 'crykit-shell-test-build-${generation}';`).replace(/^const FILES = .*;$/m, `const FILES = ${JSON.stringify(shellFiles)};`))
      }
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(relative)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', Vary: 'Origin' })
      response.end(bytes)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The static fixture did not start')
  try {
    await page.goto(`http://127.0.0.1:${address.port}/journal/#/inventory`)
    await addItem(page, 'Portable origin observation', 1)
    const panel = await openData(page)
    await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
    await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
    await expectOfflineReady(panel)
    await page.evaluate(async () => {
      await (await caches.open('crykit-shell-other-installation')).put('/other/index.html', new Response('Other installation'))
      await (await caches.open('unrelated-application')).put('/journal/index.html', new Response('Unrelated application'))
      await (await caches.open('crykit-shell-test-build-1')).put('/journal/assets/previous-build-only.js', new Response('Previous build asset'))
    })
    expect(await page.evaluate(async () => (await (await caches.open('crykit-shell-test-build-1')).match('/journal/index.html'))?.redirected)).toBe(true)
    await closeData(page)
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    const entry = page.getByRole('dialog', { name: 'Add inventory item' })
    await entry.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
    await entry.getByLabel('Item name').fill('Keep this unsaved form')
    generation = 2
    await stageServiceWorkerUpdate(page)
    await expect(entry.getByLabel('Item name')).toHaveValue('Keep this unsaved form')
    await entry.getByRole('button', { name: 'Cancel', exact: true }).click()
    const update = await openData(page)
    await update.getByRole('button', { name: 'Offline & storage', exact: true }).click()
    await expect(update.getByRole('button', { name: 'Apply app update', exact: true })).toBeVisible()
    // Activation reloads the page before the settings dialog is restored
    await Promise.all([
      page.waitForEvent('load'),
      update.getByRole('button', { name: 'Apply app update', exact: true }).click(),
    ])
    await expect(page).toHaveURL(/\/journal\/#\/settings\/storage$/)
    await expect(update).toBeVisible()
    await expect(update.getByRole('button', { name: 'Apply app update', exact: true })).not.toBeVisible()
    expect(await page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(['crykit-shell-test-build-1', 'crykit-shell-test-build-2']))
    await context.setOffline(true)
    expect(await page.evaluate(async () => (await fetch('./assets/previous-build-only.js')).text())).toBe('Previous build asset')
    await page.reload()
    await expect(page).toHaveURL(/\/journal\/#\/settings\/storage$/)
    await expectOfflineReady(update)
    await closeData(page)
    await expect(update).not.toBeVisible()
    await expect(page.getByText('Portable origin observation', { exact: true })).toBeVisible()
    await context.setOffline(false)
    generation = 3
    await stageServiceWorkerUpdate(page)
    const thirdUpdate = await openData(page)
    await thirdUpdate.getByRole('button', { name: 'Offline & storage', exact: true }).click()
    await Promise.all([
      page.waitForEvent('load'),
      thirdUpdate.getByRole('button', { name: 'Apply app update', exact: true }).click(),
    ])
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(['crykit-shell-test-build-2', 'crykit-shell-test-build-3', 'crykit-shell-other-installation', 'unrelated-application']))
    await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain('crykit-shell-test-build-1')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

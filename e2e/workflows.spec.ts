import { createBlankPlaythrough } from './profile-helpers'
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

async function addItem(page: Page, name: string, count?: number) {
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add inventory item' })
  await dialog.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await dialog.getByLabel('Item name').fill(name)
  if (count !== undefined) {
    await dialog.getByLabel('Current possession').selectOption('owned')
    await dialog.getByLabel('Quantity certainty').selectOption('exact')
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
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
})

test('settings keeps keyboard focus within its sheet and returns focus on escape', async ({ page }) => {
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

test('manual observations preserve unknowns and survive reload without horizontal overflow', async ({ page }) => {
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
  const inventory = Object.values(payload.profile.inventory) as { observedName: string; possession: string; quantity: unknown }[]
  expect(inventory.find((item) => item.observedName === 'Unknown keepsake')).toMatchObject({ possession: 'unknown', quantity: { kind: 'unknown' } })
  expect(inventory.find((item) => item.observedName === 'Known keepsake')).toMatchObject({ possession: 'owned', quantity: { kind: 'exact', value: 2 } })
  expect(payload.profile.characters).toEqual({})
  expect(payload.profile.inventoryEvents).toEqual({})
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

test('import previews before writing and native restore keeps original source bytes', async ({ page }) => {
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-research.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_RESEARCH)) })
  await expect(panel.getByText('Import preview', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await expect(page.getByRole('heading', { name: 'Record your first item' })).toBeVisible()
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  await page.getByLabel('Search reference', { exact: true }).fill('synthetic staff')
  await expect(page.getByRole('button', { name: /Reed Staff/ })).toBeVisible()
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
  expect(payload.profile.inventory).toEqual({})
  expect(payload.profile.characters).toEqual({})
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['manifest.json']!))
  expect(strFromU8(files[manifest.sources[0].path]!)).toBe(JSON.stringify(SYNTHETIC_RESEARCH))
  const restore = await openData(page)
  await restore.locator('input[type="file"]').setInputFiles({ name: 'synthetic-backup.zip', mimeType: 'application/zip', buffer: bytes })
  await expect(restore.getByText('native-backup-1.0.0', { exact: true })).toBeVisible()
  await restore.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(restore).not.toBeVisible()
  const restored = await exportPayload(page)
  expect(restored.payload.profile.id).not.toBe(payload.profile.id)
  expect(restored.payload.catalogs).toEqual(payload.catalogs)
  expect(restored.payload.profile.inventory).toEqual({})
})

test('large previews bound warning and facet elements while keeping every facet reachable', async ({ page, isMobile }) => {
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
  await panel.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  if (isMobile) await page.getByRole('button', { name: /^Filters/ }).click()
  const categories = page.getByRole('group', { name: 'Reference category filters', exact: true })
  expect(await categories.getByRole('button').count()).toBeLessThanOrEqual(41)
  await expect(categories.getByRole('button', { name: 'Synthetic category 249 (1)', exact: true })).toHaveCount(0)
  await page.getByLabel('Search reference categories', { exact: true }).fill('249')
  await categories.getByRole('button', { name: 'Synthetic category 249 (1)', exact: true }).click()
  await expect(page.getByRole('button', { name: /Synthetic item 249/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Synthetic item 0 / })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('replacement confirmation belongs to one preview and one target profile', async ({ page }) => {
  const panel = await openData(page)
  const profiles = panel.getByRole('combobox', { name: 'Active profile', exact: true })
  const firstProfileId = await profiles.inputValue()
  await panel.getByLabel('New blank profile').fill('Second replacement target')
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(profiles).not.toHaveValue(firstProfileId)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-first-preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_RESEARCH)) })
  const action = panel.getByRole('combobox', { name: /^Import action/ })
  await action.selectOption('replace')
  await panel.getByRole('checkbox', { name: /Replace the current profile after validation/ }).check()
  await expect(panel.getByRole('button', { name: 'Replace profile', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: 'Choose another file', exact: true }).click()
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-second-preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...SYNTHETIC_RESEARCH, synthetic_note: 'Different preview' })) })
  await expect(action).toHaveValue('new-profile')
  await action.selectOption('replace')
  await expect(panel.getByRole('checkbox', { name: /Replace the current profile after validation/ })).not.toBeChecked()
  await expect(panel.getByRole('button', { name: 'Replace profile', exact: true })).toBeDisabled()
  await panel.getByRole('checkbox', { name: /Replace the current profile after validation/ }).check()
  await profiles.selectOption(firstProfileId)
  await expect(action).toHaveValue('new-profile')
  await action.selectOption('replace')
  await expect(panel.getByRole('checkbox', { name: /Replace the current profile after validation/ })).not.toBeChecked()
  await expect(panel.getByRole('button', { name: 'Replace profile', exact: true })).toBeDisabled()
})

test('local profile switching isolates records and undo restores the previous observation', async ({ page }) => {
  await addItem(page, 'First profile keepsake', 1)
  const original = (await exportPayload(page)).payload.profile.id as string
  const panel = await openData(page)
  await panel.getByLabel('New blank profile').fill('Synthetic second profile')
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Active profile', exact: true })).not.toHaveValue(original)
  await closeData(page)
  await expect(page.getByText('First profile keepsake', { exact: true })).not.toBeVisible()
  await addItem(page, 'Second profile keepsake', 2)
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'History', exact: true }).click()
  await settings.getByRole('checkbox', { name: /Restore the previous saved profile state/ }).check()
  await settings.getByRole('button', { name: 'Undo latest', exact: true }).click()
  await expect(settings.getByRole('checkbox', { name: /Restore the previous saved profile state/ })).not.toBeChecked()
  await closeData(page)
  await expect(page.getByText('Second profile keepsake', { exact: true })).not.toBeVisible()
  const switcher = await openData(page)
  await switcher.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await switcher.getByRole('combobox', { name: 'Active profile', exact: true }).selectOption(original)
  await closeData(page)
  await expect(page.getByText('First profile keepsake', { exact: true })).toBeVisible()
  await expect(page.getByText('Second profile keepsake', { exact: true })).not.toBeVisible()
})

test('reference facets combine alternatives and keep unknown numeric values as possible matches', async ({ page, isMobile }) => {
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-facets.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_RESEARCH)) })
  await expect(panel.getByText('Import preview', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Create profile', exact: true }).click()
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
  await categories.getByRole('button', { name: /^Staff \(\d+\)$/ }).click()
  await categorySearch.fill('Shield')
  await categories.getByRole('button', { name: /^Shield \(\d+\)$/ }).click()
  await expect(page.getByRole('button', { name: /Reed Staff/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Paper Shield/ })).toBeVisible()
  await categories.getByRole('button', { name: 'All categories', exact: true }).click()
  await page.getByRole('button', { name: 'Definition type', exact: true }).click()
  const kinds = page.locator('.facet-group').filter({ has: page.getByRole('heading', { name: 'Definition type', exact: true }) })
  await kinds.getByRole('button', { name: /^Passives \d+$/ }).click()
  await page.getByRole('button', { name: 'PP cost', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Maximum', exact: true }).fill('3')
  await expect(page.getByRole('button', { name: /Focus/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Patience/ })).toContainText('Possible match')
  await expect(page.getByRole('button', { name: /Reed Staff/ })).toHaveCount(0)
  await page.getByRole('spinbutton', { name: 'Maximum', exact: true }).fill('1')
  await expect(page.getByRole('button', { name: /Focus/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Patience/ })).toContainText('Possible match')
  await expect(page.getByText('Only possible matches', { exact: true })).toBeVisible()
})

test('inventory facets and search survive browser back navigation', async ({ page }) => {
  const panel = await openData(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-inventory.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_RESEARCH)) })
  await panel.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(panel).not.toBeVisible()
  for (const name of ['Reed Staff', 'Paper Shield']) {
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
    await form.getByRole('button', { name: 'Choose Item definition', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose Item definition', exact: true })
    await picker.getByLabel('Search available definitions', { exact: true }).fill(name)
    await picker.getByRole('button', { name: new RegExp(`^${name} `) }).click()
    await expect(picker).not.toBeVisible()
    await form.getByLabel('Current possession').selectOption('owned')
    await form.getByRole('button', { name: 'Add item', exact: true }).click()
    await expect(form).not.toBeVisible()
  }
  await page.getByRole('group', { name: 'Inventory category filters', exact: true }).getByRole('button', { name: 'Staff (1)', exact: true }).click()
  await expect(page.getByText('Reed Staff', { exact: true })).toBeVisible()
  await expect(page.getByText('Paper Shield', { exact: true })).not.toBeVisible()
  await page.getByLabel('Search inventory').fill('synthetic staff')
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await expect(page.getByLabel('Search inventory')).toHaveValue('synthetic staff')
  await expect(page.getByRole('group', { name: 'Inventory category filters', exact: true }).getByRole('button', { name: 'Staff (1)', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Reed Staff', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('a production shell reloads and exports after going offline', async ({ page, context }) => {
  await addItem(page, 'Offline keepsake', 1)
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expect(panel.getByText('Offline ready', { exact: true })).toBeVisible({ timeout: 15_000 })
  await closeData(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText('Offline keepsake', { exact: true })).toBeVisible()
  await addItem(page, 'Recorded offline')
  const { payload } = await exportPayload(page)
  expect(Object.values(payload.profile.inventory)).toEqual(expect.arrayContaining([expect.objectContaining({ observedName: 'Recorded offline', possession: 'unknown' })]))
  await context.setOffline(false)
})

test('offline preparation repairs missing cached assets before reporting ready', async ({ page, context }) => {
  let panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expect(panel.getByText('Offline ready', { exact: true })).toBeVisible()
  await closeData(page)
  await page.evaluate(async () => {
    const names = await caches.keys()
    for (const name of names.filter((value) => value.startsWith('crystal-companion-shell-'))) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) if (request.url.endsWith('.css')) await cache.delete(request)
    }
  })
  panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await expect(panel.getByText('Not ready', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expect(panel.getByText('Offline ready', { exact: true })).toBeVisible()
  await closeData(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0)
  await context.setOffline(false)
})

test('stale tabs cannot overwrite a saved profile and can export their recovery draft', async ({ page, context }) => {
  await addItem(page, 'Shared baseline', 1)
  const stale = await context.newPage()
  await stale.goto('/')
  await expect(stale.getByText('Shared baseline', { exact: true })).toBeVisible()
  await addItem(page, 'Saved in first tab', 1)
  await addItem(page, 'Later first-tab observation', 1)
  await expect(stale.getByText('Another tab changed this profile', { exact: true })).toBeVisible()
  await stale.getByRole('button', { name: 'Add item', exact: true }).click()
  const dialog = stale.getByRole('dialog', { name: 'Add inventory item' })
  await dialog.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await dialog.getByLabel('Item name').fill('Unsaved in stale tab')
  await dialog.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(stale.getByText('Local save failed', { exact: true }).first()).toBeAttached()
  await expect(dialog.getByLabel('Item name')).toHaveValue('Unsaved in stale tab')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  const recovery = await exportPayload(stale)
  expect(Object.values(recovery.payload.profile.inventory)).toEqual(expect.arrayContaining([expect.objectContaining({ observedName: 'Unsaved in stale tab' })]))
  const stored = await exportPayload(page)
  expect(Object.values(stored.payload.profile.inventory)).not.toEqual(expect.arrayContaining([expect.objectContaining({ observedName: 'Unsaved in stale tab' })]))
  await stale.close()
})

test('a quota failure keeps the draft exportable and leaves persisted observations intact', async ({ page }) => {
  await addItem(page, 'Before storage failure', 1)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'profiles') throw new DOMException('Synthetic storage limit', 'QuotaExceededError')
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
  expect(Object.values(recovery.payload.profile.inventory)).toEqual(expect.arrayContaining([expect.objectContaining({ observedName: 'Recovery-only observation' })]))
  await page.reload()
  await expect(page.getByText('Before storage failure', { exact: true })).toBeVisible()
  await expect(page.getByText('Recovery-only observation', { exact: true })).not.toBeVisible()
})

test('retry persists one retained observation after a transient storage failure', async ({ page }) => {
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    let failOnce = true
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'profiles' && failOnce) {
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
  expect(Object.values(payload.profile.inventory)).toHaveLength(1)
  expect(Object.values(payload.profile.personalDefinitions)).toHaveLength(1)
  expect(Object.values(payload.profile.inventory)[0]).toMatchObject({ observedName: 'Retry once keepsake', possession: 'unknown' })
})

test('subpath installation stages updates without reloading an open draft', async ({ page, context }) => {
  let generation = 1
  const mimeTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      const relative = pathname.replace(/^\/journal\//, '') || 'index.html'
      if (!pathname.startsWith('/journal/') || relative.includes('..')) {
        response.writeHead(404).end()
        return
      }
      let bytes = await readFile(join(process.cwd(), 'dist', relative))
      if (relative === 'sw.js') bytes = Buffer.from(`${bytes.toString()}\n// Synthetic deployment generation ${generation}\n`)
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
    await page.goto(`http://127.0.0.1:${address.port}/journal/`)
    await addItem(page, 'Portable origin observation', 1)
    const panel = await openData(page)
    await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
    await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
    await expect(panel.getByText('Offline ready', { exact: true })).toBeVisible({ timeout: 15_000 })
    await closeData(page)
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    const entry = page.getByRole('dialog', { name: 'Add inventory item' })
    await entry.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
    await entry.getByLabel('Item name').fill('Keep this unsaved form')
    generation = 2
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update() })
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true)
    await expect(entry.getByLabel('Item name')).toHaveValue('Keep this unsaved form')
    await entry.getByRole('button', { name: 'Cancel', exact: true }).click()
    const update = await openData(page)
    await update.getByRole('button', { name: 'Offline & storage', exact: true }).click()
    await expect(update.getByRole('button', { name: 'Apply app update', exact: true })).toBeVisible()
    await update.getByRole('button', { name: 'Apply app update', exact: true }).click()
    await expect(page.getByText('Portable origin observation', { exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/journal\/#\/settings\/storage$/)
    await expect(update).toBeVisible()
    await expect(update.getByRole('button', { name: 'Apply app update', exact: true })).not.toBeVisible()
    await context.setOffline(true)
    await page.reload()
    await expect(page).toHaveURL(/\/journal\/#\/settings\/storage$/)
    await expect(update.getByText('Offline ready', { exact: true })).toBeVisible()
    await closeData(page)
    await expect(update).not.toBeVisible()
    await expect(page.getByText('Portable origin observation', { exact: true })).toBeVisible()
    await context.setOffline(false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

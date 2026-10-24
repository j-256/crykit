import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { createBlankPlaythrough } from './local-data-helpers'
import { expectOfflineReady } from './offline-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import type { LocalData } from '../src/domain'

const MOD_FILENAME = 'synthetic-refresh.json'
const MOD_SOURCE = '{"EditorVersion":34,"Title":"Original refresh fixture","FutureData":{"keep":true}}'
const MOD_DRAFT = MOD_SOURCE.replace('Original refresh fixture', 'Saved refresh draft')
const MIME_TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
async function startInstallation() {
  let generation = 1
  let failedAsset: string | undefined
  let pausedAsset: string | undefined
  let resumed: Promise<void> | undefined
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (!pathname.startsWith('/journal/') || pathname.includes('..')) { response.writeHead(404).end(); return }
      const relative = pathname.slice('/journal/'.length) || 'index.html'
      if (relative === pausedAsset) await resumed
      if (relative === failedAsset) { response.writeHead(503).end('Synthetic download failure'); return }
      let bytes = await readFile(join(process.cwd(), 'dist', relative))
      if (relative === 'sw.js') {
        bytes = Buffer.from(bytes.toString().replace(/^const CACHE_NAME = .*;$/m, `const CACHE_NAME = 'crykit-shell-refresh-test-${generation}';`))
      }
      response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(relative)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(bytes)
    } catch { response.writeHead(404).end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The refresh installation fixture did not start')
  return {
    url: `http://127.0.0.1:${address.port}/journal/`,
    update: () => { generation += 1 },
    fail: (asset?: string) => { failedAsset = asset },
    pause: (asset: string) => {
      pausedAsset = asset
      let resolve!: () => void
      resumed = new Promise<void>(ready => { resolve = ready })
      return () => { pausedAsset = undefined; resolve() }
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

async function openStorage(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  return panel
}

async function downloadText(page: Page, button: string) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: button, exact: true }).click()
  return readFile((await (await download).path())!, 'utf8')
}

async function exportLocalData(page: Page): Promise<LocalData> {
  const panel = await openStorage(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  if (!await panel.getByRole('button', { name: 'Export planner ZIP', exact: true }).isVisible()) await panel.getByText("What's included in a backup?", { exact: true }).click()
  await panel.getByRole('button', { name: 'Export planner ZIP', exact: true }).click()
  const files = unzipSync(await readFile((await (await download).path())!))
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return JSON.parse(strFromU8(files['bundle.json']!)).localData
}

async function saveObservation(page: Page) {
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Add inventory item' })
  await form.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
  await form.getByLabel('Item name').fill('Keep through app refresh')
  await form.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(form).not.toBeVisible()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
}

test('core offline preparation reports real progress while the page stays responsive', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  const installation = await startInstallation()
  let resume: (() => void) | undefined
  try {
    await page.goto(`${installation.url}#/inventory`)
    const panel = await openStorage(page)
    await expect(panel.getByRole('checkbox')).toHaveCount(3)
    for (const checkbox of await panel.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked()
    resume = installation.pause('icon.svg')
    await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
    const progress = panel.getByRole('progressbar', { name: 'Offline download', exact: true })
    await expect(progress).toBeVisible()
    await expect.poll(() => progress.evaluate((element: HTMLProgressElement) => element.value)).toBeGreaterThan(0)
    expect(await progress.evaluate((element: HTMLProgressElement) => element.value < element.max)).toBe(true)
    await expect(panel.getByText('Offline ready', { exact: true })).not.toBeVisible()
    const frames = await page.evaluate(async () => {
      const timestamps: number[] = []
      while (timestamps.length < 3) await new Promise<void>(resolve => requestAnimationFrame(time => { timestamps.push(time); resolve() }))
      return timestamps
    })
    expect(frames[2]).toBeGreaterThan(frames[0])
    resume()
    await expectOfflineReady(panel)
    const source = await readFile(join(process.cwd(), 'dist/sw.js'), 'utf8')
    const files: string[] = JSON.parse(source.match(/^const FILES = (.*);$/m)![1])
    const groups: Record<string, number[]> = JSON.parse(source.match(/^const GROUPS = (.*);$/m)![1])
    const optionalUrls = ['artwork', 'maps', 'screenshots'].flatMap(id => groups[id].map(index => new URL(files[index], installation.url).href))
    const cached = await page.evaluate(async () => {
      const names = (await caches.keys()).filter(name => name.startsWith('crykit-shell-') || name.startsWith('crykit-refresh-'))
      const urls = (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat()
      return urls
    })
    expect(cached.filter(url => optionalUrls.includes(url))).toEqual([])
    await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await context.setOffline(true)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Add item', exact: true })).toBeVisible()
    await saveObservation(page)
    await page.reload()
    await expect(page.getByText('Keep through app refresh', { exact: true })).toBeVisible()
  } finally { resume?.(); await installation.close() }
})

test('all selected extras verify every built asset before declaring offline readiness', { tag: MOBILE_TEST_TAG }, async ({ page, context }, testInfo) => {
  const installation = await startInstallation()
  try {
    await page.goto(`${installation.url}#/inventory`)
    const panel = await openStorage(page)
    for (const name of ['Artwork', 'Maps', 'Screenshot recognition']) await panel.getByRole('checkbox', { name, exact: true }).check()
    const started = performance.now()
    await test.step('prepare core and every optional offline feature', async () => {
      await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
      await expectOfflineReady(panel)
    })
    const durationMs = performance.now() - started
    await testInfo.attach('offline-preparation-timing', { body: JSON.stringify({ selection: 'all', durationMs }), contentType: 'application/json' })
    const source = await readFile(join(process.cwd(), 'dist/sw.js'), 'utf8')
    const files: string[] = JSON.parse(source.match(/^const FILES = (.*);$/m)![1])
    const cached = await page.evaluate(async () => {
      const cache = await caches.open('crykit-shell-refresh-test-1')
      return (await cache.keys()).map(request => request.url)
    })
    expect(cached).toEqual(expect.arrayContaining(files.map(file => new URL(file, installation.url).href)))
    await panel.screenshot({ path: testInfo.outputPath('offline-download-options.png') })
    await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await context.setOffline(true)
    await page.reload()
    const reopened = await openStorage(page)
    await expectOfflineReady(reopened)
    for (const name of ['Artwork', 'Maps', 'Screenshot recognition']) await expect(reopened.getByRole('checkbox', { name, exact: true })).toBeChecked()
  } finally { await installation.close() }
})

test('refresh repairs cached files and preserves planner records and saved Mod Inspector bytes', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  const installation = await startInstallation()
  try {
    await page.goto(`${installation.url}#/inventory`)
    await createBlankPlaythrough(page)
    await saveObservation(page)
    const before = await exportLocalData(page)
    await page.goto(`${installation.url}#/mods/editor`)
    await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: MOD_FILENAME, mimeType: 'application/json', buffer: Buffer.from(MOD_SOURCE) })
    await expect(page.getByRole('status').filter({ hasText: /^Saved in this browser$/ })).toBeVisible()
    await page.getByLabel('Search keys, values, and decoded names', { exact: true }).fill('$.Title')
    await page.locator('.inspector-search-result').filter({ has: page.locator('code', { hasText: /^\$\.Title$/ }) }).click()
    await page.getByRole('textbox', { name: /^Exact JSON value/ }).fill('"Saved refresh draft"')
    await page.getByRole('button', { name: 'Apply JSON edit', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: /^Saved in this browser$/ })).toBeVisible()
    // Editor file commands share the planner journal; Refresh must preserve the complete post-edit baseline
    const beforeRefresh = await exportLocalData(page)
    const editorChanges = beforeRefresh.changes.slice(before.changes.length)
    expect(editorChanges.map(change => change.command)).toEqual(['import', 'saveUnfinished', 'apply'])
    for (const [index, change] of editorChanges.entries()) expect(change).toMatchObject({ previousRevision: before.revision + index, nextRevision: before.revision + index + 1, changedPaths: ['$'] })
    expect(beforeRefresh.updatedAt).toBe(editorChanges.at(-1)!.recordedAt)
    expect(beforeRefresh).toEqual({ ...before, revision: before.revision + editorChanges.length, updatedAt: beforeRefresh.updatedAt, changes: [...before.changes, ...editorChanges] })
    const panel = await openStorage(page)
    await Promise.all([page.waitForEvent('load'), panel.getByRole('button', { name: 'Refresh app', exact: true }).click()])
    await expectOfflineReady(panel)
    const icon = await readFile(join(process.cwd(), 'dist/icon.svg'), 'utf8')
    await page.evaluate(async () => {
      localStorage.setItem('synthetic-refresh-preference', 'keep')
      const base = await caches.open('crykit-shell-refresh-test-1')
      const pointer = await base.match('/journal/__crykit_app_cache__')
      const active = pointer ? await caches.open(await pointer.text()) : base
      await active.put('/journal/icon.svg', new Response('Stale cached icon'))
      await (await caches.open('unrelated-application')).put('/journal/index.html', new Response('Keep unrelated cache'))
    })
    expect(await page.evaluate(async () => (await fetch('./icon.svg')).text())).toBe('Stale cached icon')
    await Promise.all([page.waitForEvent('load'), panel.getByRole('button', { name: 'Refresh app', exact: true }).click()])
    await expectOfflineReady(panel)
    expect(await page.evaluate(async () => (await fetch('./icon.svg')).text())).toBe(icon)
    expect(await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('crykit-refresh-')))).toHaveLength(1)
    expect(await page.evaluate(() => localStorage.getItem('synthetic-refresh-preference'))).toBe('keep')
    expect(await page.evaluate(async () => (await (await caches.open('unrelated-application')).match('/journal/index.html'))?.text())).toBe('Keep unrelated cache')
    await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
    const files = page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })
    const option = files.locator('option').filter({ hasText: MOD_FILENAME })
    await files.selectOption((await option.getAttribute('value'))!)
    await page.getByRole('button', { name: 'Review export', exact: true }).click()
    expect(await downloadText(page, 'Download mod')).toBe(MOD_DRAFT)
    expect(await downloadText(page, 'Download original')).toBe(MOD_SOURCE)
    expect(await exportLocalData(page)).toEqual(beforeRefresh)
    await context.setOffline(true)
    await page.goto(`${installation.url}#/inventory`)
    await expect(page.getByText('Keep through app refresh', { exact: true })).toBeVisible()
  } finally { await installation.close() }
})

test('refresh discovers updates, keeps other tabs open, and recovers from failed downloads', async ({ page, context }) => {
  const installation = await startInstallation()
  try {
    await page.goto(`${installation.url}#/inventory`)
    await saveObservation(page)
    const panel = await openStorage(page)
    await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
    await expectOfflineReady(panel)
    const draft = await context.newPage()
    await draft.goto(`${installation.url}#/inventory`)
    await draft.getByRole('button', { name: 'Add item', exact: true }).click()
    const form = draft.getByRole('dialog', { name: 'Add inventory item' })
    await form.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
    await form.getByLabel('Item name').fill('Keep my open draft')
    const oldDocument = await draft.evaluate(() => performance.timeOrigin)
    await page.evaluate(async () => {
      await (await caches.open('crykit-shell-refresh-test-1')).put('/journal/icon.svg', new Response('Existing working cache'))
    })
    installation.fail('icon.svg')
    await panel.getByRole('button', { name: 'Refresh app', exact: true }).click()
    await expect(panel.getByText(/App files could not be refreshed/)).toBeVisible()
    await expectOfflineReady(panel)
    expect(await page.evaluate(async () => (await fetch('./icon.svg')).text())).toBe('Existing working cache')
    expect(await page.evaluate(() => caches.keys())).not.toEqual(expect.arrayContaining([expect.stringMatching(/^crykit-refresh-/)]))
    await context.setOffline(true)
    await page.reload()
    await expectOfflineReady(panel)
    await panel.getByRole('button', { name: 'Refresh app', exact: true }).click()
    await expect(panel.getByText(/Check your connection and try again/)).toBeVisible()
    await expectOfflineReady(panel)
    await context.setOffline(false)
    installation.fail()
    const resume = installation.pause('icon.svg')
    const reloaded = page.waitForEvent('load')
    try {
      await panel.getByRole('button', { name: 'Refresh app', exact: true }).click()
      await expect(panel.getByRole('button', { name: 'Refreshing app...', exact: true })).toBeDisabled()
      await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
      await expect(panel.getByText('Wait for the app refresh to finish before leaving this section.', { exact: true })).toBeVisible()
      await expect(panel).toBeVisible()
    } finally { resume() }
    await reloaded
    await expectOfflineReady(panel)
    const refreshedCaches = await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('crykit-refresh-')))
    expect(refreshedCaches).toHaveLength(1)
    installation.update()
    await Promise.all([page.waitForEvent('load'), panel.getByRole('button', { name: 'Refresh app', exact: true }).click()])
    await expectOfflineReady(panel)
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(['crykit-shell-refresh-test-1', 'crykit-shell-refresh-test-2']))
    expect(await page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(refreshedCaches))
    await expect(form.getByLabel('Item name')).toHaveValue('Keep my open draft')
    expect(await draft.evaluate(() => performance.timeOrigin)).toBe(oldDocument)
    await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expect(page.getByText('Keep through app refresh', { exact: true })).toBeVisible()
    const thirdUpdate = await openStorage(page)
    installation.update()
    await Promise.all([page.waitForEvent('load'), thirdUpdate.getByRole('button', { name: 'Refresh app', exact: true }).click()])
    await expectOfflineReady(thirdUpdate)
    await expect.poll(() => page.evaluate(() => caches.keys())).not.toEqual(expect.arrayContaining(refreshedCaches))
    expect(await page.evaluate(() => caches.keys())).not.toContain('crykit-shell-refresh-test-1')
    await draft.close()
  } finally { await installation.close() }
})

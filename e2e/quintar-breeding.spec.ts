import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Page } from '@playwright/test'
import { QUINTAR_BREEDING_STEPS, QUINTAR_STEP } from '../src/catalog/quintar-breeding'
import type { LocalData } from '../src/domain/types'
import { createBlankPlaythrough, selectedPlaythrough } from './local-data-helpers'

const RAPID_TOGGLE_COUNT = 23

interface QuintarRenderProbe {
  readonly untouchedTile: HTMLElement
  readonly contextBar: HTMLElement
  readonly completionChanges: (string | null)[]
  readonly statusLabels: (string | null)[]
  readonly frames: { readonly complete: string | null; readonly status: string | null; readonly disabled: boolean }[]
  readonly untouchedMutations: MutationRecord[]
  readonly contextMutations: MutationRecord[]
  readonly observers: MutationObserver[]
  frameId: number
}

async function waitForSaves(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    return !window.dispatchEvent(event) || event.defaultPrevented
  }), { timeout: 30_000 }).toBe(false)
}

async function expectArtLoaded(page: Page, stepId: string) {
  const image = page.locator(`[data-step="${stepId}"] .quintar-tile__art img`)
  await image.scrollIntoViewIfNeeded()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
}

async function expectSummaryArtwork(page: Page, stepId: string) {
  const image = page.locator('.progress-summary__icon img')
  const tileImage = page.locator(`[data-step="${stepId}"] .quintar-tile__art img`)
  await expect(image).toHaveAttribute('src', (await tileImage.getAttribute('src'))!)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
}

async function readLocalData(page: Page): Promise<LocalData> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('crykit')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<LocalData>((resolve, reject) => {
        const request = database.transaction('localDatas').objectStore('localDatas').getAll()
        request.onsuccess = () => resolve(request.result[0].localData as LocalData)
        request.onerror = () => reject(request.error)
      })
    } finally { database.close() }
  })
}

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/progress')
  await expect(page.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Progress guides', exact: true }).getByRole('link', { name: 'Quintar breeding', exact: true }).click()
  await expect(page).toHaveURL(/#\/progress\/quintar$/)
  await createBlankPlaythrough(page)
})

test('step tiles toggle with mouse and keyboard, persist, and keep other records independent', async ({ page }) => {
  const before = await readLocalData(page)
  const tiles = page.locator('.quintar-tile')
  await expect(tiles).toHaveCount(QUINTAR_BREEDING_STEPS.length)
  await expect(tiles.locator('button[aria-pressed="true"]')).toHaveCount(0)
  await expectSummaryArtwork(page, QUINTAR_STEP.babel)
  const golden = tiles.filter({ has: page.getByRole('button', { name: /Hatch Golden Quintar/ }) })
  const button = golden.getByRole('button')
  const art = golden.locator('.quintar-tile__art')
  expect(await art.evaluate(element => getComputedStyle(element).opacity)).toBe('0.78')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toBeEnabled()
  await expect(tiles.locator('button[aria-pressed="true"]')).toHaveCount(1)
  expect(await art.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await expect(golden).toContainText('Prerequisites not marked:')
  await expect(page.locator('.quintar-summary__next')).toContainText('Obtain Babel Quintar')
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(button).toBeEnabled()
  await page.getByRole('button', { name: /Step 1: Obtain Babel Quintar/ }).click()
  await expect(page.getByRole('button', { name: /Step 1: Obtain Babel Quintar/ })).toBeEnabled()
  await waitForSaves(page)
  await page.reload()
  await expect(page.getByRole('button', { name: /Step 1: Obtain Babel Quintar/ })).toHaveAttribute('aria-pressed', 'true')
  await expectSummaryArtwork(page, QUINTAR_STEP.ocarina)
  await page.getByRole('button', { name: 'Go to next step', exact: true }).click()
  await expect(page.getByRole('button', { name: /Step 2: Buy Quintar Ocarina/ })).toBeFocused()
  const after = await readLocalData(page)
  for (const key of ['inventory', 'inventoryEvents', 'characters', 'progress', 'scenarios', 'goals'] as const) expect(selectedPlaythrough(after)[key]).toEqual(selectedPlaythrough(before)[key])
  expect(Object.keys(selectedPlaythrough(after).quintarBreeding!)).toEqual([QUINTAR_STEP.babel])
  const width = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth }))
  expect(width.body).toBeLessThanOrEqual(width.viewport)
  await page.getByRole('navigation', { name: 'Progress guides', exact: true }).getByRole('link', { name: 'Class seals', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Vanilla class mastery board', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Quintar breeding', exact: true })).toBeVisible()
})

test('step reference links open exact local details without marking progress', async ({ page }) => {
  const examples = [
    { step: QUINTAR_STEP.babel, name: 'Babel Quintar' },
    { step: QUINTAR_STEP.ocarina, name: 'Quintar Ocarina' },
    { step: QUINTAR_STEP.trustyBlue, name: 'Trusty Quintar (Blue)' },
    { step: QUINTAR_STEP.fancyRed, name: 'Breeding method', heading: 'Quintar Breeding' },
  ]
  for (const example of examples) {
    const tile = page.locator(`[data-step="${example.step}"]`)
    await tile.getByRole('link', { name: example.name, exact: true }).click()
    await expect(page.getByRole('heading', { name: example.heading ?? example.name, exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Quintar breeding', exact: true })).toBeVisible()
    await expect(tile.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
  }
})

test('rapid toggles hold the final requested state without flashing or changing unrelated tiles and controls', async ({ page }) => {
  const target = page.locator(`[data-step="${QUINTAR_STEP.babel}"]`)
  const queuedState = await page.evaluate(({ targetId, untouchedId, clicks }) => {
    const tile = document.querySelector<HTMLElement>(`[data-step="${targetId}"]`)!
    const button = tile.querySelector<HTMLButtonElement>('button')!
    const status = tile.querySelector<HTMLElement>('.quintar-tile__status')!
    const untouchedTile = document.querySelector<HTMLElement>(`[data-step="${untouchedId}"]`)!
    const contextBar = document.querySelector<HTMLElement>('.context-bar')!
    const probe: QuintarRenderProbe = { untouchedTile, contextBar, completionChanges: [], statusLabels: [], frames: [], untouchedMutations: [], contextMutations: [], observers: [], frameId: 0 }
    const completionObserver = new MutationObserver(records => probe.completionChanges.push(...records.map(record => record.oldValue)))
    const statusObserver = new MutationObserver(() => probe.statusLabels.push(status.textContent))
    const untouchedObserver = new MutationObserver(records => probe.untouchedMutations.push(...records))
    const contextObserver = new MutationObserver(records => probe.contextMutations.push(...records))
    completionObserver.observe(tile, { attributes: true, attributeFilter: ['data-complete'], attributeOldValue: true })
    statusObserver.observe(status, { childList: true, characterData: true, subtree: true })
    untouchedObserver.observe(untouchedTile, { attributes: true, childList: true, characterData: true, subtree: true })
    contextObserver.observe(contextBar, { attributes: true, childList: true, characterData: true, subtree: true })
    probe.observers.push(completionObserver, statusObserver, untouchedObserver, contextObserver)
    const sample = () => {
      probe.frames.push({ complete: tile.getAttribute('data-complete'), status: status.textContent, disabled: button.disabled })
      probe.frameId = requestAnimationFrame(sample)
    }
    ;(window as unknown as { quintarRenderProbe: QuintarRenderProbe }).quintarRenderProbe = probe
    for (let index = 0; index < clicks; index += 1) button.click()
    probe.frameId = requestAnimationFrame(sample)
    const event = new Event('beforeunload', { cancelable: true })
    return { protected: !window.dispatchEvent(event) || event.defaultPrevented, disabled: button.disabled }
  }, { targetId: QUINTAR_STEP.babel, untouchedId: QUINTAR_STEP.golden, clicks: RAPID_TOGGLE_COUNT })
  expect(queuedState).toEqual({ protected: true, disabled: false })
  await expect(target).toHaveAttribute('data-complete', 'true')
  await expect(target.getByRole('button')).toBeEnabled()
  await waitForSaves(page)
  await target.evaluate(tile => {
    const button = tile.querySelector<HTMLButtonElement>('button')!
    button.click()
    button.click()
  })
  await expect(target.getByRole('button')).toBeEnabled()
  await waitForSaves(page)
  await expect(target).not.toHaveAttribute('aria-busy', 'true')
  const observation = await page.evaluate((untouchedId) => {
    const probe = (window as unknown as { quintarRenderProbe: QuintarRenderProbe }).quintarRenderProbe
    cancelAnimationFrame(probe.frameId)
    probe.observers.forEach(observer => observer.disconnect())
    return {
      completionChanges: probe.completionChanges,
      statusLabels: probe.statusLabels,
      frames: probe.frames,
      sameTile: probe.untouchedTile === document.querySelector(`[data-step="${untouchedId}"]`),
      sameContext: probe.contextBar === document.querySelector('.context-bar'),
      untouchedMutations: probe.untouchedMutations.length,
      contextMutations: probe.contextMutations.length,
    }
  }, QUINTAR_STEP.golden)
  expect(observation.completionChanges).toEqual(['false'])
  expect(observation.statusLabels).toEqual(['Complete'])
  expect(observation.frames.length).toBeGreaterThan(0)
  expect(observation.frames.every(frame => frame.complete === 'true' && frame.status === 'Complete' && !frame.disabled)).toBe(true)
  expect(observation).toMatchObject({ sameTile: true, sameContext: true, untouchedMutations: 0, contextMutations: 0 })
  expect(Object.keys(selectedPlaythrough(await readLocalData(page)).quintarBreeding!)).toEqual([QUINTAR_STEP.babel])
  await page.reload()
  await expect(target).toHaveAttribute('data-complete', 'true')
})

test('a failed tile save rolls back and can be retried in place', async ({ page }) => {
  const before = await readLocalData(page)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      if (this.name === 'localDatas') {
        IDBObjectStore.prototype.put = original
        throw new DOMException('Synthetic quota failure', 'QuotaExceededError')
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
  })
  const button = page.getByRole('button', { name: /Step 1: Obtain Babel Quintar/ })
  await button.click()
  await expect(page.getByText('Step not saved', { exact: true })).toBeVisible()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  expect(await readLocalData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Retry step', exact: true }).click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Step not saved', { exact: true })).not.toBeVisible()
  await expect(button).toBeEnabled()
  await waitForSaves(page)
  await page.reload()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
})

test('the whole guide completes offline and keeps progress separate between playthroughs', async ({ page, context }) => {
  const originalId = selectedPlaythrough(await readLocalData(page)).id
  let panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Quintar breeding', exact: true })).toBeVisible()
  await expectArtLoaded(page, QUINTAR_STEP.babel)
  await expectArtLoaded(page, QUINTAR_STEP.ocarina)
  await expectArtLoaded(page, QUINTAR_STEP.trustyBlue)
  await expectArtLoaded(page, QUINTAR_STEP.fancyRed)
  await expectArtLoaded(page, QUINTAR_STEP.golden)
  for (const step of QUINTAR_BREEDING_STEPS) {
    await expectSummaryArtwork(page, step.id)
    const button = page.locator(`[data-step="${step.id}"]`).getByRole('button')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toBeEnabled()
  }
  await expect(page.locator('.quintar-summary__next')).toContainText('Guide complete')
  await expectSummaryArtwork(page, QUINTAR_STEP.golden)
  await expect(page.locator('.quintar-tile__missing')).toHaveCount(0)
  await waitForSaves(page)
  await page.reload()
  await expect(page.locator('.quintar-tile[data-complete="true"]')).toHaveCount(QUINTAR_BREEDING_STEPS.length)
  await createBlankPlaythrough(page)
  await expect(page.locator('.quintar-tile[data-complete="true"]')).toHaveCount(0)
  panel = await openData(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.getByRole('combobox', { name: 'Active Playthrough', exact: true }).selectOption(originalId)
  await expect(panel).not.toBeVisible()
  await page.getByRole('button', { name: 'Progress', exact: true }).filter({ visible: true }).click()
  await page.getByRole('navigation', { name: 'Progress guides', exact: true }).getByRole('link', { name: 'Quintar breeding', exact: true }).click()
  await expect(page.locator('.quintar-tile[data-complete="true"]')).toHaveCount(QUINTAR_BREEDING_STEPS.length)
  await page.locator(`[data-step="${QUINTAR_STEP.babel}"]`).getByRole('button').click()
  await expect(page.locator(`[data-step="${QUINTAR_STEP.babel}"]`).getByRole('button')).toBeEnabled()
  await expectSummaryArtwork(page, QUINTAR_STEP.babel)
  await expect(page.locator(`[data-step="${QUINTAR_STEP.golden}"]`)).toHaveAttribute('data-complete', 'true')
  await waitForSaves(page)
  await context.setOffline(false)
})

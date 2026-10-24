import { expect, type Locator, type Page } from '@playwright/test'

const ANIMATION_SAMPLE_FRAMES = 8
const TRANSFORM_SAMPLE_PRECISION = 1_000
const WORKSPACE_SELECTION_FIXTURE = Object.freeze({ database: 'crykit-workspace-selection-v1', nativeVersion: 10, store: 'selection', key: 'selected' })

export function loadingScreen(page: Page): Locator {
  return page.getByRole('main').filter({ has: page.getByRole('heading', { name: 'Opening Crystal Kit', exact: true }) })
}

export async function expectLoadingMotion(loading: Locator, reducedMotion: boolean): Promise<void> {
  const distinctTransforms = await loading.locator('.spinner').evaluate(async (spinner, { frames, precision }) => {
    const transforms = []
    for (let index = 0; index < frames; index++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const transform = getComputedStyle(spinner).transform
      const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform)
      // A completed full turn and no transform have the same visible orientation despite different CSS strings
      transforms.push([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map(value => Math.round(value * precision)).join(':'))
    }
    return new Set(transforms).size
  }, { frames: ANIMATION_SAMPLE_FRAMES, precision: TRANSFORM_SAMPLE_PRECISION })
  if (reducedMotion) expect(distinctTransforms).toBe(1)
  else expect(distinctTransforms).toBeGreaterThan(1)
}

export async function holdWorkspaceSelection(page: Page): Promise<() => Promise<void>> {
  const holder = await page.context().newPage()
  try {
    await holder.goto('/icon.svg')
    await holder.evaluate(async schema => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(schema.database, schema.nativeVersion)
        request.onupgradeneeded = () => { request.result.createObjectStore(schema.store, { keyPath: 'key' }) }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      // A native transaction in another tab blocks the actual selection read without replacing storage APIs
      const transaction = database.transaction(schema.store, 'readwrite')
      const store = transaction.objectStore(schema.store)
      let held = true
      const completed = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onabort = () => { database.close(); reject(transaction.error) }
      })
      const keepAlive = () => { const request = store.get(schema.key); request.onsuccess = () => { if (held) keepAlive() } }
      keepAlive()
      Object.assign(window, { releaseStartupStorage: () => { held = false; return completed } })
    }, WORKSPACE_SELECTION_FIXTURE)
    await page.bringToFront()
  } catch (error) { await holder.close(); throw error }
  let released: Promise<void> | undefined
  return () => released ??= (async () => {
    try { await holder.evaluate(() => (window as unknown as { releaseStartupStorage(): Promise<void> }).releaseStartupStorage()) }
    finally { await holder.close() }
  })()
}

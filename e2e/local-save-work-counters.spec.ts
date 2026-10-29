import { expect, test, type Page } from '@playwright/test'
import { installSaveWorkCounters } from './local-save-work-counters'

const SAVE_CEILING_MS = 1000
const AFTER_CEILING_MS = SAVE_CEILING_MS + 100

test('save diagnostics preserve native transaction completion and rollback without recording private identifiers', async ({ page }) => {
  await installSaveWorkCounters(page)
  await page.route('**/save-counter-proof', route => route.fulfill({ contentType: 'text/html', body: '<button>Save</button>' }))
  await page.goto('/save-counter-proof')
  await page.evaluate(() => window.armSaveWork('click', 'button'))
  await page.getByRole('button', { name: 'Save' }).click()
  const proof = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('private-diagnostic-database')
      request.onupgradeneeded = () => request.result.createObjectStore('records').createIndex('private-index', 'marker')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const observation = { current: true, pending: true, phase: 'staging', dirty: true, hydrating: false, acknowledged: false, editable: true, ready: false, visibility: document.visibilityState }
    window.recordSaveIdleObservation(observation)
    for (const abort of [false, true]) await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('records', 'readwrite')
      transaction.oncomplete = () => abort ? reject(new Error('Aborted write committed')) : resolve()
      transaction.onabort = () => abort ? resolve() : reject(transaction.error)
      const request = transaction.objectStore('records').put(abort ? 'private-aborted-value' : 'private-initial-value', 'private-record-key')
      if (!abort) request.onsuccess = () => transaction.objectStore('records').put('private-committed-value', 'private-record-key')
      if (abort) { transaction.objectStore('records').clear(); transaction.abort() }
    })
    window.recordSaveIdleObservation(observation)
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction('records'), store = transaction.objectStore('records')
      const request = store.get('private-record-key'), indexed = store.index('private-index').count()
      transaction.oncomplete = () => indexed.result === 0 ? resolve(request.result) : reject(new Error('Unexpected indexed record'))
      transaction.onabort = () => reject(transaction.error)
    })
    window.recordSaveIdleObservation({ ...observation, phase: 'idle', pending: false, dirty: false, acknowledged: true, ready: true })
    db.close()
    return { value, work: window.finishSaveWork() }
  })
  expect(proof.value).toBe('private-committed-value')
  expect(proof.work.transactions).toEqual({ readwrite: 2, readonly: 1 })
  expect(proof.work.transactionTimings.map(timing => timing.outcome)).toEqual(['complete', 'abort', 'complete'])
  expect(proof.work.transactionTimings.map(timing => timing.requestCount)).toEqual([2, 2, 2])
  expect(proof.work.transactionTimings.map(timing => timing.requestSuccessCount)).toEqual([2, 0, 2])
  for (const timing of proof.work.transactionTimings) {
    expect(timing.stores).toEqual(['records'])
    expect(timing.startedMs).toBeGreaterThanOrEqual(0)
    expect(timing.endedMs).toBeGreaterThanOrEqual(timing.startedMs)
    expect(timing.endedMs).toBeLessThanOrEqual(proof.work.elapsedMs)
    expect(timing.firstRequestMs).toBeGreaterThanOrEqual(timing.startedMs)
    if (timing.outcome === 'complete') {
      expect(timing.firstRequestSuccessMs).toBeGreaterThanOrEqual(timing.firstRequestMs!)
      expect(timing.lastRequestSuccessMs).toBeGreaterThanOrEqual(timing.firstRequestSuccessMs!)
      expect(timing.lastRequestSuccessMs).toBeLessThanOrEqual(timing.endedMs!)
    } else expect(timing.firstRequestSuccessMs).toBeUndefined()
  }
  expect(proof.work.idlePolling?.samples).toBe(3)
  expect(proof.work.idlePolling?.observations.map(observation => observation.ready)).toEqual([false, true])
  expect(JSON.stringify(proof.work)).not.toContain('private-')
})

test('save diagnostics attribute native long frames without retaining private script URLs', async ({ page }) => {
  const scriptWorkMs = 60
  await installSaveWorkCounters(page)
  await page.route('**/save-frame-proof', route => route.fulfill({ contentType: 'text/html', body: '<button>Save</button><script src="/__accounts-proof/assets/frame-proof.js?private-token"></script><script src="/private-script.js?private-token"></script>' }))
  const script = `document.querySelector('button').addEventListener('click', () => { const began = performance.now(); while (performance.now() - began < ${scriptWorkMs}) {} document.body.style.backgroundColor = 'white' })`
  await page.route('**/frame-proof.js?private-token', route => route.fulfill({ contentType: 'text/javascript', body: script }))
  await page.route('**/private-script.js?private-token', route => route.fulfill({ contentType: 'text/javascript', body: script }))
  await page.goto('/save-frame-proof')
  const supported = await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))
  await page.evaluate(() => window.armSaveWork('click', 'button'))
  await page.getByRole('button', { name: 'Save' }).click()
  if (supported) await expect.poll(() => page.evaluate(() => window.saveWork?.longAnimationFrames?.flatMap(frame => frame.scripts).some(script => script.sourceFile === 'frame-proof.js'))).toBe(true)
  const work = await page.evaluate(() => window.finishSaveWork())
  if (supported) {
    const scripts = work.longAnimationFrames!.flatMap(frame => frame.scripts)
    expect(scripts.some(script => script.sourceFile === 'frame-proof.js' && script.durationMs >= scriptWorkMs && script.sourceCharPosition! >= 0)).toBe(true)
    expect(scripts.some(script => script.sourceFile === undefined && script.durationMs >= scriptWorkMs)).toBe(true)
    for (const frame of work.longAnimationFrames!) {
      expect(frame.startedMs + frame.durationMs).toBeGreaterThan(0)
      expect(frame.durationMs).toBeGreaterThan(0)
      expect(frame.blockingMs).toBeGreaterThanOrEqual(0)
    }
  } else expect(work.longAnimationFrames).toBeUndefined()
  expect(JSON.stringify(work)).not.toContain('private-')
})

for (const fieldTag of ['textarea', 'input'] as const) test.describe(fieldTag, () => {
  test.beforeEach(async ({ page }) => {
    await installSaveWorkCounters(page)
    const field = fieldTag === 'textarea' ? '<textarea aria-label="Notes">saved</textarea>' : '<input aria-label="Notes" value="saved">'
    await page.route('**/save-counter-proof', route => route.fulfill({ contentType: 'text/html', body: `<button>Save</button>${field}` }))
    await page.goto('/save-counter-proof')
    await page.getByRole('textbox', { name: 'Notes' }).focus()
    await page.evaluate(({ budgetMs, selector }) => window.armSaveWork('click', 'button', { selector, value: 'saved ', budgetMs, enabledSelector: 'button' }), { budgetMs: SAVE_CEILING_MS, selector: fieldTag })
    await page.getByRole('button', { name: 'Save' }).click()
    await page.getByRole('textbox', { name: 'Notes' }).evaluate(element => {
      const field = element as HTMLTextAreaElement | HTMLInputElement
      field.focus()
      field.setSelectionRange(5, 5)
    })
  })

  test('save timing ends at trusted next input and paint before delayed result collection', async ({ page }) => {
    await page.evaluate(async selector => {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
      field.value = 'saved '
      field.dispatchEvent(new InputEvent('input', { bubbles: true }))
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (!window.saveWork) throw new Error('Synthetic input ended the save measurement')
      if (window.saveWork.nextInputReceivedMs !== undefined) throw new Error('Synthetic input was recorded as trusted input')
      field.value = 'saved'
      field.setSelectionRange(5, 5)
    }, fieldTag)
    await page.keyboard.press('Space')
    // Result transport can lag the completed user interaction without extending its browser clock
    await page.evaluate(delay => new Promise(resolve => setTimeout(resolve, delay)), AFTER_CEILING_MS)
    const receipt = await page.evaluate(() => window.finishNextInputWork())
    expect(receipt.nextInputReady).toBe(true)
    expect(receipt.elapsedMs).toBeLessThanOrEqual(SAVE_CEILING_MS)
    expect(receipt.nextInputReceivedMs).toBeGreaterThanOrEqual(0)
    expect(receipt.nextInputPaintMs).toBeGreaterThanOrEqual(receipt.nextInputReceivedMs!)
    expect(receipt.nextInputPaintMs).toBeLessThanOrEqual(receipt.elapsedMs)
  })

  test('next input after the save ceiling fails instead of reusing an earlier acknowledgement', async ({ page }) => {
    await page.evaluate(delay => new Promise(resolve => setTimeout(resolve, delay)), AFTER_CEILING_MS)
    await page.keyboard.press('Space')
    const receipt = await page.evaluate(() => window.finishNextInputWork())
    expect(receipt.nextInputReady).toBe(false)
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(SAVE_CEILING_MS)
    expect(receipt.nextInputReceivedMs).toBeUndefined()
    expect(receipt.nextInputPaintMs).toBeUndefined()
  })
  test('an unavailable next action cannot pass with otherwise ready input', async ({ page }) => {
    await page.getByRole('button', { name: 'Save' }).evaluate(button => { (button as HTMLButtonElement).disabled = true })
    await page.keyboard.press('Space')
    const receipt = await page.evaluate(() => window.finishNextInputWork())
    expect(receipt.nextInputReady).toBe(false)
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(SAVE_CEILING_MS)
    expect(receipt.nextInputReceivedMs).toBeGreaterThanOrEqual(0)
    expect(receipt.nextInputPaintMs).toBeGreaterThanOrEqual(receipt.nextInputReceivedMs!)
    expect(receipt.nextInputPaintMs).toBeLessThanOrEqual(receipt.elapsedMs)
  })
})

async function prepare(page: Page) {
  await installSaveWorkCounters(page)
  await page.goto('about:blank')
  await page.setContent('<textarea aria-label="Editor"></textarea><button>Apply</button>')
  await page.evaluate(() => window.armSaveWork('input', 'textarea'))
  await page.getByLabel('Editor').fill('saved')
}

async function acknowledge(page: Page) {
  await page.evaluate(() => { window.saveWork!.readyMs = performance.now() - window.saveWork!.started })
}

async function requestInput(page: Page) {
  await page.evaluate(budgetMs => {
    window.armEditorNextInputWork({ selector: 'textarea', value: 'saved ', key: ' ', enabledSelector: 'button', budgetMs })
  }, SAVE_CEILING_MS)
}

test('editor timing retains a real driver pause without charging it to application response', async ({ page }) => {
  await prepare(page)
  await acknowledge(page)
  // Deliberately delay the driver before it begins the next input request
  await new Promise(resolve => setTimeout(resolve, AFTER_CEILING_MS))
  await requestInput(page)
  await page.keyboard.press('Space')
  const work = await page.evaluate(() => window.finishEditorInputWork())
  expect(work.nextInputReady).toBe(true)
  expect(work.elapsedMs).toBeGreaterThanOrEqual(AFTER_CEILING_MS)
  expect(work.driverGapMs).toBeGreaterThanOrEqual(AFTER_CEILING_MS)
  expect(work.applicationElapsedMs).toBeLessThanOrEqual(SAVE_CEILING_MS)
  expect(work.applicationElapsedMs).toBeCloseTo(work.readyMs! + work.nextInputResponseMs!, 5)
  expect(work.elapsedMs).toBeCloseTo(work.applicationElapsedMs! + work.driverGapMs!, 5)
})

test('editor timing rejects readiness that exceeds the shared application budget', async ({ page }) => {
  await prepare(page)
  await new Promise(resolve => setTimeout(resolve, AFTER_CEILING_MS))
  await acknowledge(page)
  await requestInput(page)
  await page.keyboard.press('Space')
  const work = await page.evaluate(() => window.finishEditorInputWork())
  expect(work.applicationElapsedMs).toBeGreaterThan(SAVE_CEILING_MS)
  expect(work.nextInputReady).toBe(false)
})

test('editor timing includes application work during trusted keydown before input dispatch', async ({ page }) => {
  await prepare(page)
  await acknowledge(page)
  await requestInput(page)
  await page.evaluate(delay => {
    document.querySelector('textarea')!.addEventListener('keydown', () => {
      const began = performance.now()
      // A deliberately slow application handler must not be mistaken for driver idle time
      while (performance.now() - began < delay) { /* Hold the native event handler */ }
    }, { once: true })
  }, AFTER_CEILING_MS)
  await page.keyboard.press('Space')
  const work = await page.evaluate(() => window.finishEditorInputWork())
  expect(work.nextInputResponseMs).toBeGreaterThanOrEqual(AFTER_CEILING_MS)
  expect(work.applicationElapsedMs).toBeGreaterThan(SAVE_CEILING_MS)
  expect(work.nextInputReady).toBe(false)
})

test('editor timing rejects synthetic input without a trusted keypress', async ({ page }) => {
  await prepare(page)
  await acknowledge(page)
  await requestInput(page)
  await page.evaluate(() => {
    const field = document.querySelector('textarea')!
    field.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    field.value = 'saved '
    field.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  const work = await page.evaluate(() => window.finishEditorInputWork())
  expect(work.nextInputReady).toBe(false)
  expect(work.applicationElapsedMs).toBeDefined()
})

test('editor readiness and key response share one budget rather than receiving separate allowances', async ({ page }) => {
  const partialDelay = SAVE_CEILING_MS * 0.6
  await prepare(page)
  await new Promise(resolve => setTimeout(resolve, partialDelay))
  await acknowledge(page)
  await requestInput(page)
  await page.evaluate(delay => {
    document.querySelector('textarea')!.addEventListener('keydown', () => {
      const began = performance.now()
      while (performance.now() - began < delay) { /* Consume the remaining application budget */ }
    }, { once: true })
  }, partialDelay)
  await page.keyboard.press('Space')
  const work = await page.evaluate(() => window.finishEditorInputWork())
  expect(work.applicationElapsedMs).toBeGreaterThan(SAVE_CEILING_MS)
  expect(work.nextInputReady).toBe(false)
})

for (const failure of ['focus', 'Apply'] as const) test(`editor timing rejects unavailable ${failure} after trusted input`, async ({ page }) => {
  await prepare(page)
  await acknowledge(page)
  await requestInput(page)
  await page.evaluate(failure => {
    document.querySelector('textarea')!.addEventListener('input', () => {
      const button = document.querySelector('button')!
      if (failure === 'focus') button.focus()
      else button.disabled = true
    }, { once: true })
  }, failure)
  await page.keyboard.press('Space')
  const work = await page.evaluate(() => window.finishEditorInputWork())
  expect(work.nextInputReady).toBe(false)
})

test('editor timing includes a trusted key queued behind a busy application thread', async ({ page }) => {
  await prepare(page)
  await acknowledge(page)
  await requestInput(page)
  const blocking = page.evaluate(delay => {
    const began = performance.now()
    while (performance.now() - began < delay) { /* Queue native input behind application work */ }
    return { began, ended: performance.now() }
  }, SAVE_CEILING_MS * 1.5)
  // Send input while the evaluation is in flight; waiting for a browser binding would wait for its busy thread too
  await new Promise(resolve => setTimeout(resolve, 100))
  await page.keyboard.press('Space')
  const busy = await blocking
  const work = await page.evaluate(() => window.finishEditorInputWork())
  const responseStarted = work.started + work.readyMs! + work.driverGapMs!
  expect(responseStarted).toBeLessThanOrEqual(busy.began)
  expect(responseStarted + work.nextInputResponseMs!).toBeGreaterThanOrEqual(busy.ended)
  expect(work.nextInputResponseMs).toBeGreaterThan(SAVE_CEILING_MS)
  expect(work.nextInputReady).toBe(false)
})

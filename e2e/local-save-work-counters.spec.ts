import { expect, test, type Page } from '@playwright/test'
import { installSaveWorkCounters } from './local-save-work-counters'

const SAVE_CEILING_MS = 1000
const AFTER_CEILING_MS = SAVE_CEILING_MS + 100

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
      field.value = 'saved'
      field.setSelectionRange(5, 5)
    }, fieldTag)
    await page.keyboard.press('Space')
    // Result transport can lag the completed user interaction without extending its browser clock
    await page.evaluate(delay => new Promise(resolve => setTimeout(resolve, delay)), AFTER_CEILING_MS)
    const receipt = await page.evaluate(() => window.finishNextInputWork())
    expect(receipt.nextInputReady).toBe(true)
    expect(receipt.elapsedMs).toBeLessThanOrEqual(SAVE_CEILING_MS)
  })

  test('next input after the save ceiling fails instead of reusing an earlier acknowledgement', async ({ page }) => {
    await page.evaluate(delay => new Promise(resolve => setTimeout(resolve, delay)), AFTER_CEILING_MS)
    await page.keyboard.press('Space')
    const receipt = await page.evaluate(() => window.finishNextInputWork())
    expect(receipt.nextInputReady).toBe(false)
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(SAVE_CEILING_MS)
  })
  test('an unavailable next action cannot pass with otherwise ready input', async ({ page }) => {
    await page.getByRole('button', { name: 'Save' }).evaluate(button => { (button as HTMLButtonElement).disabled = true })
    await page.keyboard.press('Space')
    const receipt = await page.evaluate(() => window.finishNextInputWork())
    expect(receipt.nextInputReady).toBe(false)
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(SAVE_CEILING_MS)
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

import { expect, test } from '@playwright/test'
import { installSaveWorkCounters } from './local-save-work-counters'

const SAVE_CEILING_MS = 1000
const AFTER_CEILING_MS = SAVE_CEILING_MS + 100

test.beforeEach(async ({ page }) => {
  await installSaveWorkCounters(page)
  await page.route('**/save-counter-proof', route => route.fulfill({ contentType: 'text/html', body: '<button>Save</button><textarea aria-label="Notes">saved</textarea>' }))
  await page.goto('/save-counter-proof')
  await page.getByRole('textbox', { name: 'Notes' }).focus()
  await page.evaluate(budgetMs => window.armSaveWork('click', 'button', { selector: 'textarea', value: 'saved ', budgetMs }), SAVE_CEILING_MS)
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('textbox', { name: 'Notes' }).evaluate(element => {
    const field = element as HTMLTextAreaElement
    field.focus()
    field.setSelectionRange(5, 5)
  })
})

test('save timing ends at trusted next input and paint before delayed result collection', async ({ page }) => {
  await page.evaluate(async () => {
    const field = document.querySelector('textarea')!
    field.value = 'saved '
    field.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (!window.saveWork) throw new Error('Synthetic input ended the save measurement')
    field.value = 'saved'
    field.setSelectionRange(5, 5)
  })
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

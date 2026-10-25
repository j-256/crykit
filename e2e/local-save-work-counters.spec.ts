import { expect, test } from '@playwright/test'
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

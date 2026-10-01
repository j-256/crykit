import { expect, type Locator } from '@playwright/test'

export async function selectWithSeparateEvents(select: Locator, value: string) {
  // Let React flush input handlers before the native change event reads the value
  await select.evaluate((element, selected) => {
    const input = element as HTMLSelectElement
    input.value = selected
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
  await expect(select).toHaveValue(value)
  await select.dispatchEvent('change')
  await expect(select).toHaveValue(value)
}

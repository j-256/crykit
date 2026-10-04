import type { Page } from '@playwright/test'

export async function openBuildPickerFilters(page: Page) {
  const filters = page.getByRole('listbox').locator('details.build-picker-filters')
  if (await filters.getAttribute('open') === null) await filters.locator(':scope > summary').click()
}

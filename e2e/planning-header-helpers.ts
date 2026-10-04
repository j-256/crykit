import type { Page } from '@playwright/test'

export async function openBuildLibrary(page: Page) {
  const library = page.locator('.build-library')
  if (await library.count() && await library.getAttribute('open') === null) await library.locator(':scope > summary').click()
}

export async function openBuildComparison(page: Page) {
  await openBuildLibrary(page)
  await page.getByRole('button', { name: 'Compare revisions', exact: true }).click()
}

export async function openBuildActions(page: Page) {
  const more = page.getByRole('button', { name: 'More', exact: true })
  if (await more.count() && await more.getAttribute('aria-expanded') === 'false') await more.click()
}

export async function clickBuildAction(page: Page, name: string) {
  await openBuildActions(page)
  await page.getByRole('button', { name, exact: true }).click()
}

export async function closeBuildActions(page: Page) {
  const more = page.getByRole('button', { name: 'More', exact: true })
  if (await more.count() && await more.getAttribute('aria-expanded') === 'true') await more.press('Escape')
}

import type { Page } from '@playwright/test'

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

export async function openReferenceActions(page: Page) {
  const more = page.locator('.context-bar').getByRole('button', { name: 'More', exact: true })
  if (await more.count() && await more.getAttribute('aria-expanded') === 'false') await more.click()
}

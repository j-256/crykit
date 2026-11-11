import type { Page } from '@playwright/test'

export async function openShareSources(page: Page): Promise<void> {
  const sources = page.getByLabel('Game Setup and sources', { exact: true })
  if (await sources.getAttribute('open') === null) await sources.locator(':scope > summary').click()
}

export async function openCopiedCheckpointControls(page: Page): Promise<void> {
  const controls = page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: /^Edit your copy$/ }) })
  if (await controls.getAttribute('open') === null) await controls.locator(':scope > summary').click()
}

export async function openTeamHistory(page: Page): Promise<void> {
  const history = page.locator('.team-checkpoint-history')
  if (await history.getAttribute('open') === null) await history.locator(':scope > summary').click()
}

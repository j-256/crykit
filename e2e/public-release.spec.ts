import { expectOfflineReady } from './offline-helpers'
import { expect, test } from '@playwright/test'

test('credits and bundled licenses remain available offline without external requests', async ({ page, context, baseURL }) => {
  const externalRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(baseURL!).origin) externalRequests.push(request.url())
  })
  await page.goto('/#/settings/credits')
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(panel.getByRole('heading', { name: 'Game artwork and community reference' })).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Browse the source', exact: true })).toHaveAttribute('href', 'https://github.com/j-256/crystal-companion')
  const applicationLicense = await panel.getByRole('link', { name: 'AGPL-3.0-only', exact: true }).getAttribute('href')
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Credits & licenses', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expect(panel.getByRole('heading', { name: 'Your data stays in this browser' })).toBeVisible()
  const licenses = await page.evaluate(async (applicationLicense) => {
    const read = async (url: string) => (await fetch(url)).text()
    return Promise.all([read(applicationLicense!), read('./pixel-operator-CC0.txt'), read('./third-party-licenses.txt')])
  }, applicationLicense)
  expect(licenses[0]).toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
  expect(licenses[1]).toContain('CC0')
  expect(licenses[2]).toContain('Lucide')
  expect(externalRequests).toEqual([])
})

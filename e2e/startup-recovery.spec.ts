import { expect, test } from '@playwright/test'
import { readLocalData, waitForPlannerReady } from './local-data-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectOfflineReady } from './offline-helpers'

test('a transient dependency-module failure reopens the saved planner once', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds')
  await waitForPlannerReady(page)
  const saved = await readLocalData(page)
  let failed = false, navigations = 0
  page.on('request', request => { if (request.resourceType() === 'document') navigations += 1 })
  await page.route('**/assets/definitions-*.js', async route => {
    // A browser can retry a failed preload inside the same document
    // Fault that document's dependency until the bounded application retry opens a new one
    if (navigations === 1) { failed = true; await route.abort('failed') }
    else await route.continue()
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
  expect(failed).toBe(true)
  expect(navigations).toBe(2)
  expect(await readLocalData(page)).toEqual(saved)
})

test('a later module failure leaves the editing session and its unsaved input open', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds')
  await waitForPlannerReady(page)
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  const title = page.getByRole('textbox', { name: 'Build title', exact: true })
  await title.fill('Synthetic unsaved startup recovery draft')
  let navigations = 0
  page.on('request', request => { if (request.resourceType() === 'document') navigations += 1 })
  await page.route('**/synthetic-unavailable-module.js', route => route.abort('failed'))
  await page.evaluate(() => new Promise<void>(resolve => {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = '/synthetic-unavailable-module.js'
    // Observe later frames so an erroneously queued reload cannot hide behind the error callback
    script.onerror = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    document.body.append(script)
  }))
  await expect(title).toHaveValue('Synthetic unsaved startup recovery draft')
  expect(navigations).toBe(0)
})

test('persistent entry-module failure stops retrying and allows explicit recovery', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds')
  await waitForPlannerReady(page)
  const saved = await readLocalData(page)
  const entry = await page.locator('script[type="module"][src]').evaluate(script => (script as HTMLScriptElement).src)
  let navigations = 0
  page.on('request', request => { if (request.resourceType() === 'document') navigations += 1 })
  await page.route(entry, route => route.abort('failed'))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Application files could not be opened', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Your saved data has been kept.')
  expect(navigations).toBe(2)
  await page.unroute(entry)
  await page.getByRole('button', { name: 'Reload CryKit', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
  expect(await readLocalData(page)).toEqual(saved)
})

test('offline startup failure recovers from the retained app cache without clearing records', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  await page.goto('/#/settings/data')
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const saved = await readLocalData(page)
  // Retain the exact native cached response while injecting an unavailable module
  // Request interception cannot fault a response supplied by the real ServiceWorker
  const damaged = await page.evaluate(async () => {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!
    const backup = await caches.open('synthetic-startup-original')
    for (const name of await caches.keys()) {
      if (!name.startsWith('crykit-shell-')) continue
      const cache = await caches.open(name), original = await cache.match(script.src)
      if (!original) continue
      await backup.put(script.src, original)
      await cache.put(script.src, new Response('Synthetic unavailable module', { status: 503, headers: { 'content-type': 'text/javascript' } }))
      return { name, url: script.src }
    }
    throw new Error('The prepared entry module was not cached')
  })
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Application files could not be opened', exact: true })).toBeVisible()
  await page.evaluate(async ({ name, url }) => {
    const backup = await caches.open('synthetic-startup-original'), original = await backup.match(url)
    if (!original) throw new Error('The retained entry module is missing')
    await (await caches.open(name)).put(url, original)
    await caches.delete('synthetic-startup-original')
  }, damaged)
  await page.getByRole('button', { name: 'Reload CryKit', exact: true }).click()
  await waitForPlannerReady(page)
  expect(await readLocalData(page)).toEqual(saved)
})

import { expect, test } from '@playwright/test'
import { readLocalData } from './local-data-helpers'

const INITIAL_TITLE = 'Synthetic page return Build'
const RETURNED_TITLE = 'Synthetic page return Build edited'
const PRIVATE_NOTES = 'Synthetic unfinished notes retained across page return  '
const PAGE_RETURN_TIMEOUT_MS = 20_000

test('guest Build input remains editable and saves after a persisted page return', async ({ browser, baseURL }, testInfo) => {
  test.skip(browser.browserType().name() !== 'chromium', 'This regression requires an actual Chromium BFCache return')
  // The default Playwright argument disables BFCache, which would hide stale mounted-owner failures
  const process = await browser.browserType().launch({ ...testInfo.project.use.launchOptions, channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] })
  const context = await process.newContext({ baseURL })
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(PAGE_RETURN_TIMEOUT_MS)
    page.on('dialog', dialog => void dialog.accept())
    await page.addInitScript(() => {
      const state = { persisted: false, count: 0, originalTimeOrigin: performance.timeOrigin }
      Object.assign(window, { buildPageReturn: state })
      addEventListener('pageshow', event => { state.persisted = event.persisted; state.count++ })
    })
    await page.goto('/#/builds/library/new')
    const title = page.getByRole('textbox', { name: 'Build title', exact: true })
    await title.fill(INITIAL_TITLE)
    const classInput = page.getByRole('combobox', { name: 'Class', exact: true }).filter({ visible: true })
    await classInput.fill('Wizard')
    await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ hasText: 'PC 1.6.9.0' }).filter({ has: page.locator('strong', { hasText: /^Wizard$/ }) }).click()
    await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
    const notes = page.getByRole('textbox', { name: 'Rotation or use notes', exact: true })
    await notes.fill(PRIVATE_NOTES)
    const originalTimeOrigin = await page.evaluate(() => performance.timeOrigin)
    await page.goto('/icon.svg')
    // A persisted document does not emit a fresh load event
    await page.goBack({ waitUntil: 'commit' })
    await expect.poll(() => page.evaluate(() => (window as unknown as { buildPageReturn?: { count: number } }).buildPageReturn?.count), { timeout: PAGE_RETURN_TIMEOUT_MS }).toBe(2)
    const returned = await page.evaluate(() => ({ ...(window as unknown as { buildPageReturn: { persisted: boolean; count: number; originalTimeOrigin: number } }).buildPageReturn, timeOrigin: performance.timeOrigin }))
    await testInfo.attach('guest-build-page-return', { body: JSON.stringify(returned), contentType: 'application/json' })
    expect(returned.persisted).toBe(true)
    expect(returned.timeOrigin).toBe(originalTimeOrigin)
    await expect(title).toHaveValue(INITIAL_TITLE)
    await expect(notes).toHaveValue(PRIVATE_NOTES)
    await title.fill(RETURNED_TITLE)
    await notes.fill(`${PRIVATE_NOTES}edited`)
    await expect(title).toHaveValue(RETURNED_TITLE)
    await page.getByRole('button', { name: 'Save build', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
    const saved = await readLocalData(page)
    const build = Object.values(saved.builds).find(entry => entry.title === RETURNED_TITLE)
    expect(build).toBeDefined()
    const revision = saved.buildRevisions[build!.latestRevisionId!]
    expect(revision!.content.rotationNotes).toBe(`${PRIVATE_NOTES}edited`)
    expect(revision!.content.primaryClass?.kind).toBe('catalog')
  } finally {
    await context.close()
    await process.close()
  }
})

test('guest Builds remain functional after visiting Account without signing in', async ({ page }) => {
  page.setDefaultTimeout(PAGE_RETURN_TIMEOUT_MS)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Builds', exact: true }).first().click()
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  const title = page.getByRole('textbox', { name: 'Build title', exact: true })
  const savedTitle = 'Synthetic Build after idle Account visit'
  await title.fill(savedTitle)
  await expect(title).toHaveValue(savedTitle)
  await expect(page.getByRole('region', { name: 'Build import recovery', exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Class', exact: true }).filter({ visible: true }).fill('Wizard')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ hasText: 'PC 1.6.9.0' }).filter({ has: page.locator('strong', { hasText: /^Wizard$/ }) }).click()
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  const saved = await readLocalData(page)
  expect(Object.values(saved.builds).some(build => build.title === savedTitle)).toBe(true)
})

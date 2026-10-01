import { expect, test, type Page } from '@playwright/test'
import { createSharePayload, createShareUrl, MAX_SHARE_URL_LENGTH } from '../src/interchange/share'
import { asId } from '../src/domain/core'
import type { CatalogRevisionId, LocalData } from '../src/domain/types'
import { selectedPlaythrough } from './local-data-helpers'

async function storedData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction('localDatas', 'readonly').objectStore('localDatas').getAll()
      read.onerror = () => { database.close(); reject(read.error) }
      read.onsuccess = () => { database.close(); resolve(read.result[0].localData) }
    }
  }))
}

test('shares a saved build, supports manual copying, previews without writes and adds a copy', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const original = await storedData(page)
  const build = Object.values(original.builds)[0]!
  const libraryUrl = page.url()
  const card = page.locator('.build-card').filter({ has: page.getByRole('button', { name: build.title, exact: true }) })
  await expect(card.getByRole('button', { name: 'Share build', exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Share build', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Share build', exact: true })
  await dialog.getByText('Anyone with this link can view the saved snapshot. Further edits need a new link.', { exact: true }).click()
  await expect(page).toHaveURL(libraryUrl)
  const url = await dialog.getByLabel('Share URL', { exact: true }).inputValue()
  expect(url.length).toBeLessThan(MAX_SHARE_URL_LENGTH / 16)
  await expect(dialog.getByRole('checkbox', { name: 'Include written notes' })).not.toBeChecked()
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Synthetic denied clipboard')) } }) })
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click()
  await expect(dialog.getByText('Copy the selected link', { exact: true })).toBeVisible()
  expect(await dialog.getByLabel('Share URL', { exact: true }).evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBe(url.length)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.goto(url)
  await expect(page.getByRole('heading', { name: build.title, exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Shared build loadout' })).toBeVisible()
  expect(await storedData(page)).toEqual(original)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/library\//)
  const saved = await storedData(page)
  expect(Object.keys(saved.builds)).toHaveLength(Object.keys(original.builds).length + 1)
  expect(saved.playthroughs).toEqual(original.playthroughs)
  expect(saved.builds[build.id]).toEqual(build)
  expect(saved.gameSetups).toEqual(original.gameSetups)
  const added = Object.values(saved.builds).find(candidate => !original.builds[candidate.id])!
  const copiedRevision = saved.buildRevisions[added.latestRevisionId!]!
  expect(copiedRevision.gameSetupRevisionId).toBe(selectedPlaythrough(original).currentGameSetupRevisionId)
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Fork to current Game Setup', exact: true })).toHaveCount(0)
  const copiedUrl = page.url()
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page).not.toHaveURL(copiedUrl)
  const edited = await storedData(page)
  expect(edited.builds[added.id]!.latestRevisionId).not.toBe(copiedRevision.id)
  expect(edited.gameSetups).toEqual(original.gameSetups)
  await expect(page.getByRole('button', { name: 'Share build', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('opens four portable team slots in a fresh browser and maps them to local characters', async ({ page, browser, baseURL, isMobile }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const source = await storedData(page)
  const sourceTeam = Object.values(selectedPlaythrough(source).scenarios)[0]!
  await page.goto(`/#/builds/teams/${sourceTeam.id}`)
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  const url = await page.getByRole('dialog', { name: 'Share team', exact: true }).getByLabel('Share URL').inputValue()
  expect(url.length).toBeLessThan(MAX_SHARE_URL_LENGTH / 16)
  const recipientContext = await browser.newContext({ viewport: page.viewportSize()!, isMobile })
  const recipient = await recipientContext.newPage()
  try {
    await recipient.goto(url)
    await expect(recipient.getByRole('heading', { name: sourceTeam.label, exact: true })).toBeVisible()
    const before = await storedData(recipient)
    const members = Object.values(selectedPlaythrough(before).characters)
    expect(members.map(character => character.id)).not.toEqual(sourceTeam.memberIds)
    const regions = recipient.getByRole('region', { name: /^Shared team slot \d$/ })
    await expect(regions).toHaveCount(4)
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const savePanel = recipient.getByRole('region', { name: 'Save shared team' })
    await expect(savePanel.getByRole('button', { name: 'Save a copy' })).toBeDisabled()
    for (let index = 0; index < members.length; index += 1) await savePanel.getByLabel(`Team slot ${index + 1}`, { exact: true }).selectOption(members[index]!.id)
    await savePanel.getByRole('button', { name: 'Save a copy' }).click()
    await expect(recipient).toHaveURL(/#\/builds\/teams\//)
    const after = await storedData(recipient)
    expect(Object.keys(after.builds)).toHaveLength(Object.keys(before.builds).length + 4)
    expect(selectedPlaythrough(after).characters).toEqual(selectedPlaythrough(before).characters)
    expect(selectedPlaythrough(after).inventory).toEqual(selectedPlaythrough(before).inventory)
    expect(after.gameSetups).toEqual(before.gameSetups)
    const added = Object.values(selectedPlaythrough(after).scenarios).find(scenario => !selectedPlaythrough(before).scenarios[scenario.id])!
    expect(added.memberIds).toEqual(members.map(character => character.id))
    expect(added.kind).toBe('draft')
    expect(added.gameSetupRevisionId).toBe(selectedPlaythrough(before).currentGameSetupRevisionId)
    const active = before.gameSetups[added.gameSetupRevisionId]!
    for (const build of Object.values(after.builds).filter(build => !before.builds[build.id])) expect(build.gameSetupId).toBe(active.gameSetupId)
    await recipient.goto(`${baseURL}/#/builds/teams`)
    await expect(recipient.getByRole('heading', { name: sourceTeam.label, exact: true })).toHaveCount(2)
  } finally { await recipientContext.close() }
})

test('survives a link near the URL budget on navigation and reload without leaking the fragment to HTTP', async ({ page, baseURL }) => {
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const original = await storedData(page)
  const revision = Object.values(original.buildRevisions)[0]!
  const payload = createSharePayload(original, { kind: 'build', revisionId: revision.id }, true)
  let state = 7654321
  const text = Array.from({ length: 56_000 }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return String.fromCharCode(32 + Math.floor(state / 2 ** 32 * 95)) }).join('')
  const longPayload = { ...payload, records: { ...payload.records, buildRevisions: { [revision.id]: { ...payload.records.buildRevisions[revision.id]!, content: { ...revision.content, rotationNotes: text } } } } }
  const url = createShareUrl(longPayload, `${baseURL}/`)
  console.info(`Near-budget share URL: ${url.length} characters`)
  expect(url.length).toBeGreaterThan(MAX_SHARE_URL_LENGTH * .9)
  expect(url.length).toBeLessThan(MAX_SHARE_URL_LENGTH)
  await page.goto(url)
  await expect(page.getByRole('region', { name: 'Shared build loadout' })).toBeVisible()
  expect(await page.evaluate(() => location.href.length)).toBe(url.length)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Shared build loadout' })).toBeVisible()
  await page.locator('.shared-preview summary').filter({ hasText: 'Build notes and assumptions' }).click()
  await expect(page.locator('.share-notes')).toContainText(text)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await storedData(page)).toEqual(original)
  expect(requests.every(url => !url.includes('#') && !url.includes('/share/'))).toBe(true)
  expect(errors).toEqual([])
})

test('a failed copy rolls back, remains previewable and retries without duplicates', async ({ page, baseURL }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const original = await storedData(page)
  const revision = Object.values(original.buildRevisions)[0]!
  const payload = createSharePayload(original, { kind: 'build', revisionId: revision.id })
  const setup = payload.records.gameSetups[revision.gameSetupRevisionId]!
  const changed = { ...payload, records: { ...payload.records, gameSetups: { ...payload.records.gameSetups, [setup.id]: { ...setup, ppLimit: { state: 'known' as const, value: 11 } } } } }
  const url = createShareUrl(changed, `${baseURL}/`)
  await page.goto(url)
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    let failOnce = true
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
      if (this.name === 'localDatas' && failOnce) { failOnce = false; throw new DOMException('Synthetic share save failure', 'QuotaExceededError') }
      return originalPut.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Copy not saved', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(original)
  await expect(page.getByRole('region', { name: 'Shared build loadout' })).toBeVisible()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/library\//)
  const saved = await storedData(page)
  expect(Object.keys(saved.builds)).toHaveLength(Object.keys(original.builds).length + 1)
  expect(Object.keys(saved.gameSetups)).toHaveLength(Object.keys(original.gameSetups).length + 1)
  const addedSetup = Object.values(saved.gameSetups).find(candidate => !original.gameSetups[candidate.id])!
  expect(addedSetup.label).toBe(`${setup.label} (shared)`)
  expect(addedSetup.ppLimit).toEqual({ state: 'known', value: 11 })
  expect(saved.playthroughs).toEqual(original.playthroughs)
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Fork to current Game Setup', exact: true })).toHaveCount(0)
  await page.goto(url)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/library\//)
  const repeated = await storedData(page)
  expect(repeated.gameSetups).toEqual(saved.gameSetups)
  expect(Object.keys(repeated.builds)).toHaveLength(Object.keys(saved.builds).length + 1)
})

test('rejects invalid snapshots and unavailable catalog pins without writing', async ({ page, baseURL }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const original = await storedData(page)
  await page.goto('/#/share/v1/AAA')
  await expect(page.getByRole('heading', { name: 'Shared snapshot unavailable' })).toBeVisible()
  expect(await storedData(page)).toEqual(original)
  const revision = Object.values(original.buildRevisions)[0]!
  const payload = createSharePayload(original, { kind: 'build', revisionId: revision.id })
  const setup = payload.records.gameSetups[revision.gameSetupRevisionId]!
  const unavailable = { ...payload, records: { ...payload.records, gameSetups: { ...payload.records.gameSetups, [setup.id]: { ...setup, catalogLock: { missing: asId<CatalogRevisionId>('unavailable') } } } } }
  await page.goto(createShareUrl(unavailable, `${baseURL}/`))
  await expect(page.getByRole('heading', { name: 'Shared snapshot unavailable' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toHaveCount(0)
  expect(await storedData(page)).toEqual(original)
})

import { expect, test, type Page } from '@playwright/test'
import { SUGGESTED_BUILD_SLOTS } from '../src/domain/build-planning'
import type { LocalData } from '../src/domain/types'
import { createSharePayload, createShareUrl } from '../src/interchange/share'
import { expectOfflineReady } from './offline-helpers'

async function storedData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crystal-companion-v2')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction('localDatas', 'readonly').objectStore('localDatas').getAll()
      read.onerror = () => { database.close(); reject(read.error) }
      read.onsuccess = () => { database.close(); resolve(read.result[0].localData) }
    }
  }))
}

async function openBuild(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const original = await storedData(page)
  const build = Object.values(original.builds)[0]!
  await page.goto(`/#/builds/library/${build.id}`)
  await page.locator('.build-behavior > summary').click()
  return { original, build, before: original.buildRevisions[build.latestRevisionId!]! }
}

test('owns discrete known and custom mod choices and version while keeping earlier checkpoints and the Playthrough', async ({ page, context, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/#/settings/storage')
  const storage = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await storage.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(storage)
  await storage.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const { original, build, before } = await openBuild(page)
  await page.locator('.game-setup-mod-pack > summary').nth(1).click()
  await page.getByRole('combobox', { name: 'Doge Shield', exact: true }).selectOption('enabled')
  await page.getByLabel('Custom mod name', { exact: true }).fill('Synthetic behavior mod')
  await page.getByRole('button', { name: 'Add mod', exact: true }).click()
  const custom = page.getByRole('combobox', { name: 'Synthetic behavior mod', exact: true })
  await expect(custom).toHaveValue('enabled')
  await page.getByLabel('Custom mod name', { exact: true }).fill('synthetic BEHAVIOR mod')
  await page.getByRole('button', { name: 'Add mod', exact: true }).click()
  await expect(custom).toHaveCount(1)
  await custom.selectOption('unknown')
  await page.getByRole('button', { name: 'Enter exact version', exact: true }).click()
  await page.getByLabel('Exact build game version', { exact: true }).fill('synthetic-1.0')
  await page.getByLabel('Build passive PP limit', { exact: true }).fill('12')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  const saved = await storedData(page)
  const checkpoint = saved.buildRevisions[saved.builds[build.id]!.latestRevisionId!]!
  const behavior = saved.gameSetups[checkpoint.gameSetupRevisionId]!
  expect(behavior.gameVersion).toEqual({ state: 'known', value: 'synthetic-1.0' })
  expect(behavior.customMods).toEqual(['Synthetic behavior mod'])
  expect(behavior.mods.state === 'known' && behavior.mods.value).toContain('Doge Shield')
  expect(saved.buildRevisions[before.id]).toEqual(before)
  expect(saved.gameSetups[before.gameSetupRevisionId]).toEqual(original.gameSetups[before.gameSetupRevisionId])
  expect(saved.playthroughs).toEqual(original.playthroughs)
  await page.reload()
  await page.locator('.build-behavior > summary').click()
  await expect(custom).toHaveValue('unknown')
  await expect(page.getByRole('combobox', { name: 'Build game version' })).toHaveValue('synthetic-1.0')
  await context.setOffline(false)
  const url = createShareUrl(createSharePayload(saved, { kind: 'build', revisionId: checkpoint.id }), `${baseURL}/`)
  await page.goto(url)
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeEnabled()
  await page.locator('.build-behavior > summary').click()
  await expect(custom).toHaveValue('unknown')
  expect((await storedData(page)).gameSetups).toEqual(saved.gameSetups)
  expect(errors).toEqual([])
})

test('retains behavior and loadout after a failed save, and an older checkpoint restores its own rules', async ({ page, baseURL }) => {
  const { original, build, before } = await openBuild(page)
  await page.getByLabel('Build passive PP limit', { exact: true }).fill('1')
  await expect(page.getByRole('region', { name: 'Build validity', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    let failOnce = true
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'localDatas' && failOnce) { failOnce = false; throw new DOMException('Synthetic behavior save failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Revision not saved', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(original)
  await expect(page.getByLabel('Build passive PP limit', { exact: true })).toHaveValue('1')
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0)
  const recovered = await storedData(page)
  expect(recovered.buildRevisions[before.id]).toEqual(before)
  const latest = recovered.buildRevisions[recovered.builds[build.id]!.latestRevisionId!]!
  expect(recovered.gameSetups[latest.gameSetupRevisionId]!.ppLimit).toEqual({ state: 'known', value: 1 })
  expect(Object.keys(recovered.gameSetups)).toHaveLength(Object.keys(original.gameSetups).length + 1)
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
  await page.goto(`${baseURL}/#/builds/library/${build.id}/revisions/${before.id}/edit`)
  await page.locator('.build-behavior > summary').click()
  const originalLimit = original.gameSetups[before.gameSetupRevisionId]!.ppLimit
  await expect(page.getByLabel('Build passive PP limit', { exact: true })).toHaveValue(originalLimit?.state === 'known' ? String(originalLimit.value) : '')
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  const restored = await storedData(page)
  expect(restored.buildRevisions[restored.builds[build.id]!.latestRevisionId!]!.gameSetupRevisionId).toBe(before.gameSetupRevisionId)
  expect(restored.playthroughs).toEqual(original.playthroughs)
})

test('opens an existing version 1 share link', async ({ page, baseURL }) => {
  const { original, before } = await openBuild(page)
  const payload = { ...createSharePayload(original, { kind: 'build', revisionId: before.id }), version: 1 as const }
  const url = createShareUrl(payload, `${baseURL}/`).replace('/share/v2/', '/share/v1/')
  await page.goto(url)
  await expect(page.getByRole('region', { name: 'Shared build loadout' })).toBeVisible()
  expect(await storedData(page)).toEqual(original)
})

test('a preset without a configured layout keeps suggested slots usable and preserves equipped selections', async ({ page, baseURL }) => {
  const { original, build, before } = await openBuild(page)
  const payload = createSharePayload(original, { kind: 'build', revisionId: before.id })
  const setup = payload.records.gameSetups[before.gameSetupRevisionId]!
  const emptyPreset = { ...payload, records: { ...payload.records, gameSetups: { ...payload.records.gameSetups, [setup.id]: { ...setup, label: 'Synthetic empty-layout preset', slots: [] } }, buildRevisions: { ...payload.records.buildRevisions, [before.id]: { ...payload.records.buildRevisions[before.id]!, content: { ...before.content, equipment: {} } } } } }
  await page.goto(createShareUrl(emptyPreset, `${baseURL}/`))
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeEnabled()
  await page.goto(`${baseURL}/#/builds/library/${build.id}`)
  await page.locator('.build-behavior > summary').click()
  await page.getByRole('combobox', { name: 'Behavior preset', exact: true }).selectOption({ label: 'Synthetic empty-layout preset · r1' })
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Short Sword')
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  const saved = await storedData(page)
  const revision = saved.buildRevisions[saved.builds[build.id]!.latestRevisionId!]!
  expect(saved.gameSetups[revision.gameSetupRevisionId]!.slots).toEqual(SUGGESTED_BUILD_SLOTS)
  expect(revision.content.equipment).toEqual(before.content.equipment)
  expect(saved.buildRevisions[before.id]).toEqual(before)
  expect(saved.playthroughs).toEqual(original.playthroughs)
})

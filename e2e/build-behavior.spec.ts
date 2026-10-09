import { skipInitialModSetup, openGameSetupSection } from './local-data-helpers'
import { expect, test, type Page } from '@playwright/test'
import { SUGGESTED_BUILD_SLOTS } from '../src/domain/build-planning'
import type { CatalogRevisionId, EntityId, LocalData } from '../src/domain/types'
import { createSharePayload, createShareUrl } from '../src/interchange/share'
import { expectOfflineReady } from './offline-helpers'
import { CURRENT_CATALOG } from '../src/catalog/bundled'
import { HISTORICAL_BUNDLED_CATALOG } from '../src/domain/withdrawn-catalogs'

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

async function openBuild(page: Page) {
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const original = await storedData(page)
  const build = Object.values(original.builds)[0]!
  await page.goto(`/#/builds/library/${build.id}`)
  await page.locator('.build-behavior > summary').click()
  await openGameSetupSection(page.locator('.build-behavior'), 'Mods')
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
  await page.getByLabel('Exact game version', { exact: true }).fill('synthetic-1.0')
  await page.getByRole('combobox', { name: 'Difficulty', exact: true }).selectOption('2')
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
  await openGameSetupSection(page.locator('.build-behavior'), 'Mods')
  await expect(custom).toHaveValue('unknown')
  await expect(page.getByRole('combobox', { name: 'Game version' })).toHaveValue('synthetic-1.0')
  await context.setOffline(false)
  const url = createShareUrl(createSharePayload(saved, { kind: 'build', revisionId: checkpoint.id }), `${baseURL}/`)
  await page.goto(url)
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeEnabled()
  await page.locator('.build-behavior > summary').click()
  await openGameSetupSection(page.locator('.build-behavior'), 'Mods')
  await expect(custom).toHaveValue('unknown')
  expect((await storedData(page)).gameSetups).toEqual(saved.gameSetups)
  expect(errors).toEqual([])
})

test('retains behavior and loadout after a failed save, and an older checkpoint restores its own rules', async ({ page, baseURL }) => {
  const { original, build, before } = await openBuild(page)
  await page.getByRole('combobox', { name: 'Difficulty', exact: true }).selectOption('1')
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
  await expect(page.getByRole('combobox', { name: 'Difficulty', exact: true })).toHaveValue('1')
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0)
  const recovered = await storedData(page)
  expect(recovered.buildRevisions[before.id]).toEqual(before)
  const latest = recovered.buildRevisions[recovered.builds[build.id]!.latestRevisionId!]!
  expect(recovered.gameSetups[latest.gameSetupRevisionId]!.difficulty).toEqual({ version: 1, selection: { state: 'known', value: 1 } })
  expect(Object.keys(recovered.gameSetups)).toHaveLength(Object.keys(original.gameSetups).length + 1)
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
  await page.goto(`${baseURL}/#/builds/library/${build.id}/revisions/${before.id}/edit`)
  await page.locator('.build-behavior > summary').click()
  await openGameSetupSection(page.locator('.build-behavior'), 'Mods')
  const originalLimit = original.gameSetups[before.gameSetupRevisionId]!.difficulty?.selection
  await expect(page.getByRole('combobox', { name: 'Difficulty', exact: true })).toHaveValue(originalLimit?.state === 'known' ? String(originalLimit.value) : '')
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  const restored = await storedData(page)
  expect(restored.buildRevisions[restored.builds[build.id]!.latestRevisionId!]!.gameSetupRevisionId).toBe(before.gameSetupRevisionId)
  expect(restored.playthroughs).toEqual(original.playthroughs)
})

test('opens an existing version 1 share link', async ({ page, baseURL }) => {
  const { original, before } = await openBuild(page)
  const payload = { ...createSharePayload(original, { kind: 'build', revisionId: before.id }), version: 1 as const }
  const url = createShareUrl(payload, `${baseURL}/`).replace(/\/share\/v[0-9]+\//, '/share/v1/')
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
  await openGameSetupSection(page.locator('.build-behavior'), 'Mods')
  await page.getByRole('combobox', { name: 'Copy Game Setup', exact: true }).selectOption({ label: 'Synthetic empty-layout preset · r1' })
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

test('unavailable mod layers retain unchanged native loadout definitions @mobile', async ({ page, baseURL }) => {
  const { original } = await openBuild(page)
  const build = Object.values(original.builds).find(build => {
    const revision = original.buildRevisions[build.latestRevisionId!]
    return revision?.content.passives.some(selection => selection.ref.kind === 'catalog' && selection.ref.entityId === 'base:passive:20') && Object.values(revision.content.equipment).some(selection => selection?.ref.kind === 'catalog' && selection.ref.entityId === 'base:equipment:41')
  })!
  const before = original.buildRevisions[build.latestRevisionId!]!
  const payload = createSharePayload(original, { kind: 'build', revisionId: before.id })
  const setup = payload.records.gameSetups[before.gameSetupRevisionId]!
  // Force a missing source revision even if a future library contains this project's definitions
  const checksum = `sha256:${'0'.repeat(64)}`
  const sourceRevision = `${checksum}:rules-v2:library-v2` as CatalogRevisionId
  const unavailableSetup = { ...setup, modComposition: { ...setup.modComposition!, layers: setup.modComposition!.layers.map(layer => ({ ...layer, catalogRevisionId: sourceRevision })) }, modSourceReceipts: setup.modSourceReceipts!.map(({ contentFingerprint: _fingerprint, ...receipt }) => ({ ...receipt, checksum, catalogRevisionId: sourceRevision })) }
  const unavailable = { ...payload, records: { ...payload.records, gameSetups: { ...payload.records.gameSetups, [setup.id]: unavailableSetup } } }
  await page.goto(createShareUrl(unavailable, `${baseURL}/`))
  const validity = page.getByRole('region', { name: 'Build validity', exact: true })
  const expectNativeSelections = async () => {
    for (const label of ['Main hand', 'Head', 'Equipped passive 1', 'Equipped passive 3']) await expect(validity.getByText(`${label}: definition is unavailable`, { exact: false })).toHaveCount(0)
    await expect(validity.getByText('Equipped passive 2: definition is unavailable', { exact: false })).toHaveCount(1)
  }
  await expect(validity).toBeVisible()
  await expectNativeSelections()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await expectNativeSelections()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Eclipse')
  await expect(page.getByRole('combobox', { name: 'Equipped passive 1', exact: true })).toHaveValue('Pocket Sand')
  await expect(page.getByRole('combobox', { name: 'Equipped passive 3', exact: true })).toHaveValue('Perfect Vision')
  expect((await storedData(page)).buildRevisions[before.id]).toEqual(before)
})

test('validity review targets unavailable passives without changing the saved checkpoint @mobile', async ({ page, baseURL }) => {
  const { original, before } = await openBuild(page)
  const payload = createSharePayload(original, { kind: 'build', revisionId: before.id })
  const revision = payload.records.buildRevisions[before.id]!
  const passives = Array.from({ length: 3 }, (_, index) => ({ ref: { ...revision.content.primaryClass!, entityId: `synthetic:unavailable-passive:${index}` as EntityId }, observedName: `Synthetic unavailable passive ${index + 1}` }))
  const synthetic = { ...payload, records: { ...payload.records, buildRevisions: { ...payload.records.buildRevisions, [before.id]: { ...revision, content: { ...revision.content, passives } } } } }
  // Missing entities in a complete available catalog are invalid; a withdrawn snapshot retains unresolved selections
  const unavailable = JSON.parse(JSON.stringify(synthetic).replaceAll(JSON.stringify(CURRENT_CATALOG.revisionId), JSON.stringify(HISTORICAL_BUNDLED_CATALOG.revisionId))) as typeof payload
  await page.goto(createShareUrl(unavailable, `${baseURL}/`))
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const saved = await storedData(page)
  const copy = Object.values(saved.builds).find(build => !original.builds[build.id])!
  await page.goto(`${baseURL}/#/builds/library/${copy.id}`)
  const validity = page.getByRole('region', { name: 'Build validity', exact: true })
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
    await validity.getByRole('button', { name: `Review Equipped passive ${index + 1}`, exact: true }).click()
    const field = page.locator(`[data-field-key="slot:passive-${index + 1}"]`)
    await expect(field).toBeFocused()
    await expect(field.getByRole('combobox', { name: `Equipped passive ${index + 1}`, exact: true })).toBeVisible()
    await expect(field.getByText(`Equipped passive ${index + 1}: definition is unavailable`, { exact: true })).toBeVisible()
  }
  expect((await storedData(page)).buildRevisions).toEqual(saved.buildRevisions)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('validity review focuses retained equipment after copying a different slot layout', async ({ page, baseURL }) => {
  const { original, build, before } = await openBuild(page)
  const payload = createSharePayload(original, { kind: 'build', revisionId: before.id })
  const setup = payload.records.gameSetups[before.gameSetupRevisionId]!
  const removedSlot = setup.slots.find(slot => before.content.equipment[slot.id])!
  const equipment = { ...before.content.equipment }
  delete equipment[removedSlot.id]
  const narrowPreset = { ...payload, records: { ...payload.records, gameSetups: { ...payload.records.gameSetups, [setup.id]: { ...setup, label: 'Synthetic reduced-layout preset', slots: setup.slots.filter(slot => slot.id !== removedSlot.id) } }, buildRevisions: { ...payload.records.buildRevisions, [before.id]: { ...payload.records.buildRevisions[before.id]!, content: { ...before.content, equipment } } } } }
  await page.goto(createShareUrl(narrowPreset, `${baseURL}/`))
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.goto(`${baseURL}/#/builds/library/${build.id}`)
  await page.locator('.build-behavior > summary').click()
  await page.getByRole('combobox', { name: 'Copy Game Setup', exact: true }).selectOption({ label: 'Synthetic reduced-layout preset · r1' })
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  const issue = page.getByRole('region', { name: 'Build validity', exact: true }).getByRole('listitem').filter({ hasText: "A selection uses a slot missing from this Game Setup" })
  await issue.getByRole('button', { name: 'Review selection', exact: true }).click()
  const retained = page.locator(`[data-field-key="slot:${removedSlot.id}"]`)
  await expect(retained).toBeFocused()
  await expect(retained.getByRole('button', { name: `Remove ${removedSlot.id}`, exact: true })).toBeVisible()
  await retained.getByRole('button', { name: `Remove ${removedSlot.id}`, exact: true }).click()
  await expect(issue).toHaveCount(0)
  expect((await storedData(page)).buildRevisions[before.id]).toEqual(before)
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const saved = await storedData(page)
  const revision = saved.buildRevisions[saved.builds[build.id]!.latestRevisionId!]!
  expect(revision.content.equipment).toEqual(equipment)
  expect(saved.buildRevisions[before.id]).toEqual(before)
  expect(saved.playthroughs).toEqual(original.playthroughs)
})

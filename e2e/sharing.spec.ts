import { openStatBreakdown } from './calculation-presentation-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'
import { createSharePayload, createShareUrl, MAX_SHARE_URL_LENGTH, type SharePayload } from '../src/interchange/share'
import { asId } from '../src/domain/core'
import type { CatalogRevisionId, LocalData, PersonalDefinitionId, GameSetupRevisionId, EntityId } from '../src/domain/types'
import { addGameSetupRevision, createPersonalDefinition, createBuild, saveBuildRevision } from '../src/domain'
import { known } from '../src/domain/test-helpers'
import { SUGGESTED_BUILD_SLOTS } from '../src/domain/build-planning'
import { defaultCalculation } from '../src/domain/calculation-plan'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../src/catalog/bundled'
import { createTestLocalData } from '../src/domain/test-helpers'
import { buildContentForModSetup } from '../src/domain/build-mods'
import { prepareModComposition } from '../src/domain/mod-layers'
import { previewCrystalEdit } from '../src/interchange/crystal-edit'
import { prepareModCatalogs } from '../src/persistence/local-data'
import type { BuildId } from '../src/domain/types'
import { expectOfflineReady } from './offline-helpers'
import { skipInitialModSetup, selectedPlaythrough } from './local-data-helpers'

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

async function storedImportCounts(page: Page): Promise<Readonly<Record<string, number>>> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const stores = ['catalogs', 'sources', 'imports']
      const transaction = database.transaction(stores, 'readonly')
      const counts: Record<string, number> = {}
      transaction.onerror = () => { database.close(); reject(transaction.error) }
      transaction.oncomplete = () => { database.close(); resolve(counts) }
      for (const store of stores) {
        const count = transaction.objectStore(store).count()
        count.onsuccess = () => { counts[store] = count.result }
      }
    }
  }))
}

for (const modelMarker of [true, false]) test(`shared PC stats ${modelMarker ? 'with' : 'without'} a model marker and personal definition details match the saved editor offline`, { tag: MOBILE_TEST_TAG }, async ({ page, baseURL, context }, testInfo) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const before = await storedData(page)
  const build = Object.values(before.builds)[0]!
  const revision = before.buildRevisions[build.latestRevisionId!]!
  const id = asId<PersonalDefinitionId>('synthetic-shared-class')
  const ref = { kind: 'personal' as const, definitionId: id }
  if (revision.content.primaryClass?.kind !== 'catalog') throw new Error('The synthetic sample needs a catalog class')
  const cureRef = { ...revision.content.primaryClass, entityId: 'base:ability:7' as EntityId }
  const source = createPersonalDefinition(before, { id, name: 'Synthetic shared class', kind: 'class', fields: { 'Crystal Edit source record': known({ ID: 9000, Name: 'Synthetic shared class', HPRating: 50, MPRating: 50, StrRating: 50, VitRating: 50, DexRating: 50, AgiRating: 50, MndRating: 50, SpiRating: 50, SpdRating: 50, LckRating: 50, PassiveIDs: [] }), Command: known('Synthetic command') }, now: before.updatedAt })
  const nativeSetupId = asId<GameSetupRevisionId>('synthetic-shared-native-setup')
  const scopedSource = addGameSetupRevision(source, { ...source.gameSetups[revision.gameSetupRevisionId]!, id: nativeSetupId, platform: known('Windows'), gameVersion: known('1.6.9.0'), mode: known('Standard'), mods: known([]), slots: SUGGESTED_BUILD_SLOTS, activate: false, now: source.updatedAt })
  const content = { ...revision.content, primaryClass: ref, equipment: Object.fromEntries(Object.keys(revision.content.equipment).map(slot => [slot, null])), passives: [], calculation: { ...defaultCalculation(ref, 24), model: modelMarker ? defaultCalculation(ref, 24).model : undefined, gender: 'female' as const, ability: cureRef, targetEvasion: 0 }, rotationNotes: 'Synthetic shared rotation', contextAssumptions: ['Synthetic shared assumption'] }
  const payload = createSharePayload({ ...scopedSource, buildRevisions: { ...scopedSource.buildRevisions, [revision.id]: { ...revision, gameSetupRevisionId: nativeSetupId, content } } }, { kind: 'build', revisionId: revision.id }, true)
  await page.goto(createShareUrl(payload, `${baseURL}/`))
  const shared = page.getByRole('region', { name: 'Shared build loadout', exact: true })
  await openStatBreakdown(shared)
  await expect(shared.getByRole('region', { name: 'Class stats', exact: true })).toContainText('Synthetic shared class')
  await openStatBreakdown(shared)
  const overview = shared.getByRole('table', { name: 'Planned build stats', exact: true })
  await openStatBreakdown(shared)
  await expect(shared.getByRole('region', { name: 'Synthetic shared class growth', exact: true })).toBeVisible()
  const previewOverview = await overview.locator('th, td').allTextContents()
  await expect(overview).not.toContainText('Unknown')
  await expect(shared.getByText('Gender: Female', { exact: true })).toBeVisible()
  await shared.getByRole('button', { name: 'Inspect Class: Synthetic shared class', exact: true }).click()
  const definitionDetails = shared.getByLabel('Details for Synthetic shared class', { exact: true })
  if (await definitionDetails.locator('..').getAttribute('open') === null) await definitionDetails.click()
  await expect(shared.locator('.build-field').filter({ hasText: 'Synthetic shared class' }).getByText('Synthetic command', { exact: true }).filter({ visible: true }).first()).toBeVisible()
  const stats = shared.getByRole('table', { name: 'Calculated character stats', exact: true })
  await expect(stats.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Max HP', exact: true }) })).not.toContainText('Unknown')
  const previewStats = await stats.locator('th, td').allTextContents()
  await shared.locator('summary').filter({ hasText: /^Level-up growth/ }).click()
  await expect(shared.getByRole('definition').filter({ hasText: '24 levels' })).toBeVisible()
  await expect(shared.locator('input, select, textarea')).toHaveCount(0)
  await shared.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await expect(shared.getByRole('region', { name: 'Build mechanics', exact: true })).toBeVisible()
  await shared.locator('summary').filter({ hasText: 'Ability and hit-chance preview' }).click()
  await shared.locator('summary').filter({ hasText: /^Formula reference$/ }).click()
  await expect(shared.getByLabel('Ability estimate', { exact: true }).locator('dt').filter({ hasText: /^Power coefficient$/ }).locator('..').locator('dd')).toHaveText('-159')
  await expect(shared.getByLabel('Ability estimate', { exact: true }).getByRole('heading', { name: 'Cure', exact: true })).toBeVisible()
  await shared.locator('summary').filter({ hasText: /^Base hit-chance calculator$/ }).click()
  await expect(shared.getByLabel('Base physical hit chance', { exact: true })).toHaveText('Base physical hit chance: 100%')
  await shared.locator('summary').filter({ hasText: 'Build notes and assumptions' }).click()
  await expect(shared.locator('.share-notes')).toContainText('Synthetic shared rotation')
  await expect(shared.locator('.share-notes')).toContainText('Synthetic shared assumption')
  expect(await storedData(page)).toEqual(before)
  await context.setOffline(true)
  await page.reload()
  await openStatBreakdown(page)
  await expect(stats.locator('th, td')).toHaveText(previewStats)
  await expect(overview.locator('th, td')).toHaveText(previewOverview)
  await page.screenshot({ path: testInfo.outputPath('shared-grouped-loadout.png'), fullPage: true })
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByLabel('Calculation level', { exact: true })).toHaveValue('24')
  await expect(page.getByLabel('Calculation gender', { exact: true })).toHaveValue('female')
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true }).locator('th, td')).toHaveText(previewStats)
  await openStatBreakdown(page)
  await expect(page.getByRole('table', { name: 'Planned build stats', exact: true }).locator('th, td')).toHaveText(previewOverview)
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Synthetic shared class')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const copied = await storedData(page)
  const copy = Object.values(copied.builds).find(candidate => !before.builds[candidate.id])!
  expect(copied.buildRevisions[copy.latestRevisionId!]!.content.calculation?.model).toBe(content.calculation.model)
})

test('model-less shares use native rules and retain unsupported inputs without writes', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const before = await storedData(page)
  const build = Object.values(before.builds)[0]!
  const revision = before.buildRevisions[build.latestRevisionId!]!
  const calculation = { level: 20, gender: 'male' as const, growth: [{ classRef: revision.content.primaryClass, levels: 20 }], bonuses: ['HP' as const], statuses: [], ability: null, targetEvasion: 25 }
  const content = { ...revision.content, calculation }
  const nativeSetupId = asId<GameSetupRevisionId>('synthetic-model-less-native-setup')
  const scopedSource = addGameSetupRevision(before, { ...before.gameSetups[revision.gameSetupRevisionId]!, id: nativeSetupId, platform: known('Windows'), gameVersion: known('1.6.9.0'), mode: known('Standard'), mods: known([]), slots: SUGGESTED_BUILD_SLOTS, activate: false, now: before.updatedAt })
  const payload = createSharePayload({ ...scopedSource, buildRevisions: { ...scopedSource.buildRevisions, [revision.id]: { ...revision, gameSetupRevisionId: nativeSetupId, content } } }, { kind: 'build', revisionId: revision.id })
  await page.goto(createShareUrl(payload, `${baseURL}/`))
  const shared = page.getByRole('region', { name: 'Shared build loadout', exact: true })
  await openStatBreakdown(shared)
  const previewOverview = await shared.getByRole('table', { name: 'Planned build stats', exact: true }).locator('th, td').allTextContents()
  await openStatBreakdown(shared)
  await expect(shared.getByRole('region', { name: 'Warrior growth', exact: true }).locator('.stat-rating').first()).toBeVisible()
  await expect(shared.getByRole('heading', { name: 'Level 20 stats', exact: true })).toBeVisible()
  await expect(shared.getByText('Gender: Male', { exact: true })).toBeVisible()
  await expect(shared.getByRole('complementary', { name: 'Selection details', exact: true }).locator('.stat-ratings')).toHaveCount(0)
  const stats = shared.getByRole('table', { name: 'Calculated character stats', exact: true })
  await expect(stats).toHaveCount(0)
  await expect(shared).toContainText('Stats unavailable')
  await expect(shared).toContainText("Custom stat bonuses are not supported by gender comparisons.")
  const previewStats = await stats.locator('th, td').allTextContents()
  await shared.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await shared.locator('summary').filter({ hasText: 'Ability and hit-chance preview' }).click()
  await shared.locator('summary').filter({ hasText: /^Base hit-chance calculator$/ }).click()
  const hitChance = await shared.getByLabel('Base physical hit chance', { exact: true }).innerText()
  await expect(shared.locator('input, select, textarea')).toHaveCount(0)
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByLabel('Calculation gender', { exact: true })).toHaveValue('male')
  await openStatBreakdown(page)
  await expect(page.getByRole('table', { name: 'Planned build stats', exact: true }).locator('th, td')).toHaveText(previewOverview)
  expect(previewStats).toEqual([])
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Calculation level', { exact: true })).toHaveValue('20')
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await page.locator('summary').filter({ hasText: 'Ability and hit-chance preview' }).click()
  await page.locator('summary').filter({ hasText: /^Base hit-chance calculator$/ }).click()
  await expect(page.getByLabel('Target evasion', { exact: true })).toHaveValue('25')
  await expect(page.getByLabel('Base physical hit chance', { exact: true })).toHaveText(hitChance)
})

test('absent and unknown calculation inputs stay unknown until explicitly edited', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const before = await storedData(page)
  const build = Object.values(before.builds)[0]!
  const revision = before.buildRevisions[build.latestRevisionId!]!
  expect(revision.content.calculation).toBeUndefined()
  const unknownCalculation = defaultCalculation(revision.content.primaryClass, null)
  const unknownModelLessCalculation = { level: null, growth: [{ classRef: revision.content.primaryClass, levels: 60 }], bonuses: [], statuses: [] }
  for (const calculation of [undefined, unknownModelLessCalculation, unknownCalculation]) {
    const content = { ...revision.content, calculation }
    const payload = createSharePayload({ ...before, buildRevisions: { ...before.buildRevisions, [revision.id]: { ...revision, content } } }, { kind: 'build', revisionId: revision.id })
    await page.goto(createShareUrl(payload, `${baseURL}/`))
    const shared = page.getByRole('region', { name: 'Shared build loadout', exact: true })
    await openStatBreakdown(shared)
    await expect(shared.getByRole('heading', { name: 'Level unknown stats', exact: true })).toBeVisible()
    await expect(shared).not.toContainText('assumed for preview')
    if (calculation) {
      await openStatBreakdown(shared)
      const stats = shared.getByRole('table', { name: 'Planned build stats', exact: true })
      await expect(stats.getByRole('columnheader')).toHaveText(['Stat', 'Base'])
      await expect(stats).not.toContainText('Unknown')
      await expect(shared.getByRole('table', { name: 'Calculated character stats', exact: true })).toHaveCount(0)
      await expect(shared).toContainText('Choose a supported native calculation level.')
    } else await expect(shared).toContainText("Set calculation inputs to see stats.")
    await expect(shared.locator('input, select, textarea')).toHaveCount(0)
    await page.reload()
    await openStatBreakdown(shared)
    await expect(shared.getByRole('heading', { name: 'Level unknown stats', exact: true })).toBeVisible()
    expect(await storedData(page)).toEqual(before)
  }
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  const copied = await storedData(page)
  const copy = Object.values(copied.builds).find(candidate => !before.builds[candidate.id])!
  const copiedRevision = copied.buildRevisions[copy.latestRevisionId!]!
  expect(copiedRevision.content.calculation).toEqual(unknownCalculation)
  await expect(page.getByLabel('Calculation level', { exact: true })).toHaveValue('')
  await page.getByLabel('Calculation level', { exact: true }).fill('24')
  await openStatBreakdown(page)
  await expect(page.getByRole('region', { name: 'Class stats', exact: true })).not.toContainText('assumed for preview')
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  const saved = await storedData(page)
  expect(saved.buildRevisions[copiedRevision.id]!.content.calculation).toEqual(unknownCalculation)
  expect(saved.buildRevisions[saved.builds[copy.id]!.latestRevisionId!]!.content.calculation).toMatchObject({ level: 24, growth: [{ levels: 24 }] })
})

test('shares a saved build, supports manual copying, previews without writes and adds a copy', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await skipInitialModSetup(page)
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

test('opens four portable team slots in a fresh browser and saves them as an independent Team', { tag: MOBILE_TEST_TAG }, async ({ page, browser, baseURL, isMobile }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
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
    // Share decoding can finish after navigation; wait for the recipient view before checking its contents
    await recipient.getByRole('heading', { name: sourceTeam.label, exact: true }).waitFor()
    await expect(recipient.getByRole('heading', { name: sourceTeam.label, exact: true })).toBeVisible()
    const before = await storedData(recipient)
    const members = Object.values(selectedPlaythrough(before).characters)
    expect(members.map(character => character.id)).not.toEqual(sourceTeam.memberIds)
    const regions = recipient.getByRole('region', { name: /^Shared team slot \d$/ })
    await expect(regions).toHaveCount(4)
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await recipient.getByRole('button', { name: 'Save a copy', exact: true }).click()
    await expect(recipient).toHaveURL(/#\/teams\//)
    const after = await storedData(recipient)
    expect(Object.keys(after.builds)).toHaveLength(Object.keys(before.builds).length + 4)
    expect(selectedPlaythrough(after).characters).toEqual(selectedPlaythrough(before).characters)
    expect(selectedPlaythrough(after).inventory).toEqual(selectedPlaythrough(before).inventory)
    expect(after.gameSetups).toEqual(before.gameSetups)
    const added = Object.values(after.teams).find(team => !before.teams[team.id])!
    expect(added.slots).toHaveLength(4)
    expect(added.slots.every(id => id && after.buildRevisions[id])).toBe(true)
    expect(after.playthroughs).toEqual(before.playthroughs)
    await recipient.goto(`${baseURL}/#/teams`)
    await expect(recipient.getByRole('heading', { name: sourceTeam.label, exact: true })).toHaveCount(1)
  } finally { await recipientContext.close() }
})

test('survives a link near the URL budget on navigation and reload without leaking the fragment to HTTP', async ({ page, baseURL }) => {
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.goto('/')
  await skipInitialModSetup(page)
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
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await page.locator('.shared-preview summary').filter({ hasText: 'Build notes and assumptions' }).click()
  await expect(page.locator('.share-notes')).toContainText(text)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await storedData(page)).toEqual(original)
  expect(requests.every(url => !url.includes('#') && !url.includes('/share/'))).toBe(true)
  expect(errors).toEqual([])
})

test('a failed copy rolls back, remains previewable and retries without duplicates', async ({ page, baseURL }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
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
  await skipInitialModSetup(page)
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

async function portableModFixture(historical: boolean, completePermissions = false) {
  let text = '{"ID":"synthetic-portable-build","Title":"Synthetic Portable Mod","Jobs":[{"ID":24,"Name":"Synthetic Portable Class","Description":"Local-only description","AbilitiesName":"Synthetic Command","AbilityIDs":[]}],"Passives":[{"ID":10000,"Name":"Synthetic Passive One","PP":1,"IsInnate":false,"IsLearnable":true},{"ID":10001,"Name":"Synthetic Passive Two","PP":1,"IsInnate":false,"IsLearnable":true},{"ID":10002,"Name":"Synthetic Passive Three","PP":1,"IsInnate":false,"IsLearnable":true}]}'
  if (completePermissions) text = text.replace('"Description":"Local-only description"', '"Description":"Local-only description","EquipmentTypes":[2,13],"PassiveIDs":[]')
  const source = (await previewCrystalEdit(new TextEncoder().encode(text), 'original.json')).proposed.catalogs[0]!
  const catalogs = [...BUNDLED_CATALOGS, source]
  const composition = prepareModComposition({ version: 3, baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] }, catalogs)
  let data = addGameSetupRevision(createTestLocalData(), { label: 'Portable mod setup', slots: SUGGESTED_BUILD_SLOTS, modComposition: composition, activate: true })
  const setup = data.gameSetups[data.planningGameSetupRevisionId!]!
  const buildId = asId<BuildId>('portable-build')
  data = createBuild(data, { id: buildId, title: 'Portable mod build', gameSetupId: setup.gameSetupId })
  const sourceRef = (entityId: EntityId) => ({ kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId })
  const classRef = sourceRef(Object.values(source.entities).find(entity => entity.kind === 'class')!.id)
  const passives = Object.values(source.entities).filter(entity => entity.kind === 'passive').map(entity => ({ ref: sourceRef(entity.id) }))
  const nativeRef = (id: string) => ({ kind: 'catalog' as const, catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: asId<EntityId>(id) })
  const content = buildContentForModSetup({ primaryClass: classRef, secondaryClass: nativeRef('base:job:2'), equipment: { 'plan-main-hand': { ref: nativeRef('base:equipment:41') }, 'plan-head': { ref: nativeRef('base:equipment:481') } }, passives, contextAssumptions: [] }, setup, catalogs)
  data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id, content })
  const prepared = await prepareModCatalogs(data, catalogs)
  let payload = createSharePayload(data, { kind: 'build', revisionId: data.builds[buildId]!.latestRevisionId! }, false, prepared)
  if (historical) {
    payload = JSON.parse(JSON.stringify(payload).replaceAll('library-v4', 'library-v2')) as SharePayload
    const originalSetup = Object.values(payload.records.gameSetups)[0]!
    const { identityMappings: _mappings, ...oldComposition } = originalSetup.modComposition!
    payload = { ...payload, records: { ...payload.records, gameSetups: { [originalSetup.id]: { ...originalSetup, modComposition: { ...oldComposition, version: 2, baseline: { ...oldComposition.baseline, catalogRevisionId: asId<CatalogRevisionId>('catalog-v1') } } } } } }
  }
  return { text, source, payload }
}

for (const historical of [false, true]) test(`modded shares keep selected names and accept matching local JSON and artwork ${historical ? 'from older pins' : 'from current pins'}`, { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const { text, source, payload } = await portableModFixture(historical)
  const url = createShareUrl(payload, `${baseURL}/`)
  expect(JSON.stringify(payload)).not.toContain('Local-only description')
  await page.goto(url)
  await expect(page.getByRole('heading', { name: 'Portable mod build', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Inspect Class: Synthetic Portable Class', exact: true })).toBeVisible()
  const validity = page.getByRole('region', { name: 'Build validity', exact: true })
  for (const index of [1, 2, 3]) await expect(validity.getByText(`Equipped passive ${index}: definition is unavailable`, { exact: false })).toHaveCount(1)
  const input = page.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true })
  const before = await storedData(page)
  const importCounts = await storedImportCounts(page)
  await input.setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(text.replace('Synthetic Portable Class', 'Changed Class')) })
  await expect(page.getByText('This JSON does not match the saved mod content and project identity.', { exact: false })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  expect(await storedImportCounts(page)).toEqual(importCounts)
  const reordered = JSON.stringify(JSON.parse(text), (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value, 2)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'catalogs') throw new DOMException('Synthetic mod import write failed', 'QuotaExceededError')
      return put.apply(this, args)
    }
    ;(window as unknown as { restoreModImportWrite: () => void }).restoreModImportWrite = () => { IDBObjectStore.prototype.put = put }
  })
  await input.setInputFiles({ name: 'my-mod.json', mimeType: 'application/json', buffer: Buffer.from(reordered) })
  await expect(page.getByText('Mod not imported', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  expect(await storedImportCounts(page)).toEqual(importCounts)
  await page.evaluate(() => (window as unknown as { restoreModImportWrite: () => void }).restoreModImportWrite())
  await input.setInputFiles({ name: 'my-mod.json', mimeType: 'application/json', buffer: Buffer.from(reordered) })
  await expect(page.getByRole('status').filter({ hasText: 'was imported and saved in this browser' })).toBeVisible()
  await expect(page.getByText('Using matching local JSON', { exact: true })).toBeVisible()
  if (historical) {
    await expect(page.getByText('Its results may differ from the saved checkpoint.', { exact: false })).toBeVisible()
    const broken = JSON.parse(JSON.stringify(payload)) as SharePayload
    const brokenRevision = Object.values(broken.records.buildRevisions)[0]!
    const missingName = { ...brokenRevision.content.referenceNames![0]!, modelKey: 'crystal-edit:Jobs:65535' }
    const brokenPayload = { ...broken, records: { ...broken.records, buildRevisions: { [brokenRevision.id]: { ...brokenRevision, content: { ...brokenRevision.content, referenceNames: [missingName] } } } } }
    const afterImport = await storedData(page)
    await page.goto(createShareUrl(brokenPayload, `${baseURL}/`))
    await expect(page.getByText('Imported definitions not applied', { exact: true })).toBeVisible()
    await expect(page.getByText('The imported sources cannot resolve Synthetic Portable Class.', { exact: false })).toBeVisible()
    await expect(page.getByText('Using matching local JSON', { exact: true })).toHaveCount(0)
    expect(await storedData(page)).toEqual(afterImport)
    await page.goto(url)
    await expect(page.getByText('Using matching local JSON', { exact: true })).toBeVisible()
  }
  await page.reload()
  await expect(page.getByText('Using matching local JSON', { exact: true })).toBeVisible()
  await expect(validity.getByText('definition is unavailable', { exact: false })).toHaveCount(0)
  const selected = page.getByRole('region', { name: 'Mod sources', exact: true })
  await selected.locator('details').filter({ has: page.locator('summary', { hasText: /^Synthetic Portable Class$/ }) }).locator('summary').first().click()
  await selected.getByLabel('Local artwork for Synthetic Portable Class', { exact: true }).setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVJcAAAAASUVORK5CYII=', 'base64') })
  await expect(page.getByRole('button', { name: 'Inspect Class: Synthetic Portable Class', exact: true }).locator('img')).toHaveAttribute('src', /^blob:/)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Portable mod build', exact: true }).first()).toBeVisible()
  const saved = await storedData(page)
  const build = Object.values(saved.builds).find(build => build.title === 'Portable mod build')!
  const revision = saved.buildRevisions[build.latestRevisionId!]!
  expect(revision.content.referenceNames?.[0]?.name).toBe('Synthetic Portable Class')
  expect(JSON.stringify(revision)).not.toMatch(/blob:|Local-only description|data:image/)
  const savedSetup = saved.gameSetups[revision.gameSetupRevisionId]!
  expect(savedSetup.modComposition!.layers[0]!.catalogRevisionId).not.toBe(source.revisionId)
  expect(savedSetup.modComposition!.baseline.catalogRevisionId).toBe(CURRENT_CATALOG.revisionId)
})

test('missing mod details stay optional while calculation locks offer local JSON recovery', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const { text, payload } = await portableModFixture(true, true)
  const beforeRevision = Object.values(payload.records.buildRevisions)[0]!
  const primaryClass = { ...beforeRevision.content.secondaryClass!, entityId: asId<EntityId>('base:job:0') }
  const content = { ...beforeRevision.content, primaryClass, equipment: {}, passives: [], referenceNames: beforeRevision.content.referenceNames?.filter(entry => entry.ref.entityId === 'base:job:2'), calculation: defaultCalculation(primaryClass) }
  const native = { ...payload, records: { ...payload.records, buildRevisions: { ...payload.records.buildRevisions, [beforeRevision.id]: { ...beforeRevision, content } } } }
  await page.goto(createShareUrl(native, `${baseURL}/`))
  const stats = page.getByRole('region', { name: 'Calculated stats', exact: true })
  const lock = stats.getByRole('group', { name: 'Calculations need mod JSON', exact: true })
  await expect(lock).toBeVisible()
  expect(await lock.getByRole('button', { name: 'Upload mod JSON', exact: true }).evaluate(button => getComputedStyle(button).fontWeight)).toBe('400')
  await lock.getByRole('button', { name: 'Upload mod JSON', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Restore mod definitions', exact: true })
  await expect(dialog.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const before = await storedData(page)
  const disclosure = page.getByRole('region', { name: 'Build validity', exact: true }).locator('.build-validity__details')
  if (await disclosure.count()) await expect(disclosure).not.toHaveAttribute('open')
  await page.getByRole('button', { name: 'Share build', exact: true }).click()
  const sharing = page.getByRole('dialog', { name: 'Share build', exact: true })
  await expect(sharing.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled()
  await sharing.getByRole('button', { name: 'Close', exact: true }).click()
  await lock.getByRole('button', { name: 'Upload mod JSON', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Restore mod definitions', exact: true })
  await dialog.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true }).setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(dialog.getByRole('status')).toContainText('Matching definitions applied to this draft')
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(lock).toHaveCount(0)
  await expect(stats.getByRole('table', { name: 'Calculated character stats', exact: true })).toBeVisible()
  expect((await storedData(page)).buildRevisions).toEqual(before.buildRevisions)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('validity warnings restore missing mod definitions inside the editor without losing unsaved edits', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const { text, payload } = await portableModFixture(true, true)
  await page.goto(createShareUrl(payload, `${baseURL}/`))
  const validity = page.getByRole('region', { name: 'Build validity', exact: true })
  const disclosure = validity.locator('.build-validity__details')
  await expect(disclosure).not.toHaveAttribute('open')
  await disclosure.locator(':scope > summary').click()
  const permission = validity.getByRole('listitem').filter({ hasText: 'Dagger permission is unresolved' })
  await expect(permission.getByRole('button', { name: 'Upload mod JSON', exact: true })).toBeVisible()
  expect(await permission.getByRole('button', { name: 'Upload mod JSON', exact: true }).evaluate(button => getComputedStyle(button).fontWeight)).toBe('400')
  await permission.getByRole('button', { name: 'Upload mod JSON', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Restore mod definitions', exact: true })
  await expect(dialog.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === 'Portable mod build')!
  const checkpoint = before.buildRevisions[build.latestRevisionId!]!
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await page.getByRole('textbox', { name: 'Rotation or use notes', exact: true }).fill('Keep this unsaved rotation')
  const mechanics = page.getByRole('region', { name: 'Build mechanics', exact: true })
  await expect(mechanics.getByRole('list', { name: 'Equipment findings' })).toContainText('Restore the missing class and passive definitions')
  await mechanics.getByRole('button', { name: 'Review solutions', exact: true }).click()
  await expect(validity).toBeFocused()
  await expect(validity.locator('.build-validity__details')).toHaveAttribute('open')
  const editorPermission = validity.getByRole('listitem').filter({ hasText: 'Dagger permission is unresolved' })
  await editorPermission.getByRole('button', { name: 'Review Class', exact: true }).click()
  await expect(page.locator('[data-field-key="primary-class"]')).toBeFocused()
  await page.locator('[data-field-key="slot:plan-main-hand"]').getByRole('button', { name: 'Review solutions', exact: true }).click()
  await expect(validity).toBeFocused()
  await editorPermission.getByRole('button', { name: 'Upload mod JSON', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Restore mod definitions', exact: true })
  const input = dialog.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true })
  const imports = await storedImportCounts(page)
  await input.setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(text.replace('Synthetic Portable Class', 'Changed Class')) })
  await expect(dialog.getByText('This JSON does not match the saved mod content and project identity.', { exact: false })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  expect(await storedImportCounts(page)).toEqual(imports)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'catalogs') throw new DOMException('Synthetic warning import write failed', 'QuotaExceededError')
      return put.apply(this, args)
    }
    ;(window as unknown as { restoreWarningImport: () => void }).restoreWarningImport = () => { IDBObjectStore.prototype.put = put }
  })
  await input.setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(dialog.getByText('Mod not imported', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  expect(await storedImportCounts(page)).toEqual(imports)
  await page.evaluate(() => (window as unknown as { restoreWarningImport: () => void }).restoreWarningImport())
  await input.setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(dialog.getByRole('status')).toContainText('Matching definitions applied to this draft')
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(validity.getByText('definition is unavailable', { exact: false })).toHaveCount(0)
  await expect(validity.getByText('permission is unresolved', { exact: false })).toHaveCount(0)
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Rotation or use notes', exact: true })).toHaveValue('Keep this unsaved rotation')
  expect((await storedData(page)).buildRevisions[checkpoint.id]).toEqual(checkpoint)
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const saved = await storedData(page)
  const revision = saved.buildRevisions[saved.builds[build.id]!.latestRevisionId!]!
  expect(revision.id).not.toBe(checkpoint.id)
  expect(revision.content.rotationNotes).toBe('Keep this unsaved rotation')
  expect(saved.buildRevisions[checkpoint.id]).toEqual(checkpoint)
  expect(saved.gameSetups[revision.gameSetupRevisionId]!.modComposition!.baseline.catalogRevisionId).toBe(CURRENT_CATALOG.revisionId)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

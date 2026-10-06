import { openStatBreakdown } from './calculation-presentation-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'
import { createSharePayload, createShareUrl, MAX_SHARE_URL_LENGTH } from '../src/interchange/share'
import { asId } from '../src/domain/core'
import type { CatalogRevisionId, LocalData, PersonalDefinitionId, GameSetupRevisionId, EntityId } from '../src/domain/types'
import { addGameSetupRevision, createPersonalDefinition } from '../src/domain'
import { known } from '../src/domain/test-helpers'
import { SUGGESTED_BUILD_SLOTS } from '../src/domain/build-planning'
import { defaultCalculation } from '../src/domain/calculation-plan'
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
  await expect(shared.getByRole('region', { name: 'Class growth ratings', exact: true })).toBeVisible()
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
  await expect(shared.getByRole('region', { name: 'Class growth ratings', exact: true }).locator('.stat-rating').first()).toBeVisible()
  await expect(shared.getByRole('heading', { name: 'Level 20 stats', exact: true })).toBeVisible()
  await expect(shared.getByText('Gender: Male', { exact: true })).toBeVisible()
  await expect(shared.getByRole('complementary', { name: 'Selection details', exact: true }).locator('.build-selection-details__ratings')).toHaveCount(0)
  const stats = shared.getByRole('table', { name: 'Calculated character stats', exact: true })
  await expect(stats).toHaveCount(0)
  await expect(shared).toContainText('Stats unavailable')
  await expect(shared).toContainText('Per-stat bonus assumptions are outside the native gender comparisons.')
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
    } else await expect(shared).toContainText('No calculation inputs saved.')
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

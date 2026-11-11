import { openShareSources, openCopiedCheckpointControls } from './share-view-helpers'
import { createPublicSnapshot, createPublicShareUrl, decodePublicSnapshot } from '../src/interchange/public-share'
import { teamSlots, withTeamBuildViews } from '../src/domain/team-checkpoints'
import { openStatBreakdown } from './calculation-presentation-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'
import { PUBLIC_SHARE_LIMITS, type PublicSnapshot } from '../src/interchange/public-share-schema'
import { asId } from '../src/domain/core'
import type { CatalogRevisionId, LocalData, PersonalDefinitionId, GameSetupRevisionId, EntityId } from '../src/domain/types'
import { addGameSetupRevision, createPersonalDefinition, createBuild, saveBuildRevision } from '../src/domain'
import { known } from '../src/domain/test-helpers'
import { SUGGESTED_BUILD_SLOTS } from '../src/domain/build-planning'
import { defaultCalculation } from '../src/domain/calculation-plan'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../src/catalog/bundled'
import { createTestLocalData } from '../src/domain/test-helpers'
import { mapBuildModReferences, buildContentForModSetup } from '../src/domain/build-mods'
import { modSourceReceipts } from '../src/domain/build-reference-names'
import { prepareModComposition } from '../src/domain/mod-layers'
import { previewCrystalEdit } from '../src/interchange/crystal-edit'
import { prepareModCatalogs } from '../src/persistence/local-data'
import type { BuildId } from '../src/domain/types'
import { expectOfflineReady } from './offline-helpers'
import { skipInitialModSetup, selectedPlaythrough, selectedGuestPlannerName, replacePlannerFixture, readLocalData as storedData } from './local-data-helpers'
import { readManagedGuestPlanner } from './guest-planner-reader'


const MAX_SHARE_URL_LENGTH = PUBLIC_SHARE_LIMITS.url

for (const title of ['Judite', 'Marco', 'Prudence', 'Marcy']) test(`shares and copies ${title} with missing definitions`, { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await skipInitialModSetup(page)
  const before = await storedData(page)
  const card = page.locator('.build-card').filter({ has: page.getByRole('button', { name: title, exact: true }) })
  await card.getByRole('button', { name: 'Share build', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Share build', exact: true })
  expect(await dialog.locator('.share-preview').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const url = await dialog.getByLabel('Share URL', { exact: true }).inputValue()
  const snapshot = decodePublicSnapshot(new URL(url).hash.split('/')[3]!)
  expect(snapshot.receipts.some(receipt => receipt.kind === null)).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled()
  await page.goto(url)
  await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible()
  await expect(page.getByText('Calculations unavailable', { exact: true })).toBeVisible()
  await openShareSources(page)
  await page.getByRole('region', { name: 'Your matching definitions', exact: true }).locator('details').first().locator('summary').click()
  await expect(page.getByRole('region', { name: 'Your matching definitions', exact: true }).getByText('Definition unavailable. The saved name supplies no mechanics.').first()).toBeVisible()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
  const copied = await storedData(page)
  const build = Object.values(copied.builds).find(candidate => !before.builds[candidate.id])!
  const checkpoint = copied.buildRevisions[build.latestRevisionId!]!
  expect(checkpoint.publicSourceContext?.version).toBe(2)
  expect(checkpoint.publicSourceContext?.receipts).toEqual(snapshot.receipts)
  expect(copied.playthroughs).toEqual(before.playthroughs)
  await page.reload()
  await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
  expect((await storedData(page)).buildRevisions[checkpoint.id]).toEqual(checkpoint)
  expect(errors).toEqual([])
})

async function snapshotFor(page: Page, localData: LocalData, target: Parameters<typeof createPublicSnapshot>[1], includeNotes = false, available = BUNDLED_CATALOGS) {
  const viewer = await readManagedGuestPlanner(page)
  const catalogs = await prepareModCatalogs(localData, [...available, ...(viewer?.catalogs ?? [])])
  return createPublicSnapshot({ planner: { localData, catalogs } }, target, { includeNotes })
}
async function makeEditableCopy(page: Page, setupId: string): Promise<void> {
  await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
  await openCopiedCheckpointControls(page)
  await page.getByRole('combobox', { name: 'Local Game Setup', exact: true }).selectOption(setupId)
  await page.getByRole('button', { name: 'Create editable checkpoint', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
}

// Related assertions use one complete admission of the same selected head
// Every later action starts a fresh inspection; no captured bytes survive between checkpoints
async function storedShareState(page: Page): Promise<{ localData: LocalData; importCounts: Readonly<Record<string, number>> }> {
  const managed = await readManagedGuestPlanner(page)
  if (managed) return { localData: structuredClone(managed.localData), importCounts: { catalogs: managed.catalogs.length, sources: managed.sources.length, imports: Object.keys(managed.localData.importReceipts).length } }
  return { localData: await storedData(page), importCounts: await legacyImportCounts(page) }
}

async function expectStoredShareUnchanged(page: Page, localData: LocalData, importCounts: Readonly<Record<string, number>>): Promise<void> {
  const actual = await storedShareState(page)
  expect(actual.localData).toEqual(localData)
  expect(actual.importCounts).toEqual(importCounts)
}

async function legacyImportCounts(page: Page): Promise<Readonly<Record<string, number>>> {
  const name = await selectedGuestPlannerName(page)
  return page.evaluate(name => new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
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
  }), name)
}

for (const modelMarker of [true, false]) test(`shared PC stats ${modelMarker ? 'with' : 'without'} a model marker and personal definition details match the saved editor offline`, { tag: MOBILE_TEST_TAG }, async ({ page, baseURL, context, isMobile }, testInfo) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  let before = await storedData(page)
  const build = Object.values(before.builds)[0]!
  const revision = before.buildRevisions[build.latestRevisionId!]!
  const id = asId<PersonalDefinitionId>('synthetic-shared-class')
  const ref = { kind: 'personal' as const, definitionId: id }
  if (revision.content.primaryClass?.kind !== 'catalog') throw new Error('The synthetic sample needs a catalog class')
  const cureRef = { ...revision.content.primaryClass, catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: 'base:ability:7' as EntityId }
  const source = createPersonalDefinition(before, { id, name: 'Synthetic shared class', kind: 'class', fields: { 'Crystal Edit source record': known({ ID: 9000, Name: 'Synthetic shared class', HPRating: 50, MPRating: 50, StrRating: 50, VitRating: 50, DexRating: 50, AgiRating: 50, MndRating: 50, SpiRating: 50, SpdRating: 50, LckRating: 50, PassiveIDs: [] }), Command: known('Synthetic command') }, now: before.updatedAt })
  const nativeSetupId = asId<GameSetupRevisionId>('synthetic-shared-native-setup')
  const scopedSource = addGameSetupRevision(source, { ...source.gameSetups[revision.gameSetupRevisionId]!, id: nativeSetupId, platform: known('Windows'), gameVersion: known('1.6.9.0'), mode: known('Standard'), mods: known([]), modComposition: undefined, modSourceReceipts: undefined, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, slots: SUGGESTED_BUILD_SLOTS, activate: false, now: source.updatedAt })
  const content = { ...revision.content, primaryClass: ref, equipment: Object.fromEntries(Object.keys(revision.content.equipment).map(slot => [slot, null])), passives: [], calculation: { ...defaultCalculation(ref, 24), model: modelMarker ? defaultCalculation(ref, 24).model : undefined, gender: 'female' as const, ability: cureRef, targetEvasion: 0 }, rotationNotes: 'Synthetic shared rotation', contextAssumptions: ['Synthetic shared assumption'] }
  const ownFixture = { ...scopedSource, buildRevisions: { ...scopedSource.buildRevisions, [revision.id]: { ...revision, gameSetupRevisionId: nativeSetupId, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, content } } }
  await replacePlannerFixture(page, ownFixture)
  before = await storedData(page)
  const payload = await snapshotFor(page, before, { kind: 'build', revisionId: revision.id }, true)
  expect(JSON.stringify(payload)).not.toContain('Synthetic command')
  await page.goto(createPublicShareUrl(payload, `${baseURL}/`))
  const shared = page.getByRole('region', { name: 'Build calculations', exact: true })
  await openStatBreakdown(shared)
  await expect(shared.getByRole('region', { name: 'Class stats', exact: true })).toContainText('Synthetic shared class')
  await openStatBreakdown(shared)
  const overview = shared.getByRole('table', { name: 'Planned build stats', exact: true })
  await openStatBreakdown(shared)
  await shared.locator('summary').filter({ hasText: /^Class growth$/ }).click()
  await expect(shared.getByRole('region', { name: 'Synthetic shared class growth', exact: true })).toBeVisible()
  const previewOverview = await overview.locator('th, td').allTextContents()
  await expect(overview).not.toContainText('Unknown')
  await expect(shared.getByText('Gender: Female', { exact: true })).toBeVisible()
  await shared.getByRole('button', { name: 'Inspect Class: Synthetic shared class', exact: true }).click()
  const definitionDetails = isMobile ? shared.locator('.build-field').filter({ hasText: 'Synthetic shared class' }) : shared.getByRole('complementary', { name: 'Selection details', exact: true })
  await expect(definitionDetails.getByText('Synthetic command', { exact: true }).filter({ visible: true }).first()).toBeVisible()
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
  await makeEditableCopy(page, nativeSetupId)
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
  let before = await storedData(page)
  const build = Object.values(before.builds)[0]!
  const revision = before.buildRevisions[build.latestRevisionId!]!
  const calculation = { level: 20, gender: 'male' as const, growth: [{ classRef: revision.content.primaryClass, levels: 20 }], bonuses: ['HP' as const], statuses: [], ability: null, targetEvasion: 25 }
  const content = mapBuildModReferences({ ...revision.content, secondaryClass: null, equipment: {}, passives: [], calculation }, ref => ref?.kind === 'catalog' ? { ...ref, catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId } : ref)
  const nativeSetupId = asId<GameSetupRevisionId>('synthetic-model-less-native-setup')
  const scopedSource = addGameSetupRevision(before, { ...before.gameSetups[revision.gameSetupRevisionId]!, id: nativeSetupId, platform: known('Windows'), gameVersion: known('1.6.9.0'), mode: known('Standard'), mods: known([]), modComposition: undefined, modSourceReceipts: undefined, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, slots: SUGGESTED_BUILD_SLOTS, activate: false, now: before.updatedAt })
  await replacePlannerFixture(page, { ...scopedSource, buildRevisions: { ...scopedSource.buildRevisions, [revision.id]: { ...revision, gameSetupRevisionId: nativeSetupId, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, content } } })
  before = await storedData(page)
  const payload = await snapshotFor(page, before, { kind: 'build', revisionId: revision.id })
  await page.goto(createPublicShareUrl(payload, `${baseURL}/`))
  const shared = page.getByRole('region', { name: 'Build calculations', exact: true })
  await openStatBreakdown(shared)
  const previewOverview = await shared.getByRole('table', { name: 'Planned build stats', exact: true }).locator('th, td').allTextContents()
  await openStatBreakdown(shared)
  await shared.locator('summary').filter({ hasText: /^Class growth$/ }).click()
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
  await makeEditableCopy(page, nativeSetupId)
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
  let before = await storedData(page)
  const build = Object.values(before.builds)[0]!
  const revision = before.buildRevisions[build.latestRevisionId!]!
  const nativeSetupId = asId<GameSetupRevisionId>('synthetic-unknown-calculation-setup')
  const nativeSetup = { ...before.gameSetups[revision.gameSetupRevisionId]!, id: nativeSetupId, modComposition: undefined, modSourceReceipts: undefined, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId } }
  const nativeContent = mapBuildModReferences({ ...revision.content, secondaryClass: null, equipment: {}, passives: [] }, ref => ref?.kind === 'catalog' ? { ...ref, catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId } : ref)
  await replacePlannerFixture(page, { ...before, gameSetups: { ...before.gameSetups, [nativeSetupId]: nativeSetup }, buildRevisions: { ...before.buildRevisions, [revision.id]: { ...revision, gameSetupRevisionId: nativeSetupId, catalogLock: nativeSetup.catalogLock, content: nativeContent } } })
  before = await storedData(page)
  expect(revision.content.calculation).toBeUndefined()
  const unknownCalculation = defaultCalculation(nativeContent.primaryClass, null)
  const unknownModelLessCalculation = { level: null, growth: [{ classRef: nativeContent.primaryClass, levels: 60 }], bonuses: [], statuses: [] }
  for (const calculation of [undefined, unknownModelLessCalculation, unknownCalculation]) {
    const content = { ...nativeContent, calculation }
    const payload = await snapshotFor(page, { ...before, buildRevisions: { ...before.buildRevisions, [revision.id]: { ...before.buildRevisions[revision.id]!, content } } }, { kind: 'build', revisionId: revision.id })
    await page.goto(createPublicShareUrl(payload, `${baseURL}/`))
    const shared = page.getByRole('region', { name: 'Build calculations', exact: true })
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
  await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
  const copied = await storedData(page)
  const copy = Object.values(copied.builds).find(candidate => !before.builds[candidate.id])!
  const copiedRevision = copied.buildRevisions[copy.latestRevisionId!]!
  expect(copiedRevision.content.calculation).toEqual(unknownCalculation)
  await makeEditableCopy(page, nativeSetupId)
  await expect(page.getByLabel('Calculation level', { exact: true })).toHaveValue('')
  await page.getByLabel('Calculation level', { exact: true }).fill('24')
  await openStatBreakdown(page)
  await expect(page.getByRole('region', { name: 'Class stats', exact: true })).not.toContainText('assumed for preview')
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const saved = await storedData(page)
  expect(saved.buildRevisions[copiedRevision.id]!.content.calculation).toEqual(unknownCalculation)
  expect(saved.buildRevisions[saved.builds[copy.id]!.latestRevisionId!]!.content.calculation).toMatchObject({ level: 24, growth: [{ levels: 24 }] })
})

test('creates a receipt-only build link with manual copying and an immutable independent copy', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await skipInitialModSetup(page)
  const original = await storedData(page)
  const build = Object.values(original.builds)[0]!
  const card = page.locator('.build-card').filter({ has: page.getByRole('button', { name: build.title, exact: true }) })
  await card.getByRole('button', { name: 'Share build', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Share build', exact: true })
  const url = await dialog.getByLabel('Share URL', { exact: true }).inputValue()
  expect(url.length).toBeLessThanOrEqual(MAX_SHARE_URL_LENGTH)
  const snapshot = decodePublicSnapshot(new URL(url).hash.split('/')[3]!)
  expect(snapshot.kind).toBe('build')
  expect(snapshot).not.toHaveProperty('records')
  await expect(dialog.getByRole('checkbox', { name: 'Include written notes' })).not.toBeChecked()
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Synthetic denied clipboard')) } }) })
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click()
  await expect(dialog.getByText('Copy the selected link', { exact: true })).toBeVisible()
  expect(await dialog.getByLabel('Share URL', { exact: true }).evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBe(url.length)
  await page.goto(url)
  await expect(page.getByRole('heading', { name: build.title, exact: true }).first()).toBeVisible()
  await page.reload()
  expect(await storedData(page)).toEqual(original)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
  const saved = await storedData(page)
  const copy = Object.values(saved.builds).find(candidate => !original.builds[candidate.id])!
  const checkpoint = saved.buildRevisions[copy.latestRevisionId!]!
  expect(saved.playthroughs).toEqual(original.playthroughs)
  expect(saved.builds[build.id]).toEqual(build)
  expect(saved.buildRevisions[build.latestRevisionId!]).toEqual(original.buildRevisions[build.latestRevisionId!])
  expect(checkpoint.publicSourceContext?.receipts).toEqual(snapshot.receipts)
  expect(saved.gameSetups[checkpoint.gameSetupRevisionId]!.publicSourceContext?.setup).toEqual(snapshot.setup)
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toHaveCount(0)
  await page.reload()
  expect((await storedData(page)).buildRevisions[checkpoint.id]).toEqual(checkpoint)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('shares four ordered team slots and copies independent immutable checkpoints', { tag: MOBILE_TEST_TAG }, async ({ page, browser, isMobile }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  const source = await storedData(page)
  const sourceTeam = Object.values(selectedPlaythrough(source).scenarios)[0]!
  await page.goto(`/#/builds/teams/${sourceTeam.id}`)
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  const url = await page.getByRole('dialog', { name: 'Share team', exact: true }).getByLabel('Share URL').inputValue()
  const snapshot = decodePublicSnapshot(new URL(url).hash.split('/')[3]!)
  expect(snapshot.slots).toHaveLength(4)
  const recipientContext = await browser.newContext({ viewport: page.viewportSize()!, isMobile })
  try {
    const recipient = await recipientContext.newPage()
    await recipient.goto(url)
    await expect(recipient.getByRole('heading', { name: sourceTeam.label, exact: true })).toBeVisible()
    await expect(recipient.getByRole('region', { name: /^Shared team slot \d$/ })).toHaveCount(4)
    const before = await storedData(recipient)
    await recipient.getByRole('button', { name: 'Save a copy', exact: true }).click()
    await expect(recipient.getByText('Independent saved copy', { exact: true })).toBeVisible()
    const after = await storedData(recipient)
    const added = Object.values(after.teams).find(team => !before.teams[team.id])!
    if (added.kind !== 'shared') throw new Error('Expected a shared Team checkpoint')
    const checkpoint = after.teamRevisions[added.latestRevisionId!]!
    expect(checkpoint.slots.map(slot => slot !== null)).toEqual(snapshot.slots.map(slot => slot !== null))
    expect(checkpoint.publicSourceContext?.receipts).toEqual(snapshot.receipts)
    expect(after.builds).toEqual(before.builds)
    expect(after.playthroughs).toEqual(before.playthroughs)
    expect(teamSlots(after, added)).toHaveLength(4)
    expect(teamSlots(after, added).every(id => !id || withTeamBuildViews(after).buildRevisions[id])).toBe(true)
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await recipientContext.close() }
})

test('survives a v5 link near the URL budget on reload without leaking the fragment to HTTP', async ({ page, baseURL }) => {
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await page.goto('/')
  await skipInitialModSetup(page)
  const original = await storedData(page)
  const revision = Object.values(original.buildRevisions)[0]!
  const payload = await snapshotFor(page, original, { kind: 'build', revisionId: revision.id })
  const baseUrl = `${baseURL}/`
  const emptyNotes: PublicSnapshot = { ...payload, notes: { checkpoint: '', slots: [{ rotationNotes: '', contextAssumptions: ['', ''] }] } }
  // Raw v5 UTF-8 grows by four base64url characters per three bytes, including JSON escaping
  const notesBudget = Math.floor((MAX_SHARE_URL_LENGTH * .95 - createPublicShareUrl(emptyNotes, baseUrl).length) * 3 / 4)
  const chunkLength = Math.floor(notesBudget / 4)
  const chunks = Array.from({ length: 4 }, (_, index) => `Synthetic note ${index}: ` + 'x'.repeat(chunkLength - 18))
  const longPayload: PublicSnapshot = { ...payload, notes: { checkpoint: chunks[0], slots: [{ rotationNotes: chunks[1], contextAssumptions: [chunks[2]!, chunks[3]!] }] } }
  const url = createPublicShareUrl(longPayload, baseUrl)
  expect(url.length).toBeGreaterThan(MAX_SHARE_URL_LENGTH * .9)
  expect(url.length).toBeLessThan(MAX_SHARE_URL_LENGTH)
  await page.goto(url)
  await expect(page.getByRole('heading', { name: payload.title, exact: true }).first()).toBeVisible()
  expect(await page.evaluate(() => location.href.length)).toBe(url.length)
  await page.reload()
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await page.locator('summary').filter({ hasText: 'Build notes and assumptions' }).click()
  for (const chunk of chunks) await expect(page.locator('.share-notes').filter({ hasText: chunk }).first()).toBeVisible()
  expect(await storedData(page)).toEqual(original)
  expect(requests.every(url => !url.includes('#') && !url.includes('/share/'))).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('a failed v5 copy rolls back and retries without changing the original records', async ({ page, baseURL }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  const original = await storedData(page)
  const revision = Object.values(original.buildRevisions)[0]!
  const payload = await snapshotFor(page, original, { kind: 'build', revisionId: revision.id })
  const changed: PublicSnapshot = { ...payload, setup: { ...payload.setup, ppLimit: { state: 'known', value: 11 } } }
  const url = createPublicShareUrl(changed, `${baseURL}/`)
  await page.goto(url)
  await expect(page.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    let failOnce = true
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'active' && this.transaction.db.name === 'crykit-guest-coordinator-v1' && failOnce) { failOnce = false; throw new DOMException('Synthetic share save failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Shared view could not finish', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(original)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
  const saved = await storedData(page)
  const copy = Object.values(saved.builds).find(candidate => !original.builds[candidate.id])!
  const checkpoint = saved.buildRevisions[copy.latestRevisionId!]!
  expect(saved.gameSetups[checkpoint.gameSetupRevisionId]!.ppLimit).toEqual({ state: 'known', value: 11 })
  expect(saved.playthroughs).toEqual(original.playthroughs)
  expect(Object.keys(saved.builds)).toHaveLength(Object.keys(original.builds).length + 1)
  await page.goto(url)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
  const repeated = await storedData(page)
  expect(Object.keys(repeated.builds)).toHaveLength(Object.keys(saved.builds).length + 1)
  expect(repeated.buildRevisions[checkpoint.id]).toEqual(checkpoint)
})

test('rejects malformed v5 snapshots without writing', async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const original = await storedData(page)
  await page.goto('/#/share/v5/AAA')
  await expect(page.getByText('Shared snapshot unavailable', { exact: true })).toBeVisible()
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
  const baseSetup = data.gameSetups[data.planningGameSetupRevisionId!]!
  // Native fixtures retain exact source receipts so unavailable content stays recoverable on import
  const setup = { ...baseSetup, modSourceReceipts: modSourceReceipts(baseSetup, catalogs) }
  data = { ...data, gameSetups: { ...data.gameSetups, [setup.id]: setup } }
  const buildId = asId<BuildId>('portable-build')
  data = createBuild(data, { id: buildId, title: 'Portable mod build', gameSetupId: setup.gameSetupId })
  const sourceRef = (entityId: EntityId) => ({ kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId })
  const classRef = sourceRef(Object.values(source.entities).find(entity => entity.kind === 'class')!.id)
  const passives = Object.values(source.entities).filter(entity => entity.kind === 'passive').map(entity => ({ ref: sourceRef(entity.id) }))
  const nativeRef = (id: string) => ({ kind: 'catalog' as const, catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: asId<EntityId>(id) })
  const content = buildContentForModSetup({ primaryClass: classRef, secondaryClass: nativeRef('base:job:2'), equipment: { 'plan-main-hand': { ref: nativeRef('base:equipment:41') }, 'plan-head': { ref: nativeRef('base:equipment:481') } }, passives, contextAssumptions: [] }, setup, catalogs)
  data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id, content })
  const prepared = await prepareModCatalogs(data, catalogs)
  let payload = createPublicSnapshot({ planner: { localData: data, catalogs: prepared } }, { kind: 'build', revisionId: data.builds[buildId]!.latestRevisionId! }, { includeNotes: false })
  if (historical) payload = JSON.parse(JSON.stringify(payload).replaceAll('library-v4', 'library-v2')) as PublicSnapshot
  return { text, source, payload, data }
}

async function installMissingModFixture(page: Page) {
  const fixture = await portableModFixture(true, true)
  await page.goto('/')
  await skipInitialModSetup(page)
  const before = await storedData(page)
  // The verified withdrawn baseline preserves unchanged native facts while mod definitions remain unavailable
  const historical = JSON.parse(JSON.stringify(fixture.data).replaceAll('library-v4', 'library-v2')) as LocalData
  const build = historical.builds[asId<BuildId>('portable-build')]!
  const revision = historical.buildRevisions[build.latestRevisionId!]!
  const setup = historical.gameSetups[revision.gameSetupRevisionId]!
  const { identityMappings: _mappings, ...composition } = setup.modComposition!
  const oldSetup = { ...setup, modComposition: { ...composition, version: 2 as const, baseline: { ...composition.baseline, catalogRevisionId: asId<CatalogRevisionId>('catalog-v1') } } }
  const native = { ...before, gameSetups: { ...before.gameSetups, ...historical.gameSetups, [setup.id]: oldSetup }, builds: { ...before.builds, ...historical.builds }, buildRevisions: { ...before.buildRevisions, ...historical.buildRevisions, [revision.id]: revision } }
  await replacePlannerFixture(page, native)
  await page.goto('/#/builds/library/portable-build')
  return fixture
}

for (const historical of [false, true]) test(`v5 mod receipts require viewer-owned matching content ${historical ? 'with explicit parser adaptation' : 'at current pins'}`, { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const { text, payload } = await portableModFixture(historical)
  const url = createPublicShareUrl(payload, `${baseURL}/`)
  for (const privateValue of ['Local-only description', 'original.json', 'data:image', 'blob:']) expect(JSON.stringify(payload)).not.toContain(privateValue)
  await page.goto(url)
  await expect(page.getByRole('heading', { name: 'Portable mod build', exact: true }).first()).toBeVisible()
  await openShareSources(page)
  const definitions = page.getByRole('region', { name: 'Your matching definitions', exact: true })
  const classDefinition = definitions.locator('details').filter({ has: page.locator('summary', { hasText: /^Synthetic Portable Class(?: · Unavailable)?$/ }) })
  await classDefinition.locator('summary').click()
  await expect(classDefinition.getByText('Definition unavailable. The saved name supplies no mechanics.', { exact: true })).toBeVisible()
  await expect(page.getByText('Calculations unavailable', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add matching files', exact: true }).click()
  const input = page.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true })
  const { localData: before, importCounts } = await storedShareState(page)
  await input.setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(text.replace('Synthetic Portable Class', 'Changed Class')) })
  await expect(page.getByText('This file does not match the saved project and content. Choose the exact shared source version.', { exact: true })).toBeVisible()
  await expectStoredShareUnchanged(page, before, importCounts)
  const reordered = JSON.stringify(JSON.parse(text), (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value, 2)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    Object.assign(window, { restoreModImportWrite: () => { IDBObjectStore.prototype.put = put } })
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'active' && this.transaction.db.name === 'crykit-guest-coordinator-v1') throw new DOMException('Synthetic mod import write failed', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  try {
    await input.setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: Buffer.from(reordered) })
    await expect(page.getByText('Shared view could not finish', { exact: true })).toBeVisible()
    await expectStoredShareUnchanged(page, before, importCounts)
  } finally {
    await page.evaluate(() => (window as unknown as { restoreModImportWrite: () => void }).restoreModImportWrite())
  }
  await input.setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: Buffer.from(reordered) })
  await expect(page.getByText('All selected definitions are available.', { exact: true })).toBeAttached()
  await openShareSources(page)
  await expect(page.getByText('All selected definitions are available.', { exact: true })).toBeVisible()
  if (historical) await expect(page.getByText('Adapted interpretation', { exact: true })).toBeVisible()
  if (await classDefinition.getAttribute('open') === null) await classDefinition.locator('summary').click()
  await expect(classDefinition.getByText('Local-only description', { exact: true })).toBeVisible()
  const imported = await storedData(page)
  expect(imported.playthroughs).toEqual(before.playthroughs)
  expect(imported.buildRevisions).toEqual(before.buildRevisions)
  await page.reload()
  await expect(page.getByText('All selected definitions are available.', { exact: true })).toBeAttached()
  await openShareSources(page)
  await expect(page.getByText('All selected definitions are available.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
  const saved = await storedData(page)
  const copy = Object.values(saved.builds).find(build => !imported.builds[build.id])!
  const checkpoint = saved.buildRevisions[copy.latestRevisionId!]!
  expect(checkpoint.publicSourceContext?.receipts).toEqual(payload.receipts)
  expect(saved.gameSetups[checkpoint.gameSetupRevisionId]!.publicSourceContext?.setup).toEqual(payload.setup)
  expect(JSON.stringify(checkpoint)).not.toMatch(/blob:|Local-only description|data:image/)
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toHaveCount(0)
})

test('missing display names block sharing while calculation locks offer local JSON recovery', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const { text } = await installMissingModFixture(page)
  const original = await storedData(page)
  const build = Object.values(original.builds).find(candidate => candidate.title === 'Portable mod build')!
  const checkpoint = original.buildRevisions[build.latestRevisionId!]!
  const primaryClass = { ...checkpoint.content.secondaryClass!, entityId: asId<EntityId>('base:job:0') }
  const content = { ...checkpoint.content, primaryClass, equipment: {}, passives: [], referenceNames: checkpoint.content.referenceNames?.filter(entry => entry.ref.entityId === 'base:job:2'), calculation: defaultCalculation(primaryClass) }
  await replacePlannerFixture(page, { ...original, buildRevisions: { ...original.buildRevisions, [checkpoint.id]: { ...checkpoint, content } } })
  await page.goto(`/#/builds/library/${build.id}`)
  const before = await storedData(page)
  const modFiles = page.getByRole('region', { name: 'Build mod files', exact: true })
  await expect(modFiles).toBeInViewport()
  await expect(modFiles).toContainText('Upload matching JSON for: Synthetic Portable Mod.')
  const explanation = 'Upload the matching mod JSON to show more item and skill details and enable calculations that need them. You can still view and share this build. Imported JSON is saved in this browser.'
  await expect(modFiles).toContainText(explanation)
  const disclosure = page.getByRole('region', { name: 'Build validity', exact: true }).locator('.build-validity__details')
  if (await disclosure.count()) await expect(disclosure).not.toHaveAttribute('open')
  await expect(page.getByRole('region', { name: 'Build validity', exact: true })).toContainText('No known loadout conflicts')
  await page.getByRole('button', { name: 'Share build', exact: true }).click()
  const sharing = page.getByRole('dialog', { name: 'Share build', exact: true })
  // Unknown catalog metadata is shareable, but the primary class has no saved display name here
  await expect(sharing.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled()
  await expect(sharing).toContainText('A selected entry needs its exact saved display receipt before sharing')
  await sharing.getByRole('button', { name: 'Close', exact: true }).click()
  await modFiles.getByRole('button', { name: 'Upload mod JSON', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Restore mod definitions', exact: true })
  await expect(dialog.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const stats = page.getByRole('region', { name: 'Calculated stats', exact: true })
  const lock = stats.getByRole('group', { name: 'Calculations need mod JSON', exact: true })
  await expect(lock).toBeVisible()
  expect(await lock.getByRole('button', { name: 'Upload mod JSON', exact: true }).evaluate(button => getComputedStyle(button).fontWeight)).toBe('400')
  await lock.getByRole('button', { name: 'Upload mod JSON', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Restore mod definitions', exact: true })
  await dialog.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true }).setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(dialog.getByRole('status')).toContainText('Matching definitions applied to this draft')
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(lock).toHaveCount(0)
  await expect(modFiles).toContainText('Matching JSON is available in this browser.')
  await expect(modFiles).not.toContainText(explanation)
  await expect(stats.getByRole('table', { name: 'Calculated character stats', exact: true })).toBeVisible()
  expect((await storedData(page)).buildRevisions).toEqual(before.buildRevisions)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('validity warnings restore missing mod definitions inside the editor without losing unsaved edits', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const { text } = await installMissingModFixture(page)
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === 'Portable mod build')!
  const checkpoint = before.buildRevisions[build.latestRevisionId!]!
  const validity = page.getByRole('region', { name: 'Build validity', exact: true })
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
  const dialog = page.getByRole('dialog', { name: 'Restore mod definitions', exact: true })
  const input = dialog.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true })
  const { importCounts: imports } = await storedShareState(page)
  await input.setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(text.replace('Synthetic Portable Class', 'Changed Class')) })
  await expect(dialog.getByText('This JSON does not match the saved mod content and project identity.', { exact: false })).toBeVisible()
  await expectStoredShareUnchanged(page, before, imports)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    // Fail the actual managed head publication without changing source preparation or owned draft input
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'active' && this.transaction.db.name === 'crykit-guest-coordinator-v1') { sessionStorage.setItem('synthetic-warning-fault-fired', 'true'); throw new DOMException('Synthetic warning import write failed', 'QuotaExceededError') }
      return put.apply(this, args)
    }
    ;(window as unknown as { restoreWarningImport: () => void }).restoreWarningImport = () => { IDBObjectStore.prototype.put = put }
  })
  await input.setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(dialog.getByText('Mod not imported', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('synthetic-warning-fault-fired'))).toBe('true')
  await expectStoredShareUnchanged(page, before, imports)
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

test('canceling a recovered source-only draft preserves the saved checkpoint', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const { text } = await installMissingModFixture(page)
  const before = await storedData(page)
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await page.getByRole('textbox', { name: 'Rotation or use notes', exact: true }).fill('Cancel this unsaved recovery note')
  const validity = page.getByRole('region', { name: 'Build validity', exact: true })
  await validity.locator('.build-validity__details > summary').click()
  await validity.getByRole('listitem').filter({ hasText: 'Dagger permission is unresolved' }).getByRole('button', { name: 'Upload mod JSON', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Restore mod definitions', exact: true })
  await dialog.getByLabel('Matching JSON for Synthetic Portable Mod', { exact: true }).setInputFiles({ name: 'matching.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(dialog.getByRole('status')).toContainText('Matching definitions applied to this draft')
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Rotation or use notes', exact: true })).toHaveValue('Cancel this unsaved recovery note')
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
  expect((await storedData(page)).buildRevisions).toEqual(before.buildRevisions)
  await page.reload()
  expect((await storedData(page)).buildRevisions).toEqual(before.buildRevisions)
})

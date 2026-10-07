import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { openCurrentGameSetup, openGameSetupSection, selectedPlaythrough, skipInitialModSetup } from '../e2e/local-data-helpers'
import { currentReferencePath } from '../e2e/reference-helpers'
import { CLASS_MAP_FIXTURES } from '../src/catalog/skill-maps.test-helpers'
import { QUINTAR_STEP } from '../src/catalog/quintar-breeding'
import type { LocalData } from '../src/domain/types'
import { createSaveEditorFixture } from '../src/domain/save-editor.fixture'
import { encodeCrystalSave } from '../src/interchange/crystal-save'
import { formatAppRoute, type PageRoute } from '../src/ui/navigation'

const SCREENS = JSON.parse(readFileSync(new URL('./ui-review-screens.json', import.meta.url), 'utf8')) as { readonly id: string; readonly label: string }[]
const SELECTED = new Set((process.env.CRYKIT_UI_REVIEW_SCREENS ?? '').split(','))
const DIRECTORY = process.env.CRYKIT_UI_REVIEW_DIRECTORY!

interface Capture { readonly device: string; readonly screen: string; readonly state: string; readonly description: string; readonly viewport: string; readonly fullContent: string }

async function settleArtwork(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].filter(image => image.getClientRects().length && image.loading !== 'lazy').map(image => image.decode().catch(() => undefined)))
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

async function fullContent(page: Page, path: string) {
  const scroller = page.locator('dialog[open] .sheet__body').last()
  const target = await scroller.count() ? scroller : page.locator('.main-shell')
  const previousScroll = await page.evaluate(() => ({ window: window.scrollY, main: document.querySelector('.main-shell')?.scrollTop ?? 0 }))
  const original = await target.evaluate(element => element.scrollTop)
  await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('.main-shell')?.scrollTo({ top: 0, behavior: 'instant' }) })
  await target.evaluate(element => { element.scrollTop = 0 })
  await settleArtwork(page)
  const firstViewport = await page.screenshot({ animations: 'disabled' })
  const geometry = await target.evaluate(element => {
    const box = element.getBoundingClientRect()
    const header = element.closest('dialog')?.querySelector('.sheet__header')
    const context = document.querySelector('.context-bar')
    const mobileHeader = document.querySelector('.mobile-header')
    const mobile = mobileHeader && mobileHeader.getClientRects().length > 0
    const top = Math.ceil(header ? header.getBoundingClientRect().bottom : mobile ? Math.max(mobileHeader.getBoundingClientRect().bottom, context?.getBoundingClientRect().bottom ?? 0) : box.top)
    // Avoid repeating the native dialog frame over content at every stitched body boundary
    const bottomInset = element.closest('dialog') ? 2 : 0
    return { top: Math.max(0, top), bottom: Math.floor(Math.min(window.innerHeight, box.bottom - bottomInset)), max: element.scrollHeight - element.clientHeight }
  })
  if (geometry.max <= 1 || geometry.bottom <= geometry.top) {
    await page.screenshot({ path, fullPage: true, animations: 'disabled' })
    await page.evaluate(scroll => { document.querySelector('.main-shell')?.scrollTo({ top: scroll.main, behavior: 'instant' }); window.scrollTo({ top: scroll.window, behavior: 'instant' }) }, previousScroll)
    await target.evaluate((element, value) => { element.scrollTop = value }, original)
    return
  }
  // Stitch actual scroll-region pixels instead of expanding CSS and changing the responsive layout
  const size = await sharp(firstViewport).metadata()
  const width = size.width!
  const height = size.height!
  const visibleHeight = geometry.bottom - geometry.top
  const pieces: { input: Buffer; top: number; left: number }[] = [{ input: await sharp(firstViewport).extract({ left: 0, top: 0, width, height: geometry.bottom }).toBuffer(), top: 0, left: 0 }]
  let combinedHeight = geometry.bottom
  let previous = 0
  try {
    await target.evaluate(element => { element.scrollTop = 0 })
    while (previous < geometry.max) {
      const next = Math.min(previous + visibleHeight, geometry.max)
      await target.evaluate((element, position) => { element.scrollTop = position }, next)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
      const pixels = await page.screenshot({ animations: 'disabled' })
      const actual = await target.evaluate(element => element.scrollTop)
      const delta = Math.round(actual - previous)
      if (delta <= 0) throw new Error('Scrollable content did not advance during full-content capture')
      const strip = await sharp(pixels).extract({ left: 0, top: geometry.bottom - delta, width, height: delta }).toBuffer()
      pieces.push({ input: strip, top: combinedHeight, left: 0 })
      combinedHeight += delta
      previous = actual
    }
    if (height > geometry.bottom) {
      pieces.push({ input: await sharp(firstViewport).extract({ left: 0, top: geometry.bottom, width, height: height - geometry.bottom }).toBuffer(), top: combinedHeight, left: 0 })
      combinedHeight += height - geometry.bottom
    }
    await sharp({ create: { width, height: combinedHeight, channels: 4, background: '#171d22' } }).composite(pieces).png().toFile(path)
  } finally {
    await page.evaluate(scroll => { document.querySelector('.main-shell')?.scrollTo({ top: scroll.main, behavior: 'instant' }); window.scrollTo({ top: scroll.window, behavior: 'instant' }) }, previousScroll)
    await target.evaluate((element, value) => { element.scrollTop = value }, original)
  }
}

async function capture(page: Page, device: string, screen: string, state: string, description: string, captures: Capture[]) {
  if (captures.length === 0) await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('.main-shell')?.scrollTo({ top: 0, behavior: 'instant' }) })
  await settleArtwork(page)
  const prefix = `${device}--${screen}--${String(captures.length + 1).padStart(2, '0')}-${state}`
  const viewport = `${prefix}--viewport.png`
  const full = `${prefix}--full-content.png`
  await page.screenshot({ path: join(DIRECTORY, viewport), animations: 'disabled' })
  await fullContent(page, join(DIRECTORY, full))
  captures.push({ device, screen, state, description, viewport, fullContent: full })
}

async function localData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction('localDatas').objectStore('localDatas').get('local-data-record')
      read.onerror = () => { database.close(); reject(read.error) }
      read.onsuccess = () => { database.close(); resolve(read.result.localData) }
    }
  }))
}

async function openPage(page: Page, route: PageRoute) {
  await page.goto(formatAppRoute({ page: route, overlays: [], query: {} }))
}

async function settings(page: Page, section: 'data' | 'history' | 'playthrough') {
  await openPage(page, { page: 'settings', section })
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(panel).toBeVisible()
  return panel
}

async function syntheticSkillImage(page: Page, characterName: string): Promise<Buffer> {
  const fixture = CLASS_MAP_FIXTURES.find(fixture => fixture.className.toLowerCase() === 'warrior')!
  const image = await page.evaluate(({ characterName, squares }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1280; canvas.height = 720
    const context = canvas.getContext('2d')!
    context.fillStyle = '#1f252b'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#fafafa'; context.font = '20px Arial'
    context.fillText('Learn', 134, 110); context.fillText(characterName, 490, 60); context.fillText('Warrior', 305, 229)
    context.fillRect(624, 211, 1, 18)
    for (const [index, [row, column]] of squares.entries()) {
      const x = 670 + column * 64
      const y = 222 + row * 64
      context.fillStyle = index === 1 || index === 4 ? '#c0bb28' : '#425059'
      context.fillRect(x, y, 40, 1); context.fillRect(x, y, 1, 40); context.fillRect(x + 39, y, 1, 40); context.fillRect(x, y + 39, 40, 1)
    }
    return canvas.toDataURL('image/png')
  }, { characterName, squares: fixture.squares })
  return Buffer.from(image.split(',')[1]!, 'base64')
}

async function scenario(page: Page, screen: string, shot: (state: string, description: string) => Promise<void>) {
  const data = await localData(page)
  const build = Object.values(data.builds)[0]!
  const team = Object.values(data.teams)[0]!
  const character = Object.values(selectedPlaythrough(data).characters)[0]!
  if (screen === 'builds') {
    await openPage(page, { page: 'builds', view: 'library' })
    await page.getByRole('checkbox', { name: 'Show sample Builds', exact: true }).check()
    await expect(page.locator('.build-card').first()).toBeVisible()
    await shot('sample-library', 'Nonempty synthetic Build library with native equipment artwork')
    await openPage(page, { page: 'builds', view: 'build', buildId: build.id })
    await expect(page.getByRole('heading', { name: build.title, exact: true })).toBeVisible()
    await shot('saved-editor', 'Saved Build checkpoint, equipped slots, and accessible header actions')
    await page.getByRole('button', { name: 'Jump to stats and growth', exact: true }).click()
    await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Calculation context', exact: true })).toBeVisible()
    await shot('calculation-context', 'Calculated totals with their resting or battle context and balance assumptions')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByRole('textbox', { name: 'Build title', exact: true }).fill('Synthetic Build title draft')
    await shot('inline-title', 'Inline title editing keeps the loaded Build and pending metadata visible')
    await page.evaluate(() => { document.querySelector('.main-shell')?.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }); window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }) })
    await page.getByRole('button', { name: 'Teams', exact: true }).filter({ visible: true }).click()
    const notice = page.getByRole('region', { name: 'Resolve unsaved edits', exact: true })
    await expect(notice).toBeFocused()
    await expect(notice.getByRole('button', { name: 'Save and continue', exact: true })).toBeEnabled()
    await expect(notice.getByRole('button', { name: 'Discard and continue', exact: true })).toBeEnabled()
    await expect(page.getByRole('textbox', { name: 'Build title', exact: true })).toHaveValue('Synthetic Build title draft')
    await shot('blocked-navigation', 'Leaving a deep unsaved Build reveals visible save and discard choices while retaining its title and loadout draft')
    return
  }
  if (screen === 'teams') {
    await openPage(page, { page: 'teams', view: 'team', teamId: team.id })
    await expect(page.getByRole('heading', { name: team.title, exact: true })).toBeVisible()
    await shot('saved-overview', 'Four synthetic saved Build checkpoints with their classes and equipment')
    await page.getByRole('button', { name: 'Edit Team', exact: true }).click()
    await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic Team edit')
    await shot('team-editor', 'Team title and occupied member slots with save and discard actions')
    return
  }
  if (screen === 'inventory') {
    await openPage(page, { page: 'inventory', view: 'list' })
    await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
    await shot('observations', 'Synthetic owned stock with explicit quantities and provenance')
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
    await panel.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
    await panel.getByRole('textbox', { name: 'Item name', exact: true }).fill('Synthetic unknown stock')
    await shot('unknown-stock-entry', 'Unlisted synthetic item entry preserves unknown possession and quantity')
    return
  }
  if (screen === 'characters') {
    await openPage(page, { page: 'characters', view: 'list' })
    await expect(page.getByRole('heading', { name: 'Characters', exact: true })).toBeVisible()
    await expect(page.getByRole('article', { name: character.name, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Party plans & readiness', exact: true })).toBeVisible()
    await shot('character-roster', 'Synthetic character roster with recorded equipment, explicit unknowns, and member and party actions')
    await openPage(page, { page: 'characters', view: 'character', characterId: character.id, tab: 'current' })
    await expect(page.getByRole('heading', { name: character.name, exact: true })).toBeVisible()
    await shot('current-snapshot', 'Synthetic tracked character with recorded classes, equipment, and unknown totals')
    await page.getByRole('button', { name: 'Capture snapshot', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
    await panel.getByLabel('Snapshot note', { exact: true }).fill('Synthetic review snapshot; no observed totals entered')
    await shot('snapshot-editor', 'Snapshot form keeps unknown levels and totals explicit until observed')
    return
  }
  if (screen === 'progress') {
    for (const [view, state, description] of [
      ['list', 'class-seals', 'Class-seal progress is independent of character learning'],
      ['unlocks', 'travel-unlocks', 'Travel and unlock tiles show tracked observations and unknown states'],
      ['summons', 'summons', 'Summon collection tiles expose immediate progress controls'],
    ] as const) {
      await openPage(page, { page: 'progress', view })
      await expect(page.getByRole('navigation', { name: 'Progress guides', exact: true })).toBeVisible()
      await shot(state, description)
    }
    return
  }
  if (screen === 'quintar') {
    await openPage(page, { page: 'progress', view: 'quintar' })
    await expect(page.getByRole('heading', { name: 'Quintar breeding', exact: true })).toBeVisible()
    await shot('next-step', 'Next unmarked step, race requirements, and parent instructions are visible')
    const tile = page.locator(`[data-step="${QUINTAR_STEP.fancyHighland}"]`)
    const instructions = tile.locator('.quintar-tile__instructions')
    if (await instructions.count() && await instructions.getAttribute('open') === null) await instructions.locator('summary').click()
    await tile.scrollIntoViewIfNeeded()
    await shot('breeding-requirements', 'A breeding step shows required pair, race wins, and keep or release instructions')
    return
  }
  if (screen === 'reference') {
    await openPage(page, { page: 'reference', view: 'list' })
    await page.getByRole('searchbox', { name: 'Search reference', exact: true }).fill('Potion')
    await expect(page.locator('.reference-card').first()).toBeVisible()
    await shot('filtered-results', 'Nonempty native Reference results with helpful artwork and definition types')
    await page.goto(currentReferencePath('base:equipment:160'))
    await expect(page.getByRole('heading', { name: 'Artisan Rapier', exact: true })).toBeVisible()
    await shot('equipment-details', 'Native equipment facts, requirements, source scope, and related information')
    return
  }
  if (screen === 'mods') {
    await openPage(page, { page: 'mods', view: 'library' })
    await expect(page.locator('.mod-library__card').first()).toBeVisible()
    await shot('library', 'Bundled mod sources and visible actions without requiring Reference membership')
    await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Cheat Passives')
    const card = page.getByRole('region', { name: 'Cheat Passives', exact: true })
    const versions = card.locator('.mod-library__versions')
    if (await versions.count() && await versions.getAttribute('open') === null) await versions.locator('summary').click()
    await shot('source-version', 'A bundled mod source, exact version, and available library actions')
    await card.getByRole('button', { name: 'Add to Reference', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Remove from Reference', exact: true })).toBeEnabled()
    await shot('reference-membership', 'Source loaded and added to Reference with visible action feedback')
    return
  }
  if (screen === 'map') {
    await openPage(page, { page: 'map' })
    await expect(page.getByRole('region', { name: 'Interactive world map', exact: true })).toBeVisible()
    await expect.poll(() => page.locator('.world-map-terrain img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    await shot('overworld', 'Local native terrain, source preview, search, and marker filters')
    await page.getByRole('searchbox', { name: 'Search map', exact: true }).fill('Knockout Stick Sara Sara Bazaar')
    await page.getByRole('button', { name: 'Show Knockout Stick on map', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Map location details', exact: true })).toBeVisible()
    await shot('location-details', 'A native location with exact coordinates and contextual item information')
    return
  }
  if (screen === 'backup') {
    const panel = await settings(page, 'data')
    await shot('backup-tools', 'Backup export and import actions with their scope explained')
    const pending = page.waitForEvent('download')
    await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
    const file = await (await pending).path()
    if (!file) throw new Error('Synthetic backup download was unavailable')
    await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-ui-review.zip', mimeType: 'application/zip', buffer: await readFile(file) })
    await expect(panel.getByText('Import preview', { exact: true })).toBeVisible()
    await shot('native-preview', 'Synthetic backup preview exposes record counts, replacement consequences, and confirmation')
    await panel.getByText('File details and source notices', { exact: true }).click()
    await shot('source-notices', 'Import format, source notices, and technical identity details are available for review')
    return
  }
  if (screen === 'history') {
    await openPage(page, { page: 'inventory', view: 'new' })
    const entry = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
    await entry.getByRole('button', { name: 'Enter an unlisted item', exact: true }).click()
    await entry.getByRole('textbox', { name: 'Item name', exact: true }).fill('Synthetic history observation')
    await entry.getByRole('button', { name: 'Add item', exact: true }).click()
    await expect(entry).not.toBeVisible()
    const panel = await settings(page, 'history')
    await expect(panel.locator('.history-entry').first()).toBeVisible()
    await shot('saved-changes', 'Nonempty synthetic History with plain action labels and Undo controls')
    await panel.locator('.history-entry__details').first().locator('summary').click()
    await shot('revision-details', 'Technical command and affected paths are available with revision details')
    return
  }
  if (screen === 'game-setup') {
    const panel = await settings(page, 'playthrough')
    await openCurrentGameSetup(panel)
    await shot('saved-context', 'Saved Game Setup with its exact game version and context fields')
    await openGameSetupSection(panel, 'Rules from game data')
    await shot('rules', 'Game Setup rules and supported calculations are expanded for review')
    return
  }
  if (screen === 'mod-editor') {
    await openPage(page, { page: 'mods', view: 'editor' })
    const source = JSON.stringify({ EditorVersion: 34, Title: 'Synthetic UI review mod', Passives: [{ ID: 91000, Name: 'Synthetic sight', StatMods: [{ Tag: 477, Value1: 0, Value2: 0, Value3: 0 }] }], Abilities: [{ ID: 92000, Name: 'Synthetic action' }], Jobs: [{ ID: 93000, Name: 'Synthetic job', AbilityIDs: [92000] }] }, null, 2)
    await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'synthetic-ui-review.json', mimeType: 'application/json', buffer: Buffer.from(source) })
    await expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible()
    await shot('loaded-source', 'Synthetic mod JSON loaded with document tree and editing workflow')
    await page.getByLabel('Search keys, values, and decoded names', { exact: true }).fill('$.Title')
    await page.locator('.inspector-search-result').filter({ has: page.locator('code', { hasText: /^\$\.Title$/ }) }).click()
    await page.getByRole('textbox', { name: /^Exact JSON value/ }).fill('"Synthetic reviewed draft"')
    await shot('pending-json-edit', 'Exact selected JSON value is edited before applying to the saved tool draft')
    await page.getByRole('button', { name: 'Apply JSON edit', exact: true }).click()
    await expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Review export', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Export review', exact: true })).toBeVisible()
    await shot('export-review', 'Original-to-draft change review is visible before downloading a separate mod file')
    return
  }
  if (screen === 'screenshot-learning') {
    await openPage(page, { page: 'characters', view: 'character', characterId: character.id, tab: 'current' })
    await page.getByRole('button', { name: 'Import skill screenshots', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Import skill screenshots', exact: true })
    await shot('upload-scope', 'Local upload workflow with class-map choice and exact matching scope before parsing')
    const buffer = await syntheticSkillImage(page, character.name)
    await panel.getByLabel('Skill screenshots', { exact: true }).setInputFiles({ name: 'synthetic-warrior-menu.png', mimeType: 'image/png', buffer })
    await expect(panel.getByLabel('Screenshot to review', { exact: true })).toBeVisible()
    await panel.getByLabel('Screenshot character', { exact: true }).selectOption(character.id)
    const classChoice = panel.getByLabel('Screenshot class', { exact: true })
    const option = classChoice.locator('option').filter({ hasText: /^Warrior(?:$|\s)/ }).first()
    await classChoice.selectOption((await option.getAttribute('value'))!)
    await expect(panel.getByRole('group', { name: 'Detected skill squares', exact: true }).getByRole('button').first()).toBeVisible()
    await shot('synthetic-review', 'Synthetic Learn-menu squares, matched character and class, and labeled learning states')
    return
  }
  if (screen === 'search') {
    await page.getByRole('button', { name: /^(Search|Search planner)$/ }).filter({ visible: true }).click()
    const panel = page.getByRole('dialog', { name: 'Search CryKit', exact: true })
    await panel.getByRole('searchbox').fill('Potion')
    await expect(panel.getByRole('button', { name: /Potion/ }).first()).toBeVisible()
    await shot('matching-results', 'Universal search presents nonempty native results with categories and artwork')
    return
  }
  if (screen === 'save-editor') {
    await page.goto('/#/save-editor')
    await expect(page.getByRole('button', { name: 'Choose a save file', exact: true })).toBeVisible()
    await shot('empty-editor', 'Save Editor introduces ordinary editing tasks before a file is opened')
    const challenge = createSaveEditorFixture()
    const challengeFlags = challenge.party.value.GameplayFlags
    if (challengeFlags?.type !== 'document') throw new Error('Synthetic save needs gameplay flags')
    challengeFlags.value.MaxLevelDown = { type: 'boolean', value: true }
    challengeFlags.value.MaxLevelDownVal = { type: 'int32', value: 59 }
    challengeFlags.value.NoAssistOptions = { type: 'boolean', value: true }
    await page.getByLabel('Open Crystal Project save', { exact: true }).setInputFiles({ name: 'synthetic-level-challenge.sav', mimeType: 'application/octet-stream', buffer: Buffer.from(encodeCrystalSave(challenge)) })
    await expect(page.getByRole('heading', { name: 'synthetic-level-challenge.sav', exact: true })).toBeVisible()
    await page.getByLabel('Member 1 level', { exact: true }).fill('60')
    await page.getByRole('button', { name: 'Apply name & level', exact: true }).click()
    const challengeError = page.getByText("This save's maximum-level challenge limits characters to level 59. Level 60 is not allowed.", { exact: true })
    await expect(challengeError).toBeVisible()
    await expect(challengeError).toBeInViewport()
    await expect(page.getByLabel('Save Editor error', { exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Apply name & level', exact: true }).click()
    await expect(challengeError).toBeInViewport()
    await expect(page.getByLabel('Save Editor error', { exact: true })).toBeFocused()
    await expect(page.getByLabel('Member 1 level', { exact: true })).toHaveValue('60')
    await expect(page.getByRole('button', { name: 'Export edited save', exact: true })).toBeDisabled()
    await shot('challenge-level-limit', 'A synthetic level-59 challenge rejects level 60 with the exact reason and retains pending input')
    await page.getByRole('button', { name: 'Discard pending input', exact: true }).click()
    await page.getByLabel('Open Crystal Project save', { exact: true }).setInputFiles({ name: 'synthetic-party.sav', mimeType: 'application/octet-stream', buffer: Buffer.from(encodeCrystalSave(createSaveEditorFixture())) })
    await expect(page.getByRole('heading', { name: 'synthetic-party.sav', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export edited save', exact: true })).toBeEnabled()
    await shot('loaded-party', 'Original synthetic save loaded; party and equipped loadouts are ready to inspect')
    await page.getByLabel('Member 1 name', { exact: true }).fill('Synthetic Hero')
    await shot('character-edit', 'Unapplied character name remains visible alongside its Apply action')
    await page.getByRole('button', { name: 'Apply name & level', exact: true }).click()
    await page.getByRole('button', { name: 'Clear Main hand', exact: true }).click()
    await shot('loadout-edit', 'Pending loadout choices remain in the party editor before review')
    await page.getByRole('button', { name: 'Review loadout changes', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Review bulk changes', exact: true })).toBeVisible()
    await shot('loadout-review', 'A cleared weapon is reviewed before changes enter the working copy')
    await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click()
    await page.getByLabel('Copper', { exact: true }).fill('456')
    await shot('money-edit', 'Pending currency input and its Apply action are visible in the loaded editor')
    await page.getByRole('button', { name: 'Apply currency', exact: true }).click()
    const appliedReview = page.locator('.save-editor__review')
    if (await appliedReview.count() && await appliedReview.getAttribute('open') === null) await appliedReview.locator('summary').click()
    await shot('draft-review', 'Reviewed character, loadout, and currency changes are listed before export')
    await page.getByRole('heading', { name: 'synthetic-party.sav', exact: true }).scrollIntoViewIfNeeded()
    await shot('file-details', 'File facts and original recovery controls are visible')
    await page.getByRole('button', { name: 'Unlocks & presets', exact: true }).click()
    await page.getByRole('heading', { name: 'Unlocks and presets', exact: true }).scrollIntoViewIfNeeded()
    await shot('bulk-actions', 'Bulk changes have equal visual weight, with the broad overpowered preset after narrower actions')
    return
  }
  throw new Error(`Capture scenario not implemented: ${screen}`)
}

for (const screen of SCREENS.filter(screen => SELECTED.has(screen.id))) test(screen.label, async ({ page, context, baseURL }, testInfo) => {
  const device = testInfo.project.name
  const captures: Capture[] = []
  const errors: string[] = []
  const blockedRequests: string[] = []
  const origin = new URL(baseURL!).origin
  page.on('pageerror', error => errors.push(error.message))
  // Fresh contexts have no personal browser storage; only the selected local app may receive requests
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (['data:', 'blob:'].includes(url.protocol) || url.origin === origin) await route.continue()
    else { blockedRequests.push(url.href); await route.abort('blockedbyclient') }
  })
  let error: string | undefined
  let image: string | undefined
  try {
    await page.goto('/')
    await skipInitialModSetup(page)
    await scenario(page, screen.id, (state, description) => capture(page, device, screen.id, state, description, captures))
    expect(blockedRequests, 'External requests are prohibited during synthetic UI review').toEqual([])
    expect(errors, 'UI review must not silently capture a crashed screen').toEqual([])
  } catch (reason) {
    error = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    image = `${device}--${screen.id}--failure.png`
    await page.screenshot({ path: join(DIRECTORY, image), animations: 'disabled' }).catch(() => { image = undefined })
    throw reason
  } finally {
    await writeFile(join(DIRECTORY, '.metadata', `${device}--${screen.id}.json`), `${JSON.stringify({ device, screen: screen.id, captures, error, image, blockedRequests }, null, 2)}\n`)
  }
})

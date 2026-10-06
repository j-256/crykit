import { openStatBreakdown } from './calculation-presentation-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'
import { createSharePayload, createShareUrl } from '../src/interchange/share'
import { NATIVE_DATA } from '../src/domain/calculation-rules'
import type { LocalData } from '../src/domain/types'
import bundledSources from '../src/catalog/bundled-mod-sources.json' with { type: 'json' }
import { CURRENT_CATALOG, DEFAULT_CATALOG, compileBundledSourceId } from '../src/catalog/bundled'
import { createSampleLocalData } from '../src/domain/sample-data'
import { createPersonalDefinition } from '../src/domain'
import { bundledModIdentity } from '../src/domain/bundled-mods'
import { CRYSTAL_PROJECT_WORKSHOP_URL } from '../src/domain/mod-workshop'
import { expectOfflineReady } from './offline-helpers'
import { openBuildGameSetup, openGameSetupSection } from './local-data-helpers'
import { referencePath } from './reference-helpers'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

async function includeObservedDoge(page: Page) {
  const card = page.getByRole('region', { name: 'Doge Shield', exact: true })
  await card.getByRole('button', { name: 'Add to Reference', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Remove from Reference', exact: true })).toBeVisible()
}

const MOD_ID = 'synthetic-editor-library'
const SOURCE = JSON.stringify({ ID: MOD_ID, Title: 'Synthetic calculation mod', Version: '1', EditorVersion: 34, System: { BattleConfig: { ...NATIVE_DATA.battleConfig, TwoHandedPAtkFlat: 80, StrWhileUnarmedBonusFlat: 60 } }, Passives: [{ ID: 9000, Name: 'Synthetic unarmed', PP: 1, IsInnate: false, IsLearnable: true, StatMods: [{ Tag: 474, Value1: 0, Value2: 0 }] }] })

test('mod cards separate Reference browsing from Game Setup state and secondary editing', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/mods')
  const card = page.getByRole('region', { name: 'Equipment Expansion', exact: true })
  await expect(card.getByRole('button', { name: 'View catalog entries', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Add to Reference', exact: true })).toBeVisible()
  await expect(card).toContainText('Not in Reference')
  await expect(card.getByText('Enabled status not recorded', { exact: true })).toHaveClass(/badge--neutral/)
  await expect(card.getByRole('button', { name: 'Edit mod JSON', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Add catalog entry', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Import updated version', exact: true })).toBeVisible()
  await expect(card.locator('.mod-library__identity').getByText('Bundled JSON', { exact: true })).toBeVisible()
  for (const name of ['Import mod', 'Open mod editor', 'Game Setups']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  const manual = page.getByRole('region', { name: 'Cheap Maps', exact: true })
  await expect(manual.getByText('Mod JSON unavailable', { exact: true })).toBeVisible()
  await expect(manual.getByRole('button', { name: 'Add catalog entry', exact: true })).toBeEnabled()
  expect(await manual.getByRole('button', { name: 'Add catalog entry', exact: true }).evaluate(element => element.closest('details'))).toBeNull()
  await expect(page.getByText('Add to Reference controls browsing.', { exact: false })).toBeVisible()
  await card.locator('.mod-library__versions > summary').click()
  await expect(card).toContainText('Bundled JSON')
  await expect(card.getByRole('button', { name: 'Edit bundled copy', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('temporary mod details retain reporting without publishing or editing the catalog', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/mods')
  const before = await storedData(page)
  const card = page.getByRole('region', { name: 'Doge Shield', exact: true })
  await card.getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Doge Shield', exact: true }) }).click()
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  const actions = page.getByRole('dialog', { name: 'Reference actions', exact: true })
  await expect(actions.getByRole('link', { name: 'Report a data issue', exact: true })).toHaveAttribute('href', 'https://github.com/j-256/crykit/issues')
  await expect(actions.getByRole('button', { name: 'Collect into Game Setup revision', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(actions).toHaveCount(0)
  expect(await storedData(page)).toEqual(before)
})

test('upgrades a historical browser profile before Reference changes and a new build save', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const before = createSampleLocalData(DEFAULT_CATALOG)
  const canonical = createPersonalDefinition(before, { name: 'Synthetic retained definition', kind: 'item' })
  const legacyIds = ['base:class:warrior', 'base:class:cleric', 'base:class:rogue', 'base:class:wizard', 'base:item:short-sword', 'base:item:buckler', 'base:item:breastplate', 'base:item:short-staff', 'base:item:hemp-robe', 'base:item:dirk', 'base:item:leather-outfit', 'base:item:oak-wand']
  const historical = (data: LocalData): LocalData => {
    let json = JSON.stringify(data)
    for (const id of legacyIds) json = json.replaceAll(compileBundledSourceId(id), id)
    return JSON.parse(json) as LocalData
  }
  await page.goto('/icon.svg')
  await page.evaluate(({ beforeText, afterText }) => new Promise<void>((resolve, reject) => {
    const before = JSON.parse(beforeText) as LocalData
    const after = JSON.parse(afterText) as LocalData
    const HISTORICAL_NATIVE_DATABASE_VERSION = 40
    const request = indexedDB.open('crykit', HISTORICAL_NATIVE_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const schemas: Record<string, string[]> = { localDatas: ['id', 'revision', 'updatedAt'], catalogs: ['key', 'id', 'revisionId', 'checksum'], evidence: ['id', 'sourceDigest', 'group'], sources: ['id', 'digest', 'format'], history: ['id', 'localDataId', '[localDataId+nextRevision]'], imports: ['id', 'sourceDigest', 'localDataId'], meta: ['key'] }
      for (const [name, [keyPath, ...indexes]] of Object.entries(schemas)) {
        const store = request.result.createObjectStore(name, { keyPath })
        for (const index of indexes) store.createIndex(index, index === '[localDataId+nextRevision]' ? ['localDataId', 'nextRevision'] : index)
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(['localDatas', 'history'], 'readwrite')
      transaction.objectStore('localDatas').put({ id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: after, lineage: { rootLocalDataId: before.id } })
      transaction.objectStore('history').put({ id: 'synthetic-historical-save', localDataId: before.id, command: 'save', previousRevision: before.revision, nextRevision: after.revision, before, after, recordedAt: after.updatedAt })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }), { beforeText: JSON.stringify(historical(before)), afterText: JSON.stringify(historical(canonical)) })
  await page.goto('/#/mods')
  await expect(page.getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(canonical)
  const archive = await archiveDigests(page)
  for (const title of ['Doge Shield', ...['Moonlight', 'Apotheosis'].map(prefix => bundledSources.mods.find(mod => mod.title.startsWith(prefix))!.title)]) {
    const card = page.getByRole('region', { name: title, exact: true })
    const toggle = card.getByRole('button', { name: /^(Add to Reference|Remove from Reference)$/ })
    const included = await toggle.getAttribute('aria-pressed') === 'true'
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', String(!included))
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', String(included))
  }
  const afterToggles = await storedData(page)
  expect(afterToggles.buildRevisions).toEqual(canonical.buildRevisions)
  expect(afterToggles.playthroughs).toEqual(canonical.playthroughs)
  expect(afterToggles.gameSetups).toEqual(canonical.gameSetups)
  expect(await archiveDigests(page)).not.toEqual(archive)
  await page.goto('/#/builds/library/new')
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Warrior')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option', { name: /^Warrior Class ·/ }).click()
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
  const saved = await storedData(page)
  for (const [id, revision] of Object.entries(canonical.buildRevisions)) expect(saved.buildRevisions[id]).toEqual(revision)
  expect(saved.playthroughs).toEqual(canonical.playthroughs)
  expect(saved.personalDefinitions).toEqual(canonical.personalDefinitions)
  await expect(page.getByRole('alert').filter({ hasText: 'Change not saved' })).toHaveCount(0)
})

test('Reference save failures stay visible beside the action and retry without changing other records', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/mods')
  await includeObservedDoge(page)
  const card = page.getByRole('region', { name: 'Doge Shield', exact: true })
  const toggle = card.getByRole('button', { name: 'Remove from Reference', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const before = await storedData(page)
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.name === 'history' && this.transaction.db.name === 'crykit') { IDBObjectStore.prototype.add = add; throw new DOMException('Synthetic Reference save failure', 'QuotaExceededError') }
      return add.apply(this, args)
    }
  })
  await toggle.click()
  const alert = card.getByRole('alert')
  const globalAlert = page.locator('.global-save-alert')
  await expect(alert).toContainText('Reference not changed')
  await expect(alert).toContainText('Browser storage is full')
  await expect(alert).toContainText(/Error code storage-failure; diagnostic [\w-]+/)
  await expect(globalAlert).toContainText('Change not saved')
  expect(await storedData(page)).toEqual(before)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const expectUnobscuredFailure = async () => {
    await expect.poll(async () => {
      const local = (await alert.boundingBox())!
      const global = (await globalAlert.boundingBox())!
      const bottom = await page.evaluate(() => {
        const nav = document.querySelector('.bottom-nav')
        return nav?.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight
      })
      return local.y >= global.y + global.height && local.y + local.height <= bottom
    }).toBe(true)
  }
  await expectUnobscuredFailure()
  if (test.info().project.name === 'mobile') {
    const originalViewport = page.viewportSize()!
    await page.setViewportSize({ width: 360, height: 1000 })
    await expectUnobscuredFailure()
    await page.setViewportSize(originalViewport)
    await expectUnobscuredFailure()
  }
  await card.getByRole('button', { name: 'Retry Reference change', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Add to Reference', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(alert).toHaveCount(0)
  await expect(globalAlert).toHaveCount(0)
  const after = await storedData(page)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.gameSetups).toEqual(before.gameSetups)
  expect(after.playthroughs).toEqual(before.playthroughs)
})

test('a rolled-back save alert stays on screen while scrolling and can be dismissed independently', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/mods')
  await includeObservedDoge(page)
  const card = page.getByRole('region', { name: 'Doge Shield', exact: true })
  await expect(card.getByRole('button', { name: 'Remove from Reference', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.name === 'history' && this.transaction.db.name === 'crykit') { IDBObjectStore.prototype.add = add; throw new DOMException('Synthetic persistent alert failure', 'QuotaExceededError') }
      return add.apply(this, args)
    }
  })
  await card.getByRole('button', { name: 'Remove from Reference', exact: true }).click()
  const globalAlert = page.locator('.global-save-alert')
  await expect(globalAlert).toContainText('Change not saved')
  await page.getByRole('region', { name: bundledSources.mods.find(mod => mod.title.startsWith('Moonlight'))!.title, exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }))
  await expect.poll(async () => {
    const box = (await globalAlert.boundingBox())!
    const visible = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-nav')
      return { top: document.querySelector('.context-bar')!.getBoundingClientRect().bottom, bottom: nav?.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight }
    })
    return box.y >= visible.top && box.y + box.height <= visible.bottom
  }).toBe(true)
  await globalAlert.getByRole('button', { name: 'Dismiss save alert', exact: true }).click()
  await expect(globalAlert).toHaveCount(0)
  await expect(card.getByRole('alert')).toContainText('Reference not changed')
  await card.getByRole('button', { name: 'Retry Reference change', exact: true }).click()
  await expect(card.getByRole('alert')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Add to Reference', exact: true })).toBeVisible()
})

test('every Reference toggle confirms the saved result on its own card, including archived sources', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/mods')
  await expect(page.getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
  const before = await storedData(page)
  for (const title of ['Doge Shield', ...['Moonlight', 'Apotheosis'].map(prefix => bundledSources.mods.find(mod => mod.title.startsWith(prefix))!.title)]) {
    const card = page.getByRole('region', { name: title, exact: true })
    const toggle = card.getByRole('button', { name: /^(Add to Reference|Remove from Reference)$/ })
    for (let change = 0; change < 3; change += 1) {
      const included = await toggle.getAttribute('aria-pressed') === 'true'
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-pressed', String(!included))
      const confirmation = card.getByRole('status').filter({ hasText: included ? 'Removed from Reference' : 'Added to Reference' })
      await expect(confirmation).toBeVisible()
      await expect.poll(async () => {
        const box = (await confirmation.boundingBox())!
        const visible = await page.evaluate(() => {
          const nav = document.querySelector('.bottom-nav')
          return { top: document.querySelector('.context-bar')!.getBoundingClientRect().bottom, bottom: nav?.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight }
        })
        return box.y >= visible.top && box.y + box.height <= visible.bottom
      }).toBe(true)
    }
  }
  const after = await storedData(page)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.gameSetups).toEqual(before.gameSetups)
  expect(after.playthroughs).toEqual(before.playthroughs)
  await expect(page.getByText('Mod revision saved to CryKit', { exact: true })).toHaveCount(0)
})

test('Reference retry retains the requested membership after another tab completes the change', async ({ page, context }) => {
  await page.goto('/#/mods')
  await includeObservedDoge(page)
  const card = page.getByRole('region', { name: 'Doge Shield', exact: true })
  await expect(card.getByRole('button', { name: 'Remove from Reference', exact: true })).toBeVisible()
  const other = await context.newPage()
  await other.goto('/#/mods')
  await expect(other.getByRole('region', { name: 'Doge Shield', exact: true }).getByRole('button', { name: 'Remove from Reference', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.name === 'history' && this.transaction.db.name === 'crykit') { IDBObjectStore.prototype.add = add; throw new DOMException('Synthetic Reference retry failure', 'QuotaExceededError') }
      return add.apply(this, args)
    }
  })
  await card.getByRole('button', { name: 'Remove from Reference', exact: true }).click()
  await expect(card.getByRole('alert')).toContainText('Reference not changed')
  await other.getByRole('region', { name: 'Doge Shield', exact: true }).getByRole('button', { name: 'Remove from Reference', exact: true }).click()
  await expect(other.getByRole('region', { name: 'Doge Shield', exact: true }).getByRole('button', { name: 'Add to Reference', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss save alert', exact: true }).click()
  await page.getByRole('button', { name: 'Load newer revision', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Add to Reference', exact: true })).toBeVisible()
  const loaded = await storedData(page)
  await card.getByRole('button', { name: 'Retry Reference change', exact: true }).click()
  await expect(card.getByRole('status')).toContainText('Removed from Reference')
  await expect(card.getByRole('button', { name: 'Add to Reference', exact: true })).toHaveAttribute('aria-pressed', 'false')
  expect(await storedData(page)).toEqual(loaded)
})

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

async function archiveDigests(page: Page): Promise<Readonly<Record<string, string>>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('crykit')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    try {
      const entries = await Promise.all(Array.from(database.objectStoreNames).map(async name => {
        const records = await new Promise<unknown[]>((resolve, reject) => {
          const request = database.transaction(name, 'readonly').objectStore(name).getAll()
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(records)))
        return [name, Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')] as const
      }))
      return Object.fromEntries(entries)
    } finally { database.close() }
  })
}

async function openDraft(page: Page, source = SOURCE) {
  await page.goto('/#/mods/editor')
  await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'synthetic-library.json', mimeType: 'application/json', buffer: Buffer.from(source) })
  await expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible()
}

test('saves editor revisions into Mods, derives rules, and preserves pinned build settings', async ({ page, baseURL }) => {
  await openDraft(page)
  const before = await storedData(page)
  await page.getByRole('button', { name: 'Save to CryKit', exact: true }).click()
  await expect(page.getByText('Mod revision saved to CryKit', { exact: true })).toBeVisible()
  const first = await storedData(page)
  expect(first.gameSetups).toEqual(before.gameSetups)
  expect(first.playthroughs).toEqual(before.playthroughs)
  await page.getByRole('button', { name: 'Save to CryKit', exact: true }).click()
  await expect(page.getByText('This mod revision is already saved', { exact: true })).toBeVisible()
  expect((await storedData(page)).revision).toBe(first.revision)
  await page.getByRole('tab', { name: 'Mod Library', exact: true }).click()
  const mod = page.getByRole('region', { name: 'Synthetic calculation mod', exact: true })
  await expect(mod).toContainText('Version 1')
  await page.goto('/#/builds/library/new')
  await openBuildGameSetup(page)
  await page.getByRole('combobox', { name: 'Game version', exact: true }).selectOption('1.6.9')
  await page.getByRole('combobox', { name: 'Difficulty', exact: true }).selectOption('0')
  await page.locator('.game-setup-base-details > summary').click()
  await page.getByRole('combobox', { name: 'Game mode', exact: true }).selectOption('Vanilla')
  await page.locator('.game-setup-mods > summary').click()
  await page.getByText('Add another mod', { exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search available mods', exact: true }).fill('Synthetic calculation mod')
  const buildMod = page.getByRole('region', { name: 'Mod Synthetic calculation mod', exact: true })
  await expect(buildMod.getByRole('combobox', { name: 'Version of Synthetic calculation mod', exact: true }).locator('option:checked')).toHaveText('1 · saved · format 34')
  await buildMod.getByRole('button', { name: 'Enable Synthetic calculation mod for this build', exact: true }).click()
  await page.locator('.game-setup-derived > summary').click()
  await expect(page.locator('.game-setup-derived')).toContainText('TwoHandedPAtkFlat')
  await expect(page.locator('.game-setup-derived')).toContainText('80')
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Warrior')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: /^Warrior$/ }) }).click()
  await expect(page.getByText('Balance mode: vanilla · from Game Setup', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'PC balance mode', exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Equipped passive 1', exact: true }).fill('Synthetic unarmed')
  await page.getByRole('listbox', { name: 'Choose Equipped passive 1', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Synthetic unarmed$/ }) }).click()
  await page.getByRole('combobox', { name: 'Calculation gender', exact: true }).selectOption('male')
  await openStatBreakdown(page)
  const strength = page.getByRole('table', { name: 'Planned build stats', exact: true }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Strength', exact: true }) })
  await expect(strength.getByRole('cell').nth(1)).toHaveText('+60')
  const total = await strength.getByRole('cell').last().innerText()
  const detailedStrength = page.getByRole('table', { name: 'Calculated character stats', exact: true }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Strength', exact: true }) })
  await expect(detailedStrength.getByRole('cell').first()).toHaveText(total)
  await page.getByLabel('Build title').fill('Synthetic pinned rules')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic pinned rules', exact: true })).toBeVisible()
  const pinned = await storedData(page)
  await page.goto('/#/mods')
  await mod.getByRole('button', { name: 'Edit mod JSON', exact: true }).click()
  await expect(page).toHaveURL(/#\/mods\/editor\?draft=/)
  await expect(page.getByRole('region', { name: 'Current file', exact: true })).toContainText('Original file')
  await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
  await page.getByRole('textbox', { name: /^Exact JSON value/ }).fill(SOURCE.replace('"Version":"1"', '"Version":"2"').replace('"TwoHandedPAtkFlat":80', '"TwoHandedPAtkFlat":90').replace('"StrWhileUnarmedBonusFlat":60', '"StrWhileUnarmedBonusFlat":90'))
  await expect(page.getByRole('button', { name: 'Save to CryKit', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Apply JSON edit', exact: true }).click()
  await expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save to CryKit', exact: true }).click()
  await expect(page.getByText('Mod revision saved to CryKit', { exact: true })).toBeVisible()
  const after = await storedData(page)
  expect(after.gameSetups).toEqual(pinned.gameSetups)
  expect(after.buildRevisions).toEqual(pinned.buildRevisions)
  expect(after.playthroughs).toEqual(pinned.playthroughs)
  await page.getByRole('tab', { name: 'Mod Library', exact: true }).click()
  await expect(mod).toContainText('Version 2')
  await mod.getByText('Versions', { exact: true }).click()
  await expect(mod).toContainText('Version 1')
  await page.reload()
  await expect(mod).toContainText('Version 2')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const build = Object.values(pinned.builds).find(build => build.title === 'Synthetic pinned rules')!
  await page.goto(createShareUrl(createSharePayload(pinned, { kind: 'build', revisionId: build.latestRevisionId! }), `${baseURL}/`))
  await expect(page.getByRole('heading', { name: 'Synthetic pinned rules', exact: true }).first()).toBeVisible()
  await expect(strength.getByRole('cell').nth(1)).toHaveText('+60')
  await expect(strength.getByRole('cell').last()).toHaveText(total)
  await expect(detailedStrength.getByRole('cell').first()).toHaveText(total)
  await expect(page.getByText('Gender: Male', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Shared build loadout', exact: true }).locator('input, select, textarea')).toHaveCount(0)
  await page.goto(`/#/builds/library/${build.id}`)
  await expect(strength.getByRole('cell').nth(1)).toHaveText('+60')
  await page.locator('.build-behavior > summary').click()
  await openGameSetupSection(page.locator('.build-behavior'), 'Mods')
  const version = buildMod.getByRole('combobox', { name: 'Version of Synthetic calculation mod', exact: true })
  await expect(version.locator('option:checked')).toHaveText('1 · saved · format 34')
  await version.selectOption({ label: '2 · saved · format 34' })
  await buildMod.getByRole('button', { name: 'Use selected version of Synthetic calculation mod', exact: true }).click()
  await expect(strength.getByRole('cell').nth(1)).toHaveText('+90')
  expect((await storedData(page)).gameSetups).toEqual(after.gameSetups)
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByRole('combobox', { name: /^Editor checkpoint/ }).locator('option:checked')).toContainText('r2')
  const revised = await storedData(page)
  expect(revised.playthroughs).toEqual(pinned.playthroughs)
  for (const [id, revision] of Object.entries(pinned.buildRevisions)) expect(revised.buildRevisions[id]).toEqual(revision)
  for (const [id, setup] of Object.entries(pinned.gameSetups)) expect(revised.gameSetups[id]).toEqual(setup)
  await page.reload()
  await expect(strength.getByRole('cell').nth(1)).toHaveText('+90')
  await page.getByRole('combobox', { name: /^Editor checkpoint/ }).selectOption(build.latestRevisionId!)
  await expect(strength.getByRole('cell').nth(1)).toHaveText('+60')
  await expect(strength.getByRole('cell').last()).toHaveText(total)
})

test('keeps drafts after rejected planning imports and rolls back a failed save before retry', async ({ page }) => {
  await openDraft(page, '{"Title":"Synthetic inspection only","EditorVersion":34}')
  const before = await storedData(page)
  await page.getByRole('button', { name: 'Save to CryKit', exact: true }).click()
  await expect(page.getByText('Mod not saved to CryKit', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
  await page.getByRole('textbox', { name: /^Exact JSON value/ }).fill(SOURCE)
  await page.getByRole('button', { name: 'Apply JSON edit', exact: true }).click()
  await expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'history' && this.transaction.db.name === 'crykit') { IDBObjectStore.prototype.add = add; throw new DOMException('Synthetic mod save failure', 'QuotaExceededError') }
      return add.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Save to CryKit', exact: true }).click()
  await expect(page.getByText('Mod not saved to CryKit', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await expect(page.getByRole('textbox', { name: /^Exact JSON value/ })).toHaveValue(SOURCE)
  await page.getByRole('button', { name: 'Save to CryKit', exact: true }).click()
  await expect(page.getByText('Mod revision saved to CryKit', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Mod Library', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Synthetic calculation mod', exact: true })).toBeVisible()
})

test('shows the generated bundled library and opens exact full originals offline with Workshop links', { tag: MOBILE_TEST_TAG }, async ({ page, context }) => {
  await page.goto('/#/mods')
  await expect.poll(() => page.locator('.mod-library > .mod-library__card').count()).toBeGreaterThanOrEqual(new Set(bundledSources.mods.map(mod => mod.projectId)).size)
  await expect(page.getByRole('region', { name: 'Equipment Expansion', exact: true })).toHaveCount(1)
  const barbarian = page.getByRole('region', { name: 'Barbarian', exact: true })
  await expect(barbarian).toContainText('Bundled version')
  await expect(barbarian.getByRole('link', { name: 'View Barbarian on Steam Workshop', exact: true })).toHaveAttribute('href', 'https://steamcommunity.com/sharedfiles/filedetails/?id=3161945566')
  await expect(page.getByRole('region', { name: 'Doge Shield', exact: true })).toContainText('Bundled version')
  await expect(page.getByRole('region', { name: 'Fusewright - One More Turn', exact: true })).toHaveCount(0)
  await expect(page.getByText('Named mods and in-game observations', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: "Browse Crystal Project's Steam Workshop", exact: true })).toHaveAttribute('href', CRYSTAL_PROJECT_WORKSHOP_URL)
  const equipment = page.getByRole('region', { name: 'Equipment Expansion', exact: true })
  await expect(equipment.getByRole('link', { name: 'View Equipment Expansion on Steam Workshop', exact: true })).toHaveAttribute('href', 'https://steamcommunity.com/sharedfiles/filedetails/?id=3055060437')
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Cheat Passives')
  const mod = page.getByRole('region', { name: 'Cheat Passives', exact: true })
  await mod.getByRole('button', { name: 'Edit mod JSON', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Current file', exact: true })).toContainText('Original file')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download original', exact: true }).click()
  const bytes = await readFile((await (await download).path())!)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(bundledSources.mods.find(mod => mod.title === 'Cheat Passives')!.sha256)
  await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
  const root = JSON.parse(await page.getByRole('textbox', { name: /^Exact JSON value/ }).inputValue()) as Record<string, unknown>
  root.Version = 'Synthetic revised version'
  root.FutureSetting = { state: null }
  await page.getByRole('textbox', { name: /^Exact JSON value/ }).fill(JSON.stringify(root))
  await page.getByRole('button', { name: 'Apply JSON edit', exact: true }).click()
  await expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible()
  const before = await storedData(page)
  await page.getByRole('button', { name: 'Save to CryKit', exact: true }).click()
  await expect(page.getByText('Mod revision saved to CryKit', { exact: true })).toBeVisible()
  const after = await storedData(page)
  expect(after.gameSetups).toEqual(before.gameSetups)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  await page.getByRole('tab', { name: 'Mod Library', exact: true }).click()
  await expect(mod).toContainText('Synthetic revised version')
  await mod.getByText('Versions', { exact: true }).click()
  await expect(mod).toContainText('Bundled version')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('validates project identity for updates and links exact bundled records when selecting a setup layer', async ({ page }) => {
  await page.goto('/#/mods')
  const mod = page.getByRole('region', { name: 'Equipment Expansion', exact: true })
  await expect(mod).toBeVisible()
  const before = await storedData(page)
  const input = mod.getByLabel('Updated JSON for Equipment Expansion', { exact: true })
  await input.setInputFiles({ name: 'wrong-project.json', mimeType: 'application/json', buffer: Buffer.from(SOURCE) })
  await expect(page.getByRole('alert')).toContainText('different Crystal Edit project ID')
  expect(await storedData(page)).toEqual(before)
  const source = bundledSources.mods.find(mod => mod.title === 'Equipment Expansion')!
  const target = Object.values(CURRENT_CATALOG.entities).find(entity => entity.id === 'base:equipment:0')!
  const identity = { modelId: 0 }
  const update = JSON.stringify({ ID: source.projectId, Title: source.title, Version: 'Synthetic update', EditorVersion: 34, Equipment: [{ ID: identity.modelId, Name: 'Synthetic revised equipment', EquipmentType: 0 }], FutureSetting: { value: null } })
  await input.setInputFiles({ name: 'synthetic-update.json', mimeType: 'application/json', buffer: Buffer.from(update) })
  await expect(page.getByText('Mod revision saved to CryKit', { exact: true })).toBeVisible()
  await expect(mod).toContainText('Synthetic update')
  await mod.getByText('Versions', { exact: true }).click()
  await expect(mod).toContainText('Version 1.3')
  expect((await storedData(page)).gameSetups).toEqual(before.gameSetups)
  await page.goto('/#/builds/library/new')
  await openBuildGameSetup(page)
  await page.locator('.game-setup-mods > summary').click()
  await page.getByText('Add another mod', { exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search available mods', exact: true }).fill('Equipment Expansion')
  const buildMod = page.getByRole('region', { name: 'Mod Equipment Expansion', exact: true })
  await buildMod.getByRole('combobox', { name: 'Version of Equipment Expansion', exact: true }).selectOption({ label: 'Synthetic update · saved · format 34' })
  await buildMod.getByRole('button', { name: 'Enable Equipment Expansion for this build', exact: true }).click()
  await page.getByText('Mod priority and replacement links', { exact: true }).click()
  await expect(page.getByLabel('Effective mod summary', { exact: true })).toContainText('1 with replacements')
  await page.getByText('Review effective records and replacement links', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Bundled target for Synthetic revised equipment', exact: true })).toHaveText(`Replaces ${target.name}`)
})

test('keeps source-less named mods and their catalog entries and supports manual observed definitions', async ({ page }) => {
  await page.goto('/#/mods')
  await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Bloodmage')
  const mod = page.getByRole('region', { name: 'Bloodmage', exact: true })
  await expect(mod).toContainText('Mod JSON unavailable')
  await mod.getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bloodmage', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove Mod: Bloodmage filter', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Adventurer', exact: true })).toHaveCount(0)
  await page.goto(`${referencePath('base:job:0')}?library-mod=name%3Abloodmage`)
  await expect(page.getByText('Reference definition unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toHaveCount(0)
  await page.goto('/#/mods')
  await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Bloodmage')
  await mod.getByRole('button', { name: 'Add catalog entry', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Create personal definition', exact: true })
  await editor.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic observed class')
  await editor.getByRole('button', { name: 'Create definition', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic observed class', exact: true }).first()).toBeVisible()
  const observed = Object.values((await storedData(page)).personalDefinitions).find(definition => definition.name === 'Synthetic observed class')!
  expect(observed.fields['Source mod']).toMatchObject({ state: 'known', value: 'Bloodmage' })
  expect(observed.fields.Cost).toBeUndefined()
  expect(observed.fields.PP?.state ?? 'unknown').toBe('unknown')
  await page.goto('/#/mods')
  await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Bloodmage')
  await mod.getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic observed class', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Bloodmage', exact: true })).toBeVisible()
})

test('keeps same-name projects distinct and binds manual additions to the chosen card', async ({ page }) => {
  await page.goto('/#/mods')
  await page.getByLabel('Import mod JSON', { exact: true }).setInputFiles({ name: 'synthetic-same-name.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ID: 'synthetic-unrelated-bloodmage', Title: 'Bloodmage', Version: 'synthetic', EditorVersion: 34, Equipment: [{ ID: 9001, Name: 'Synthetic foreign equipment' }] })) })
  await expect(page.getByText('Mod revision saved to CryKit', { exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Bloodmage')
  const cards = page.getByRole('region', { name: 'Bloodmage', exact: true })
  await expect(cards).toHaveCount(2)
  const project = cards.filter({ hasText: 'Imported JSON' })
  const manual = cards.filter({ hasText: 'Mod JSON unavailable' })
  await project.getByRole('button', { name: 'Add catalog entry', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Create personal definition', exact: true })
  await editor.getByRole('textbox', { name: 'Definition name', exact: true }).fill('Synthetic project observation')
  await editor.getByRole('button', { name: 'Create definition', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic project observation', exact: true }).first()).toBeVisible()
  const observed = Object.values((await storedData(page)).personalDefinitions).find(definition => definition.name === 'Synthetic project observation')!
  expect(observed.fields['Source mod project ID']).toEqual({ state: 'known', value: 'crystal-edit:synthetic-unrelated-bloodmage' })
  await page.goto('/#/mods')
  await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Bloodmage')
  await project.getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic foreign equipment', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Synthetic project observation', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Bloodmage', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Synthetic project observation', exact: true })).toBeVisible()
  await page.goto('/#/mods')
  await page.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Bloodmage')
  await manual.getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bloodmage', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Synthetic foreign equipment', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Synthetic project observation', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Remove Mod: Bloodmage filter', exact: true }).click()
  await expect(page).not.toHaveURL(/library-mod=/)
})

test('keeps an unavailable mod scope empty until the filter is cleared', async ({ page }) => {
  await page.goto('/#/reference?library-mod=crystal-edit:synthetic-missing')
  await expect(page.getByRole('button', { name: 'Remove Mod: Unavailable mod filter', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Doge Shield', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear all filters', exact: true }).click()
  await expect(page).not.toHaveURL(/library-mod=/)
})

test('browses one temporary catalog without saving it, then explicitly adds it to Reference', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const source = bundledSources.mods.find(mod => mod.title.startsWith('Apotheosis'))!
  const count = Object.values(source.models).reduce((sum, ids) => sum + ids.length, 0)
  await page.goto('/#/mods')
  await includeObservedDoge(page)
  await page.goto('/#/reference')
  const referenceSearch = page.getByRole('searchbox', { name: 'Search reference', exact: true })
  await referenceSearch.fill('Doge Shield')
  await expect(page.getByRole('heading', { name: 'Doge Shield', exact: true })).toBeVisible()
  await referenceSearch.fill('Raging Crash')
  await expect(page.getByRole('heading', { name: 'Raging Crash', exact: true })).toHaveCount(0)
  const standingRoute = await page.evaluate(() => sessionStorage.getItem('crykit:reference-route:v1'))
  await page.goto('/#/mods')
  const mod = page.getByRole('region', { name: source.title, exact: true })
  await expect(mod).toContainText(`${count} definitions in bundled JSON`)
  const before = await storedData(page)
  const archive = await archiveDigests(page)
  const requestedSources: string[] = []
  page.on('request', request => {
    if (bundledSources.mods.some(mod => request.url().includes(mod.sha256))) requestedSources.push(request.url())
  })
  await mod.getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await expect(page.getByText('Temporary mod catalog', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Remove Mod: ${source.title} filter`, exact: true })).toBeVisible()
  await expect(page.locator('.facet-panel .panel__header')).toContainText(`${count} confirmed`)
  for (const [kind, name] of [['class', 'Warrior'], ['ability', 'Raging Crash'], ['passive', 'Counter'], ['status', 'Focus Chakra']]) {
    await referenceSearch.fill(name!)
    await expect(page.locator('.reference-card').filter({ has: page.getByRole('heading', { name, exact: true }) }).filter({ has: page.locator('.badge', { hasText: new RegExp(`^${kind}$`) }) })).toBeVisible()
  }
  await referenceSearch.fill('Warrior')
  const warrior = page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Warrior', exact: true }) })
  await expect(warrior).toHaveAttribute('href', /library-mod=/)
  await expect(warrior).toHaveAttribute('href', /\/warrior\?/)
  await warrior.click()
  await expect(page).toHaveURL(/\/warrior\?/)
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Quick edit', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/warrior\?/)
  await expect(page.getByText('Temporary mod catalog', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await page.getByRole('button', { name: 'Clear all filters', exact: true }).click()
  await expect(page).toHaveURL(/library-mod=/)
  await expect(page.locator('.facet-panel .panel__header')).toContainText(`${count} confirmed`)
  expect(await archiveDigests(page)).toEqual(archive)
  expect(await storedData(page)).toEqual(before)
  expect(await page.evaluate(() => sessionStorage.getItem('crykit:reference-route:v1'))).toBe(standingRoute)
  expect(requestedSources.length).toBeGreaterThan(0)
  expect(requestedSources.every(url => url.includes(source.sha256))).toBe(true)
  await page.getByRole('button', { name: 'Return to Reference', exact: true }).click()
  await expect(referenceSearch).toHaveValue('Raging Crash')
  await expect(page.getByRole('heading', { name: 'Raging Crash', exact: true })).toHaveCount(0)
  await page.goto('/#/mods')
  await expect(mod).toContainText(`${count} definitions in bundled JSON`)
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'history' && this.transaction.db.name === 'crykit') { IDBObjectStore.prototype.add = add; throw new DOMException('Synthetic reference opt-in failure', 'QuotaExceededError') }
      return add.apply(this, args)
    }
  })
  await mod.getByRole('button', { name: 'Add to Reference', exact: true }).click()
  await expect(mod.getByRole('alert')).toContainText('Reference not changed')
  await expect(mod.getByRole('alert')).toContainText('Existing local data is unchanged')
  expect(await archiveDigests(page)).toEqual(archive)
  await mod.getByRole('button', { name: 'Add to Reference', exact: true }).click()
  await expect(mod).toContainText(`${count} catalog entries`)
  const added = await storedData(page)
  expect(added.gameSetups).toEqual(before.gameSetups)
  expect(added.buildRevisions).toEqual(before.buildRevisions)
  expect(added.playthroughs).toEqual(before.playthroughs)
  await page.goto('/#/reference')
  await expect(page.getByRole('heading', { name: 'Raging Crash', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Raging Crash', exact: true })).toBeVisible()
  await page.goto('/#/mods')
  const retained = await archiveDigests(page)
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'history' && this.transaction.db.name === 'crykit') { IDBObjectStore.prototype.add = add; throw new DOMException('Synthetic reference removal failure', 'QuotaExceededError') }
      return add.apply(this, args)
    }
  })
  await mod.getByRole('button', { name: 'Remove from Reference', exact: true }).click()
  await expect(mod.getByRole('alert')).toContainText('Reference not changed')
  expect(await archiveDigests(page)).toEqual(retained)
  await expect(mod.getByRole('button', { name: 'Remove from Reference', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await mod.getByRole('button', { name: 'Remove from Reference', exact: true }).click()
  await expect(mod.getByRole('button', { name: 'Add to Reference', exact: true })).toHaveAttribute('aria-pressed', 'false')
  const removed = await storedData(page)
  expect(removed.gameSetups).toEqual(added.gameSetups)
  expect(removed.buildRevisions).toEqual(added.buildRevisions)
  expect(removed.playthroughs).toEqual(added.playthroughs)
  await page.reload()
  await expect(mod.getByRole('button', { name: 'Add to Reference', exact: true })).toBeVisible()
  await page.goto('/#/reference')
  await expect(page.getByRole('heading', { name: 'Raging Crash', exact: true })).toHaveCount(0)
  await page.keyboard.press('Control+k')
  const globalSearch = page.getByRole('dialog', { name: 'Search CryKit', exact: true })
  await globalSearch.getByRole('searchbox').fill('Raging Crash')
  await expect(globalSearch.locator('[data-universal-result="true"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.goto('/#/mods')
  await mod.getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await referenceSearch.fill('Raging Crash')
  await expect(page.getByRole('heading', { name: 'Raging Crash', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add to Reference', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Raging Crash', exact: true })).toBeVisible()
  const restored = await archiveDigests(page)
  for (const table of ['catalogs', 'sources', 'evidence', 'imports']) expect(restored[table]).toBe(retained[table])
  await page.goto('/#/mods')
  await mod.getByLabel(`Updated JSON for ${source.title}`, { exact: true }).setInputFiles({ name: 'synthetic-apotheosis-update.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ID: source.projectId, Title: source.title, Version: 'Synthetic updated Apotheosis', EditorVersion: 34, Jobs: [{ ID: 0, Name: 'Synthetic updated class' }] })) })
  await expect(mod).toContainText('Synthetic updated Apotheosis')
  const updatedArchive = await archiveDigests(page)
  await mod.getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic updated class', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toHaveCount(0)
  expect(await archiveDigests(page)).toEqual(updatedArchive)
})

test('toggles bundled and source-less catalogs while retaining game enablement, sources, and saved selections', async ({ page }) => {
  await page.goto('/#/mods')
  await expect(page.getByRole('region', { name: 'Equipment Expansion', exact: true })).toBeVisible()
  for (const name of ['Equipment Expansion', 'Bloodmage']) {
    const card = page.getByRole('region', { name, exact: true })
    await card.getByRole('button', { name: 'Add to Reference', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Remove from Reference', exact: true })).toBeVisible()
  }
  const before = await storedData(page)
  const archive = await archiveDigests(page)
  for (const [name, entry] of [['Equipment Expansion', 'Ace of Diamonds'], ['Bloodmage', 'Bloodmage']]) {
    const mod = page.getByRole('region', { name, exact: true })
    await expect(mod.getByText(`Mod: ${name}`, { exact: true })).toHaveCount(0)
    await expect(mod.getByText('Enabled status not recorded', { exact: true })).toBeVisible()
    await mod.getByRole('button', { name: 'Remove from Reference', exact: true }).click()
    await expect(mod.getByRole('button', { name: 'Add to Reference', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await page.goto(`/#/reference?v=1&q=${encodeURIComponent(entry!)}`)
    await expect(page.getByRole('heading', { name: entry, exact: true })).toHaveCount(0)
    await page.goto('/#/mods')
    await mod.getByRole('button', { name: 'Add to Reference', exact: true }).click()
    await expect(mod.getByRole('button', { name: 'Remove from Reference', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.goto(`/#/reference?v=1&q=${encodeURIComponent(entry!)}`)
    await expect(page.getByRole('heading', { name: entry, exact: true })).toBeVisible()
    await page.goto('/#/mods')
    await mod.getByRole('button', { name: 'View catalog entries', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search reference', exact: true }).fill(entry!)
    await expect(page.getByRole('heading', { name: entry, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Remove from Reference', exact: true }).click()
    await expect(page).not.toHaveURL(/library-mod=/)
    await page.getByRole('searchbox', { name: 'Search reference', exact: true }).fill(entry!)
    await expect(page.getByRole('heading', { name: entry, exact: true })).toHaveCount(0)
    await page.goto('/#/mods')
    await mod.getByRole('button', { name: 'Add to Reference', exact: true }).click()
    await expect(mod.getByRole('button', { name: 'Remove from Reference', exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
  const after = await storedData(page)
  expect(after.gameSetups).toEqual(before.gameSetups)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.playthroughs).toEqual(before.playthroughs)
  const retained = await archiveDigests(page)
  for (const table of ['catalogs', 'sources', 'evidence', 'imports']) expect(retained[table]).toBe(archive[table])
})

test('keeps failed temporary catalog loads separate from the standing library', async ({ page }) => {
  const source = bundledSources.mods.find(mod => mod.title.startsWith('Apotheosis'))!
  await page.goto('/#/mods')
  await expect(page.getByRole('region', { name: source.title, exact: true })).toBeVisible()
  await includeObservedDoge(page)
  const before = await archiveDigests(page)
  await page.route(`**/*${source.sha256}*`, route => route.abort())
  await page.getByRole('region', { name: source.title, exact: true }).getByRole('button', { name: 'View catalog entries', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Mod catalog unavailable')
  expect(await archiveDigests(page)).toEqual(before)
  await page.getByRole('button', { name: 'Return to Reference', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: 'Search reference', exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search reference', exact: true }).fill('Doge Shield')
  await expect(page.getByRole('heading', { name: 'Doge Shield', exact: true })).toBeVisible()
})

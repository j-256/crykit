import { expect, test, type Page } from '@playwright/test'
import { createSharePayload, createShareUrl } from '../src/interchange/share'
import { NATIVE_DATA } from '../src/domain/calculation-rules'
import type { LocalData } from '../src/domain/types'

const MOD_ID = 'synthetic-editor-library'
const SOURCE = JSON.stringify({ ID: MOD_ID, Title: 'Synthetic calculation mod', Version: '1', EditorVersion: 34, System: { BattleConfig: { ...NATIVE_DATA.battleConfig, TwoHandedPAtkFlat: 80, StrWhileUnarmedBonusFlat: 60 } }, Passives: [{ ID: 9000, Name: 'Synthetic unarmed', PP: 1, IsInnate: false, IsLearnable: true, StatMods: [{ Tag: 474, Value1: 0, Value2: 0 }] }] })

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
  await page.getByRole('button', { name: 'Mod library', exact: true }).click()
  const mod = page.getByRole('region', { name: 'Synthetic calculation mod', exact: true })
  await expect(mod).toContainText('Version 1')
  await page.goto('/#/builds/library/new')
  await page.getByRole('combobox', { name: 'Game version', exact: true }).selectOption('1.6.9')
  await page.getByRole('combobox', { name: 'Difficulty', exact: true }).selectOption('0')
  await page.locator('.game-setup-base-details > summary').click()
  await page.getByRole('combobox', { name: 'Game mode', exact: true }).selectOption('Vanilla')
  await page.locator('.game-setup-mods > summary').click()
  await page.getByRole('combobox', { name: 'Imported mod to add', exact: true }).selectOption(`crystal-edit:${MOD_ID}`)
  await page.getByRole('button', { name: 'Add mod layer', exact: true }).click()
  await page.locator('.game-setup-derived > summary').click()
  await expect(page.locator('.game-setup-derived')).toContainText('TwoHandedPAtkFlat')
  await expect(page.locator('.game-setup-derived')).toContainText('80')
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Warrior')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Warrior$/ }) }).click()
  await expect(page.getByText('Balance mode: vanilla · from Game Setup', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'PC balance mode', exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Equipped passive 1', exact: true }).fill('Synthetic unarmed')
  await page.getByRole('listbox', { name: 'Choose Equipped passive 1', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Synthetic unarmed$/ }) }).click()
  await page.getByRole('combobox', { name: 'Calculation gender', exact: true }).selectOption('male')
  const strength = page.getByRole('table', { name: 'Planned build stats', exact: true }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Strength', exact: true }) })
  await expect(strength.getByRole('cell').nth(1)).toHaveText('+60')
  const total = await strength.getByRole('cell').last().innerText()
  const detailedStrength = page.getByRole('table', { name: 'Calculated character stats', exact: true }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Strength', exact: true }) })
  await expect(detailedStrength.getByRole('cell').first()).toHaveText(total)
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await page.getByText('Build details & notes', { exact: true }).click()
  await page.getByLabel('Build title').fill('Synthetic pinned rules')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic pinned rules', exact: true })).toBeVisible()
  const pinned = await storedData(page)
  await page.goto('/#/mods')
  await page.getByRole('button', { name: 'Edit a copy', exact: true }).click()
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
  await page.getByRole('button', { name: 'Mod library', exact: true }).click()
  await expect(mod).toContainText('Version 2')
  await mod.getByText('Earlier versions (1)', { exact: true }).click()
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
  await page.getByRole('button', { name: 'Mod library', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Synthetic calculation mod', exact: true })).toBeVisible()
})

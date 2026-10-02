import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { expect, test, type Page } from '@playwright/test'
import { SUMMONS } from '../src/catalog/summons'
import type { LocalData } from '../src/domain'
import { createBlankPlaythrough, replacePlannerData, selectedPlaythrough } from './local-data-helpers'
import { expectOfflineReady } from './offline-helpers'
import { referencePath } from './reference-helpers'

async function openSettings(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportBackup(page: Page) {
  const panel = await openSettings(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloading = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const path = await (await downloading).path()
  if (!path) throw new Error('The backup download is unavailable')
  const bytes = await readFile(path)
  const files = unzipSync(bytes)
  const localData = (JSON.parse(strFromU8(files['bundle.json']!)) as { localData: LocalData }).localData
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return { bytes, localData }
}

const summonTile = (page: Page, name: string) => page.locator('.summon-tile').filter({ has: page.getByRole('button', { name: new RegExp(`^${name}, Deity of`) }) })

test.beforeEach(async ({ page }) => {
  await page.goto('/#/progress/summons')
  await expect(page.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
})

test('uses native artwork and the game tree layout with only gray and gold states', async ({ page }) => {
  await expect(page).toHaveTitle('Summons | CryKit')
  await expect(page.getByRole('navigation', { name: 'Progress guides' }).getByRole('link', { name: 'Summons', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.summon-tile[data-unlocked="false"]')).toHaveCount(SUMMONS.filter(summon => !summon.starting).length)
  const pinga = summonTile(page, 'Pinga')
  await expect(pinga).toHaveAttribute('data-unlocked', 'true')
  await expect(pinga.getByRole('button')).toBeDisabled()
  await expect(page.locator('.progress-summary__number')).toHaveText(`1 / ${SUMMONS.length}`)
  await pinga.getByRole('button').evaluate(element => (element as HTMLButtonElement).click())
  await page.reload()
  await expect(pinga).toHaveAttribute('data-unlocked', 'true')
  await expect(pinga.getByRole('button')).toBeDisabled()
  await expect(page.locator('.summon-tile')).toHaveCount(SUMMONS.length)
  for (const summon of SUMMONS) {
    const tile = summonTile(page, summon.name)
    await expect(tile.getByRole('button')).toHaveAccessibleName(`${summon.label}: ${summon.starting ? 'Always unlocked' : 'Mark unlocked'}`)
    await expect(tile.getByRole('link', { name: `${summon.name}: Skill`, exact: true })).toHaveAttribute('href', referencePath(summon.id).slice(1))
    await expect(tile.getByRole('link', { name: `${summon.name}: Deity`, exact: true })).toHaveAttribute('href', referencePath(summon.monsterId).slice(1))
    expect(await tile.evaluate(element => [(element as HTMLElement).style.gridRow, (element as HTMLElement).style.gridColumn])).toEqual([String(summon.row + 1), String(summon.column + 1)])
    const image = tile.locator('img')
    await image.scrollIntoViewIfNeeded()
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(tile.locator('[data-artwork-source="native"]')).toHaveCount(1)
  }
  const shaku = summonTile(page, 'Shaku')
  await shaku.getByRole('button').click()
  await expect(shaku).toHaveAttribute('data-unlocked', 'true')
  await expect(page.locator('.progress-summary__number')).toHaveText(`2 / ${SUMMONS.length}`)
  await expect(shaku.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  await shaku.getByRole('button').click()
  await expect(shaku).toHaveAttribute('data-unlocked', 'false')
  await shaku.getByRole('button').focus()
  await page.keyboard.press('Space')
  await expect(shaku).toHaveAttribute('data-unlocked', 'true')
  await page.keyboard.press('Enter')
  await expect(shaku).toHaveAttribute('data-unlocked', 'false')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('opens skill and deity Reference pages without changing unlock progress', async ({ page }) => {
  await summonTile(page, 'Pinga').getByRole('link', { name: 'Pinga: Skill', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pinga', exact: true })).toBeVisible()
  await expect(page.locator('.reference-detail .reference-card__meta')).toContainText('ability')
  await page.goBack()
  await expect(summonTile(page, 'Pinga')).toHaveAttribute('data-unlocked', 'true')
  await expect(summonTile(page, 'Pinga').getByRole('button')).toBeDisabled()
  await summonTile(page, 'Shaku').getByRole('link', { name: 'Shaku: Deity', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Shaku', exact: true })).toBeVisible()
  await expect(page.locator('.reference-detail--enemy')).toBeVisible()
  await page.goBack()
  await expect(summonTile(page, 'Shaku')).toHaveAttribute('data-unlocked', 'false')
  const { localData } = await exportBackup(page)
  expect(selectedPlaythrough(localData).progress).toEqual({})
})

test('rapid odd and even clicks preserve the final request and keep neighboring tiles and controls stable', async ({ page }) => {
  await page.evaluate(() => {
    const neighbor = document.querySelector('[data-summon="base:summoner:ability:pah"]')!
    const context = document.querySelector('.context-bar')!
    const changes: string[] = []
    const observer = new MutationObserver(records => changes.push(...records.map(record => `${record.type}:${record.attributeName ?? ''}`)))
    observer.observe(neighbor, { attributes: true, childList: true, characterData: true, subtree: true })
    observer.observe(context, { attributes: true, childList: true, characterData: true, subtree: true })
    Object.assign(window, { summonRenderCheck: { neighbor, changes, observer } })
    const toggle = (name: string) => document.querySelector<HTMLButtonElement>(`[data-summon="base:summoner:ability:${name}"] button`)!
    for (let index = 0; index < 5; index += 1) toggle('shaku').click()
    for (let index = 0; index < 4; index += 1) toggle('pamoa').click()
  })
  await expect(summonTile(page, 'Shaku')).toHaveAttribute('data-unlocked', 'true')
  await expect(summonTile(page, 'Pamoa')).toHaveAttribute('data-unlocked', 'false')
  await expect(page.locator('.summon-tile button[aria-busy="true"]')).toHaveCount(0)
  expect(await page.evaluate(() => {
    const state = (window as unknown as { summonRenderCheck: { neighbor: Element; changes: string[]; observer: MutationObserver } }).summonRenderCheck
    state.observer.disconnect()
    return { sameNode: state.neighbor === document.querySelector('[data-summon="base:summoner:ability:pah"]'), changes: state.changes }
  })).toEqual({ sameNode: true, changes: [] })
  await page.reload()
  await expect(summonTile(page, 'Shaku')).toHaveAttribute('data-unlocked', 'true')
  await expect(summonTile(page, 'Pamoa')).toHaveAttribute('data-unlocked', 'false')
  const { localData } = await exportBackup(page)
  const playthrough = selectedPlaythrough(localData)
  expect(Object.values(playthrough.progress).map(record => [record.displayName, record.unlocked])).toEqual([
    ['Shaku, Deity of Fire', { state: 'known', value: true }],
    ['Pamoa, Deity of Ice', { state: 'known', value: false }],
  ])
  expect(Object.values(playthrough.characters)).toHaveLength(0)
})

test('opens saved summon search results on their own board instead of the class editor', async ({ page }) => {
  const shaku = summonTile(page, 'Shaku')
  await shaku.getByRole('button').click()
  await expect(shaku.getByRole('button')).not.toHaveAttribute('aria-busy', 'true')
  await page.getByRole('navigation', { name: 'Progress guides', exact: true }).getByRole('link', { name: 'Class seals', exact: true }).click()
  await expect(page.locator('.progress-other')).not.toContainText('Shaku')
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: 'Search CryKit', exact: true })
  await search.getByRole('searchbox', { name: 'Search CryKit', exact: true }).fill('Shaku')
  await search.getByRole('link').filter({ hasText: 'Shaku' }).filter({ hasText: 'Party progress' }).click()
  await expect(search).not.toBeVisible()
  await expect(page.locator('.summon-tile[data-focused="true"]')).toContainText('Shaku')
  await expect(shaku.getByRole('button')).toBeFocused()
  await expect(shaku).toHaveAttribute('data-unlocked', 'true')
  await expect(page.getByRole('dialog', { name: 'Edit progress record', exact: true })).not.toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Progress guides' }).getByRole('link', { name: 'Summons', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('rolls back a failed save, reports it, and persists a retry', async ({ page }) => {
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') {
        IDBObjectStore.prototype.put = original
        throw new DOMException('Synthetic summon storage failure', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  const shaku = summonTile(page, 'Shaku')
  await shaku.getByRole('button').click()
  await expect(page.getByText('Summon not saved', { exact: true })).toBeVisible()
  await expect(shaku).toHaveAttribute('data-unlocked', 'false')
  await expect(shaku.getByRole('button')).toBeEnabled()
  await page.getByRole('button', { name: 'Retry summon', exact: true }).click()
  await expect(shaku).toHaveAttribute('data-unlocked', 'true')
  await expect(shaku.getByRole('button')).not.toHaveAttribute('aria-busy', 'true')
  await page.reload()
  await expect(shaku).toHaveAttribute('data-unlocked', 'true')
})

test('keeps marks separate between Playthroughs and restores them from a backup', async ({ page }) => {
  const shaku = summonTile(page, 'Shaku')
  await shaku.getByRole('button').click()
  await expect(shaku.getByRole('button')).not.toHaveAttribute('aria-busy', 'true')
  const backup = await exportBackup(page)
  const first = selectedPlaythrough(backup.localData)
  await createBlankPlaythrough(page)
  await expect(page.locator('.summon-tile[data-unlocked="false"]')).toHaveCount(SUMMONS.filter(summon => !summon.starting).length)
  await expect(summonTile(page, 'Pinga')).toHaveAttribute('data-unlocked', 'true')
  await expect(summonTile(page, 'Pinga').getByRole('button')).toBeDisabled()
  const second = await exportBackup(page)
  expect(selectedPlaythrough(second.localData).progress).toEqual({})
  expect(second.localData.playthroughs[first.id]?.progress).toEqual(first.progress)
  const panel = await openSettings(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-summons.zip', mimeType: 'application/zip', buffer: backup.bytes })
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  await expect(shaku).toHaveAttribute('data-unlocked', 'true')
  const restored = await exportBackup(page)
  expect(selectedPlaythrough(restored.localData).progress).toEqual(first.progress)
})

test('records summon unlocks and reads their artwork offline', async ({ page, context }) => {
  const panel = await openSettings(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  const coyote = summonTile(page, 'Coyote')
  await coyote.getByRole('button').click()
  await expect(coyote.getByRole('button')).not.toHaveAttribute('aria-busy', 'true')
  await page.reload()
  await expect(coyote).toHaveAttribute('data-unlocked', 'true')
  await expect.poll(() => coyote.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await context.setOffline(false)
})

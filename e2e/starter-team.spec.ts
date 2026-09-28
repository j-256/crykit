import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import type { Profile } from '../src/domain/types'
import { createBlankPlaythrough } from './profile-helpers'

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportProfile(page: Page): Promise<Profile> {
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const archive = unzipSync(await readFile((await (await download).path())!))
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return (JSON.parse(strFromU8(archive['bundle.json']!)) as { profile: Profile }).profile
}

test('a fresh guest can explore and edit the sample team, then reopen it offline without duplicates', async ({ page, context, baseURL }, testInfo) => {
  const errors: string[] = []
  const externalRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(baseURL!).origin) externalRequests.push(request.url()) })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Inventory', exact: true }).filter({ visible: true }).click()
  await expect(page.getByText('Short Sword', { exact: true })).toBeVisible()
  const original = await exportProfile(page)
  expect(original.label).toBe('Sample playthrough')
  expect(Object.values(original.characters).map(character => character.name).sort()).toEqual(['Mira', 'Rowan'])
  expect(Object.values(original.builds)).toHaveLength(2)
  const team = original.scenarios[original.activeScenarioId!]!
  expect(Object.keys(team.assignments)).toHaveLength(2)

  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  await page.getByRole('article', { name: 'Rowan', exact: true }).getByRole('link', { name: 'Member', exact: true }).click()
  const characterPicker = page.getByRole('combobox', { name: 'Character', exact: true })
  for (const [name, className, weapon] of [['Rowan', 'Warrior', 'Short Sword'], ['Mira', 'Cleric', 'Short Staff']]) {
    await characterPicker.selectOption({ label: name })
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Choose Class', exact: true })).toContainText(className)
    await expect(page.getByRole('button', { name: 'Choose Main hand', exact: true })).toContainText(weapon)
    await page.locator('.member-record > summary').filter({ hasText: 'Observation details' }).click()
    await expect(page.locator('.member-record > p').filter({ hasText: /^Sample data for exploring the planner/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('sample-character.png'), fullPage: true })
  await page.goto(`/#/builds/teams/${encodeURIComponent(team.id)}`)
  await expect(page.getByRole('heading', { name: 'Sample starter team', exact: true })).toBeVisible()
  for (const character of Object.values(original.characters)) {
    await expect(page.getByRole('combobox', { name: character.name, exact: true })).toHaveValue(team.assignments[character.id]!)
  }
  await page.screenshot({ path: testInfo.outputPath('sample-team.png'), fullPage: true })

  const build = Object.values(original.builds)[0]!
  await page.goto(`/#/builds/library/${encodeURIComponent(build.id)}`)
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Short Sword')
  await page.getByRole('combobox', { name: 'Main hand', exact: true }).fill('Rapier')
  await page.getByRole('listbox', { name: 'Choose Main hand', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Rapier$/ }) }).click()
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  const saved = await exportProfile(page)
  expect(saved.builds[build.id]!.latestRevisionId).not.toBe(build.latestRevisionId)
  expect(saved.characters).toEqual(original.characters)
  expect(saved.scenarios).toEqual(original.scenarios)
  expect(saved.inventory).toEqual(original.inventory)

  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = settings.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expect(settings.getByText('Offline ready', { exact: true })).toBeVisible({ timeout: 15_000 })
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Rapier')
  expect(await exportProfile(page)).toEqual(saved)
  expect(errors).toEqual([])
  expect(externalRequests).toEqual([])
})

test('an explicitly created blank playthrough stays empty after reload', async ({ page }) => {
  await page.goto('/')
  await createBlankPlaythrough(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Plan your next build', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  await expect(page.getByRole('heading', { name: 'Your roster is blank', exact: true })).toBeVisible()
  const profile = await exportProfile(page)
  for (const key of ['characters', 'inventory', 'builds', 'scenarios'] as const) expect(profile[key]).toEqual({})
})

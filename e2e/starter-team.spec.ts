import { openBuildPickerFilters } from './build-picker-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { skipInitialModSetup, openCurrentGameSetup, saveAndApplyGameSetup, selectedPlaythrough, chooseFourTeamMembers, createBlankPlaythrough, openGameSetupSection } from './local-data-helpers'
import { expectOfflineReady } from './offline-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import type { LocalData } from '../src/domain/types'

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportLocalData(page: Page): Promise<LocalData> {
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const archive = unzipSync(await readFile((await (await download).path())!))
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return (JSON.parse(strFromU8(archive['bundle.json']!)) as { localData: LocalData }).localData
}

test('a fresh guest can explore and edit the sample team, then reopen it offline without duplicates', { tag: MOBILE_TEST_TAG }, async ({ page, context, baseURL }, testInfo) => {
  const errors: string[] = []
  const externalRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(baseURL!).origin) externalRequests.push(request.url()) })
  await page.goto('/')
  await skipInitialModSetup(page)
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Inventory', exact: true }).filter({ visible: true }).click()
  await expect(page.getByText('Short Sword', { exact: true })).toBeVisible()
  const original = await exportLocalData(page)
  expect(selectedPlaythrough(original).label).toBe('Sample playthrough')
  expect(Object.values(selectedPlaythrough(original).characters).map(character => character.name).sort()).toEqual(['Mira', 'Rowan', 'Sol', 'Tavi'])
  expect(Object.values(original.builds)).toHaveLength(4)
  const team = selectedPlaythrough(original).scenarios[selectedPlaythrough(original).activeScenarioId!]!
  expect(team.memberIds).toEqual(Object.keys(selectedPlaythrough(original).characters))
  expect(Object.keys(team.assignments)).toHaveLength(4)

  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  await page.getByRole('article', { name: 'Rowan', exact: true }).getByRole('link', { name: 'Rowan', exact: true }).click()
  const characterPicker = page.getByRole('combobox', { name: 'Character', exact: true })
  for (const [name, className, weapon] of [['Rowan', 'Warrior', 'Short Sword'], ['Mira', 'Cleric', 'Short Staff'], ['Tavi', 'Rogue', 'Dirk'], ['Sol', 'Wizard', 'Oak Wand']]) {
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
  for (const character of Object.values(selectedPlaythrough(original).characters)) {
    await expect(page.getByRole('combobox', { name: character.name, exact: true })).toHaveValue(team.assignments[character.id]!)
  }
  await page.screenshot({ path: testInfo.outputPath('sample-team.png'), fullPage: true })

  const build = Object.values(original.builds)[0]!
  await page.goto(`/#/builds/library/${encodeURIComponent(build.id)}`)
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Short Sword')
  await page.getByRole('combobox', { name: 'Main hand', exact: true }).fill('Rapier')
  const picker = page.getByRole('listbox', { name: 'Choose Main hand', exact: true })
  await openBuildPickerFilters(page)
  await picker.getByRole('checkbox', { name: 'Hide known equipment conflicts', exact: true }).uncheck()
  await picker.getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: /^Rapier$/ }) }).click()
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  const saved = await exportLocalData(page)
  expect(saved.builds[build.id]!.latestRevisionId).not.toBe(build.latestRevisionId)
  expect(selectedPlaythrough(saved).characters).toEqual(selectedPlaythrough(original).characters)
  expect(selectedPlaythrough(saved).scenarios).toEqual(selectedPlaythrough(original).scenarios)
  expect(selectedPlaythrough(saved).inventory).toEqual(selectedPlaythrough(original).inventory)

  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = settings.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Rapier')
  expect(await exportLocalData(page)).toEqual(saved)
  expect(errors).toEqual([])
  expect(externalRequests).toEqual([])
})

test('an explicitly created blank playthrough keeps its records empty while shared Builds remain', async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await createBlankPlaythrough(page)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Build library', exact: true }).locator('.build-card')).toHaveCount(4)
  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  await expect(page.getByRole('heading', { name: 'Your roster is blank', exact: true })).toBeVisible()
  const localData = await exportLocalData(page)
  for (const key of ['characters', 'inventory', 'scenarios'] as const) expect(selectedPlaythrough(localData)[key]).toEqual({})
  expect(Object.values(localData.builds)).toHaveLength(4)
})

test('Game Setup starts with core fields and reveals optional settings on demand', { tag: MOBILE_TEST_TAG }, async ({ page }, testInfo) => {
  await page.goto('/#/settings/game-setup?scope=playthrough')
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await openCurrentGameSetup(panel)
  await expect(panel.getByRole('combobox', { name: 'Difficulty', exact: true })).toBeVisible()
  const mods = panel.locator('.game-setup-mods')
  const advanced = panel.locator('.game-setup-derived')
  await expect(mods).not.toHaveAttribute('open')
  await expect(advanced).not.toHaveAttribute('open')
  await expect(mods.locator(':scope > summary')).toContainText('0 imported versions enabled')
  await expect(panel.getByRole('button', { name: 'Save Game Setup', exact: true })).toBeInViewport()
  await expect(panel.getByLabel('Custom mod name', { exact: true })).not.toBeVisible()
  await expect(panel.getByRole('region', { name: 'Imported mod layers', exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('game-setup-overview.png') })
  await mods.locator(':scope > summary').focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('region', { name: 'Imported mod layers', exact: true })).toBeVisible()
  await panel.locator('.game-setup-named-mods > summary').click()
  await expect(panel.getByLabel('Custom mod name', { exact: true })).toBeVisible()
  await expect(panel.locator('.game-setup-editor-section[open]')).toHaveCount(0)
  await expect(panel.getByText('Equipment slot rules', { exact: true })).not.toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Doge Shield', exact: true })).not.toBeVisible()
  const pack = panel.locator('.game-setup-mod-pack').filter({ hasText: 'Mod Pack 2: New Challenges' })
  await expect(pack).toBeVisible()
  await expect(pack.getByRole('combobox')).not.toBeVisible()
  await pack.locator(':scope > summary').click()
  await expect(pack.getByRole('combobox').first()).toBeVisible()
  await pack.getByRole('combobox', { name: 'Doge Shield', exact: true }).selectOption('enabled')
  await panel.getByLabel('Custom mod name', { exact: true }).fill('Synthetic draft mod')
  await mods.locator(':scope > summary').click()
  await expect(mods.locator(':scope > summary')).toContainText('1 named choices')
  await mods.locator(':scope > summary').click()
  await expect(pack.getByRole('combobox', { name: 'Doge Shield', exact: true })).toHaveValue('enabled')
  await expect(panel.getByLabel('Custom mod name', { exact: true })).toHaveValue('Synthetic draft mod')
  await openGameSetupSection(panel, 'Imported mod files')
  await expect(panel.getByRole('region', { name: 'Imported mod layers', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('game-setup-progressive-disclosure.png') })
})

test('new party plans require four distinct roster members before build assignment', async ({ page }) => {
  await page.goto('/#/builds/teams')
  await page.getByRole('button', { name: 'New party plan', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Create party plan', exact: true })
  await form.getByLabel('Party plan name').fill('Synthetic exact team')
  const create = form.getByRole('button', { name: 'Create party plan', exact: true })
  await expect(create).toBeDisabled()
  await chooseFourTeamMembers(form)
  await expect(create).toBeEnabled()
  await create.click()
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Synthetic exact team', exact: true }) })
  await expect(card.getByText('4 of 4 members', { exact: true })).toBeVisible()
  await expect(card.getByRole('combobox')).toHaveCount(4)
})

test('sample team uncertainty uses plain language and targeted actions', async ({ page }) => {
  await page.goto('/#/builds/teams')
  const team = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Sample starter team', exact: true }) })
  const setup = team.locator('.validation-group').filter({ hasText: 'Setup needs review' })
  const defaults = team.locator('.validation-group').filter({ hasText: 'Planner defaults in use' })
  const coverage = team.locator('.validation-group').filter({ hasText: 'Reference coverage is limited' })

  await expect(team.getByText('Setup and reference coverage', { exact: true })).toBeVisible()
  await expect(setup.locator('summary')).toHaveText('Setup needs review · 2 fields')
  await expect(defaults.locator('summary')).toHaveText('Planner defaults in use · 6 slots')
  await expect(coverage).toHaveCount(0)
  await expect(team.getByText('Game Setup settings need evidence', { exact: true })).toHaveCount(0)
  await expect(team.getByText(/not verified game behavior/)).toHaveCount(0)

  await setup.locator('summary').click()
  await setup.getByRole('button', { name: 'Review setup', exact: true }).click()
  let panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(panel.getByText('Saved revision 1', { exact: true })).toBeVisible()
  await expect(panel.locator('.game-setup-derived')).not.toHaveAttribute('open')
  await expect(panel.getByLabel('Game version', { exact: true })).toBeFocused()
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()

  await defaults.locator('summary').click()
  await defaults.getByRole('button', { name: 'Review planner defaults', exact: true }).click()
  panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(panel.locator('.game-setup-derived')).toHaveAttribute('open')
  await expect(panel.getByText('Saved equipment layout', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Apply planner defaults', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const saved = await exportLocalData(page)
  const savedTeam = Object.values(selectedPlaythrough(saved).scenarios).find(scenario => scenario.label === 'Sample starter team')!
  expect(saved.gameSetups[savedTeam.gameSetupRevisionId]!.slots.every(slot => slot.provenance === 'suggested')).toBe(true)

  await expect(team.getByRole('button', { name: 'Review catalog coverage', exact: true })).toHaveCount(0)
  await expect(team.getByRole('button', { name: 'Import reference data', exact: true })).toHaveCount(0)
})

test('Windows game data remains scoped when a team uses Switch 1.6.6', async ({ page }) => {
  await page.goto('/#/settings/game-setup?scope=playthrough')
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await openCurrentGameSetup(panel)
  await openGameSetupSection(panel, 'Game context')
  await panel.getByLabel('Platform', { exact: true }).selectOption('Windows')
  await panel.getByLabel('Game version', { exact: true }).selectOption('1.6.9')
  await panel.getByLabel('Game mode', { exact: true }).selectOption('Standard')
  await saveAndApplyGameSetup(panel)
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.goto('/#/builds/teams')

  async function createTeam(label: string) {
    await page.getByRole('button', { name: 'New party plan', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Create party plan', exact: true })
    await form.getByLabel('Party plan name').fill(label)
    await chooseFourTeamMembers(form)
    await form.getByRole('button', { name: 'Create party plan', exact: true }).click()
    await expect(form).not.toBeVisible()
    const team = page.getByRole('article').filter({ has: page.getByRole('heading', { name: label, exact: true }) })
    await expect(team).toBeVisible()
    return team
  }

  const windowsTeam = await createTeam('Synthetic Windows context')
  await expect(windowsTeam.getByText('Game data parity is unresolved', { exact: true })).toHaveCount(0)
  await page.goto('/#/settings/game-setup?scope=playthrough')
  await openCurrentGameSetup(panel)
  await openGameSetupSection(panel, 'Game context')
  await panel.getByLabel('Platform', { exact: true }).selectOption('Nintendo Switch')
  await panel.getByLabel('Game version', { exact: true }).selectOption('1.6.6')
  await saveAndApplyGameSetup(panel)
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.goto('/#/builds/teams')
  const switchTeam = await createTeam('Synthetic Switch context')
  const scope = switchTeam.locator('.validation-group').filter({ hasText: 'Game data parity is unresolved' })
  await scope.locator('summary').click()
  await expect(scope).toContainText('Equivalence between Windows 1.6.9 game data and Nintendo Switch 1.6.6 is unresolved')
  await scope.getByRole('button', { name: 'Review setup', exact: true }).click()
  await expect(panel.getByLabel('Platform', { exact: true })).toHaveValue('Nintendo Switch')
  await expect(panel.getByLabel('Game version', { exact: true })).toBeFocused()
})

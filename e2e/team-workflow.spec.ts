import { readLocalData as storedData } from './local-data-helpers'
import { teamSlots, withTeamBuildViews } from '../src/domain/team-checkpoints'
import { chooseTeamCheckpoint, teamCheckpointControl } from './team-helpers'
import { expect, test, type Page } from '@playwright/test'
import { buildBehavior } from '../src/domain/build-behavior'
import { importSyntheticLibrary, SYNTHETIC_LIBRARY_ROOTS, SYNTHETIC_LIBRARY_SOURCES } from './mod-library-fixtures'
import { IMPORTED_RULES_REVISION } from '../src/domain/game-rules'
import { MOD_LIBRARY_IMPORT_REVISION } from '../src/interchange/crystal-edit'
import { formatAppRoute } from '../src/ui/navigation'
import { MOBILE_TEST_TAG } from './test-tags'

const NEW_TEAM_ROUTE = formatAppRoute({ page: { page: 'teams', view: 'new' }, overlays: [], query: {} })
const SAVE_MEMBER = 'Save member and return to Team'

async function choose(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).fill(name)
  await page.getByRole('listbox', { name: `Choose ${label}`, exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).first().click()
  await expect(page.getByRole('combobox', { name: label, exact: true })).toHaveValue(name)
}

async function failNextSave(page: Page) {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'active' && this.transaction.db.name === 'crykit-guest-coordinator-v1') { IDBObjectStore.prototype.put = put; throw new DOMException('Synthetic member save failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
}

test('edits Team-owned content, retries atomically and leaves the pinned sibling and complete Build library unchanged', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic member workflow')
  const before = await storedData(page)
  const original = Object.values(before.buildRevisions).find(revision => before.builds[revision.buildId]?.title.includes('Warrior'))!
  await chooseTeamCheckpoint(page, 1, original.id); await chooseTeamCheckpoint(page, 2, original.id)
  await failNextSave(page)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByText('Team not saved', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  const first = page.getByRole('region', { name: 'Team slot 1 loadout', exact: true })
  await first.getByRole('button', { name: 'Edit member', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Build title', exact: true })).toHaveCount(0)
  await choose(page, 'Main hand', 'Diamond Sword')
  await failNextSave(page)
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByText('Revision not saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Diamond Sword')
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic member workflow')
  const saved = await storedData(page), team = Object.values(saved.teams).find(team => team.title === 'Synthetic member workflow')!
  const next = withTeamBuildViews(saved).buildRevisions[teamSlots(saved, team)[0]!]!
  expect(next.content).not.toEqual(original.content)
  expect(saved.builds).toEqual(before.builds); expect(saved.buildRevisions).toEqual(before.buildRevisions)
  expect(withTeamBuildViews(saved).buildRevisions[teamSlots(saved, team)[1]!]!.content).toEqual(original.content)
  expect(saved.playthroughs).toEqual(before.playthroughs)
  await expect(page.getByRole('region', { name: 'Team review', exact: true })).toContainText('2/4 slots filled')
  await expect(page.getByText('Newer checkpoint available:', { exact: false })).toHaveCount(0)
  await page.getByRole('button', { name: 'Return to Team', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Edit Team', exact: true }).click()
  await expect(first).toContainText('Diamond Sword')
  expect((await storedData(page)).teamRevisions).toEqual(saved.teamRevisions)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('canceling member edits or creation preserves the unsaved Team name and checkpoint selections', async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic draft retained')
  const before = await storedData(page)
  const revision = Object.values(before.buildRevisions)[0]!
  await chooseTeamCheckpoint(page, 1, revision.id)
  const first = page.getByRole('region', { name: 'Team slot 1 loadout', exact: true })
  await first.getByRole('button', { name: 'Edit member', exact: true }).click()
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await page.getByLabel('Rotation or use notes').fill('Canceled member edit')
  await page.getByRole('button', { name: 'Cancel and return to Team', exact: true }).click()
  await expect(first.getByRole('heading', { name: before.builds[revision.buildId]!.title, exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('region', { name: 'Team slot 2 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await choose(page, 'Class', 'Cleric')
  await page.getByRole('button', { name: 'Cancel and return to Team', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic draft retained')
  await expect(teamCheckpointControl(page, 1)).toHaveAttribute('data-revision-id', revision.id)
  await expect(teamCheckpointControl(page, 2)).toHaveAttribute('data-revision-id', '')
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByLabel('Team overview')).toContainText('1/4 members')
})

test('creates members under an explicitly chosen shared setup without adding standalone Builds', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic shared setup')
  await expect(page.getByRole('button', { name: 'Create member', exact: true }).first()).toBeDisabled()
  const before = await storedData(page)
  const setup = Object.values(before.gameSetups).find(setup => setup.label === 'Sample starter Game Setup')!
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption(setup.id)
  await page.getByRole('region', { name: 'Team slot 1 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await choose(page, 'Class', 'Cleric'); await choose(page, 'Main hand', 'Diamond Staff')
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic shared setup')
  const firstSaved = await storedData(page), team = Object.values(firstSaved.teams).find(team => team.title === 'Synthetic shared setup')!
  const firstRevision = withTeamBuildViews(firstSaved).buildRevisions[teamSlots(firstSaved, team)[0]!]!
  await page.getByRole('region', { name: 'Team slot 2 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Team member context', exact: true })).toContainText('Shared Team Game Setup:')
  await choose(page, 'Class', 'Wizard')
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic shared setup')
  const secondSaved = await storedData(page), currentTeam = secondSaved.teams[team.id]!
  const secondRevision = withTeamBuildViews(secondSaved).buildRevisions[teamSlots(secondSaved, currentTeam)[1]!]!
  expect(secondRevision.gameSetupRevisionId).toBe(setup.id)
  expect(buildBehavior(secondSaved.gameSetups[secondRevision.gameSetupRevisionId]!)).toEqual(buildBehavior(firstSaved.gameSetups[firstRevision.gameSetupRevisionId]!))
  expect(firstSaved.builds).toEqual(before.builds); expect(firstSaved.buildRevisions).toEqual(before.buildRevisions)
  expect(secondSaved.builds).toEqual(before.builds); expect(secondSaved.buildRevisions).toEqual(before.buildRevisions)
  expect(withTeamBuildViews(secondSaved).buildRevisions[teamSlots(secondSaved, currentTeam)[0]!]!.content).toEqual(firstRevision.content)
})

test('a Team member confirms its mod source and retains class and growth pins after reload', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const teamTitle = 'Synthetic mod member Team'
  await importSyntheticLibrary(page, true, [SYNTHETIC_LIBRARY_ROOTS[1]!])
  const source = SYNTHETIC_LIBRARY_SOURCES[1]!
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill(teamTitle)
  const before = await storedData(page)
  const first = page.getByRole('region', { name: 'Team slot 1 loadout', exact: true })
  await first.getByRole('button', { name: 'Create member', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Build title', exact: true })).toHaveCount(0)
  const context = page.getByRole('region', { name: 'Team member context', exact: true })
  const field = page.getByRole('combobox', { name: 'Class', exact: true })
  await field.fill('Synthetic Class')
  const results = page.getByRole('listbox', { name: 'Choose Class', exact: true })
  const freelancer = results.getByRole('option').filter({ has: page.locator('strong', { hasText: /^Synthetic Class$/ }) })
  await expect(freelancer).toBeVisible()
  await expect(freelancer).toHaveAttribute('data-mod-state', 'unknown')
  await freelancer.click()
  const dialog = page.getByRole('dialog', { name: 'Enable Synthetic Moonlight?', exact: true })
  const confirm = dialog.getByRole('button', { name: 'Enable and select Synthetic Class', exact: true })
  await expect(confirm).toBeFocused()
  await expect(field).toHaveValue('')
  await expect(page.getByRole('button', { name: SAVE_MEMBER, exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(field).toHaveValue('')
  await expect(field).toBeFocused()
  await expect(results).toHaveCount(0)
  await expect(context).toContainText(`${teamTitle} · Slot 1`)
  expect(await storedData(page)).toEqual(before)
  await field.click()
  await field.fill('Synthetic Class')
  await freelancer.click()
  await expect(dialog).toContainText(`Version ${source.version}`)
  await dialog.getByText('Version details', { exact: true }).click()
  const version = dialog.getByRole('combobox', { name: 'Mod version', exact: true })
  await expect(version).toHaveValue(`sha256:${source.sha256}:${IMPORTED_RULES_REVISION}:${MOD_LIBRARY_IMPORT_REVISION}`)
  await expect(version.locator('option:checked')).toHaveText('1 · saved · format 34')
  await expect(version.locator('option:checked')).toContainText(`format ${source.editorVersion}`)
  await confirm.click()
  await expect(dialog).toHaveCount(0)
  await expect(field).toHaveValue('Synthetic Class')
  await expect(context).toContainText(`${teamTitle} · Slot 1`)
  const enabled = await storedData(page)
  expect(enabled.buildRevisions).toEqual(before.buildRevisions)
  expect(enabled.gameSetups).toEqual(before.gameSetups)
  expect(enabled.teams).toEqual(before.teams)
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue(teamTitle)
  await expect(first.getByRole('heading', { name: 'Team member 1', exact: true })).toBeVisible()
  const saved = await storedData(page)
  const team = Object.values(saved.teams).find(team => team.title === teamTitle)!
  const revision = withTeamBuildViews(saved).buildRevisions[teamSlots(saved, team)[0]!]!
  const setup = saved.gameSetups[revision.gameSetupRevisionId]!
  const primaryClass = revision.content.primaryClass
  expect(teamSlots(saved, team)).toEqual([revision.id, null, null, null])
  expect(saved.builds).toEqual(before.builds)
  expect(saved.buildRevisions).toEqual(before.buildRevisions)
  expect(setup.modComposition!.layers).toHaveLength(1)
  expect(setup.modComposition!.layers[0]).toMatchObject({ catalogId: `crystal-edit:${source.projectId}`, enabled: true })
  expect(primaryClass?.kind).toBe('catalog')
  if (primaryClass?.kind === 'catalog') {
    expect(primaryClass.catalogId).toBe(setup.modComposition!.baseline.catalogId)
    expect(primaryClass.catalogRevisionId).toBe(setup.catalogLock[primaryClass.catalogId])
  }
  expect(revision.content.calculation!.growth).toHaveLength(1)
  expect(revision.content.calculation!.growth[0]!.classRef).toEqual(primaryClass)
  expect(saved.playthroughs).toEqual(before.playthroughs)
  for (const [id, previous] of Object.entries(before.buildRevisions)) expect(saved.buildRevisions[id]).toEqual(previous)
  for (const [id, previous] of Object.entries(before.gameSetups)) expect(saved.gameSetups[id]).toEqual(previous)
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue(teamTitle)
  await expect(teamCheckpointControl(page, 1)).toHaveAttribute('data-revision-id', revision.id)
  await expect(first).toContainText('Synthetic Class')
  const reloaded = await storedData(page)
  expect(reloaded.teams[team.id]).toEqual(team)
  expect(reloaded.builds).toEqual(before.builds)
  expect(reloaded.buildRevisions).toEqual(before.buildRevisions)
  expect(withTeamBuildViews(reloaded).buildRevisions[revision.id]).toEqual(revision)
  expect(reloaded.gameSetups[setup.id]).toEqual(setup)
  expect(errors).toEqual([])
})

test('the navigation guard saves the Team and its open member before continuing', async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic guarded Team')
  await page.getByRole('region', { name: 'Team slot 1 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await choose(page, 'Class', 'Cleric')
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const saved = await storedData(page)
  const team = Object.values(saved.teams).find(team => team.title === 'Synthetic guarded Team')!
  const revision = withTeamBuildViews(saved).buildRevisions[teamSlots(saved, team)[0]!]!
  expect(revision.content.primaryClass).not.toBeNull()
  expect(saved.builds[revision.buildId]).toBeUndefined()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
})

test('saves changed Team member content through the navigation guard without advancing its source', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  const before = await storedData(page), source = Object.values(before.buildRevisions)[0]!
  await chooseTeamCheckpoint(page, 1, source.id)
  await page.getByRole('region', { name: 'Team slot 1 loadout', exact: true }).getByRole('button', { name: 'Edit member', exact: true }).click()
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await page.getByLabel('Rotation or use notes').fill('Changed through navigation guard')
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const saved = await storedData(page), team = Object.values(saved.teams).find(team => !before.teams[team.id])!
  expect(saved.builds).toEqual(before.builds); expect(saved.buildRevisions).toEqual(before.buildRevisions)
  expect(withTeamBuildViews(saved).buildRevisions[teamSlots(saved, team)[0]!]!.content.rotationNotes).toBe('Changed through navigation guard')
})

test('searches checkpoint context and hides samples without changing selected revisions', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic searchable Team')
  const before = await storedData(page)
  const warrior = Object.values(before.builds).find(build => build.title.includes('Warrior'))!
  await teamCheckpointControl(page, 1).click()
  const dialog = page.getByRole('dialog', { name: 'Choose checkpoint for Team slot 1', exact: true })
  const search = dialog.getByRole('searchbox')
  await expect(search).toBeFocused()
  await search.fill('Short Sword')
  const choices = dialog.getByRole('list', { name: 'Build checkpoints', exact: true }).getByRole('button')
  await expect(choices).toHaveCount(1)
  await expect(choices).toContainText('Warrior')
  await expect(choices).toContainText('Sample build')
  await expect(choices).toContainText('Main hand: Short Sword')
  await dialog.getByRole('checkbox', { name: 'Show sample builds', exact: true }).uncheck()
  await expect(choices).toHaveCount(0)
  await dialog.getByRole('checkbox', { name: 'Show sample builds', exact: true }).check()
  await search.press('Enter')
  await expect(dialog).not.toBeVisible()
  await expect(teamCheckpointControl(page, 1)).toHaveAttribute('data-revision-id', warrior.latestRevisionId!)
  await teamCheckpointControl(page, 1).click()
  await dialog.getByRole('checkbox', { name: 'Show sample builds', exact: true }).uncheck()
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(teamCheckpointControl(page, 1)).toHaveAttribute('data-revision-id', warrior.latestRevisionId!)
  expect(await storedData(page)).toEqual(before)
})

test('enters lower member edits at the top and bridges equipment details to the exact field', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('combobox', { name: /^Choose shared setup/ }).selectOption({ label: 'Sample starter Game Setup · r1' })
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic scroll Team')
  const before = await storedData(page)
  const warrior = Object.values(before.builds).find(build => build.title.includes('Warrior'))!
  for (let index = 1; index <= 4; index += 1) await chooseTeamCheckpoint(page, index, warrior.latestRevisionId!)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByLabel('Team overview')).toContainText('4/4 members')
  await page.getByRole('button', { name: 'Edit Team', exact: true }).click()
  const saved = await storedData(page)
  const team = Object.values(saved.teams).find(team => team.title === 'Synthetic scroll Team')!
  const fourth = page.getByRole('region', { name: 'Team slot 4 loadout', exact: true })
  const edit = fourth.getByRole('button', { name: 'Edit member', exact: true })
  await edit.scrollIntoViewIfNeeded()
  const scroll = () => page.evaluate(() => ({ main: document.querySelector('.main-shell')!.scrollTop, window: window.scrollY }))
  const position = await scroll()
  expect(position.main + position.window).toBeGreaterThan(0)
  await edit.click()
  await expect(page.getByRole('region', { name: 'Team member context', exact: true })).toBeFocused()
  await expect.poll(scroll).toEqual({ main: 0, window: 0 })
  await page.getByRole('button', { name: 'Return to Team', exact: true }).click()
  await expect.poll(scroll).toEqual(position)
  await expect(edit).toBeFocused()
  await fourth.getByRole('button', { name: 'Open Main hand: Short Sword', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'Main hand: Short Sword', exact: true })
  await details.getByRole('button', { name: 'Edit this slot', exact: true }).click()
  await expect(details).not.toBeVisible()
  const mainHand = page.locator('[data-field-key="slot:plan-main-hand"]')
  await expect(mainHand).toBeFocused()
  await expect(mainHand).toBeInViewport()
  await choose(page, 'Main hand', 'Diamond Sword')
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(fourth).toContainText('Diamond Sword')
  const after = await storedData(page)
  expect(teamSlots(after, after.teams[team.id]!).slice(0, 3).map(id => withTeamBuildViews(after).buildRevisions[id!]!.content)).toEqual(teamSlots(saved, team).slice(0, 3).map(id => withTeamBuildViews(saved).buildRevisions[id!]!.content))
  expect(teamSlots(after, after.teams[team.id]!)[3]).not.toBe(teamSlots(saved, team)[3])
  expect(after.buildRevisions[warrior.latestRevisionId!]).toEqual(saved.buildRevisions[warrior.latestRevisionId!])
  await page.reload()
  await expect(fourth).toContainText('Diamond Sword')
})

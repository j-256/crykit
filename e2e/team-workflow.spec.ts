import { expect, test, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { buildBehavior } from '../src/domain/build-behavior'
import { BUNDLED_MOD_LIBRARY } from '../src/catalog/mod-library-metadata'
import { BUNDLED_VERSION_PREFIX } from '../src/ui/build-mod-sources'
import { formatAppRoute } from '../src/ui/navigation'
import { MOBILE_TEST_TAG } from './test-tags'

const NEW_TEAM_ROUTE = formatAppRoute({ page: { page: 'teams', view: 'new' }, overlays: [], query: {} })
const SAVE_MEMBER = 'Save member and return to Team'

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

async function choose(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).fill(name)
  await page.getByRole('listbox', { name: `Choose ${label}`, exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).first().click()
  await expect(page.getByRole('combobox', { name: label, exact: true })).toHaveValue(name)
}

async function failNextSave(page: Page) {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = put; throw new DOMException('Synthetic member save failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
}

test('edits a member in Team context, retries atomically, and explicitly updates a pinned sibling slot', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic member workflow')
  const before = await storedData(page)
  const original = Object.values(before.buildRevisions).find(revision => before.builds[revision.buildId]?.title.includes('Warrior'))!
  await page.getByRole('combobox', { name: 'Team slot 1', exact: true }).selectOption(original.id)
  await page.getByRole('combobox', { name: 'Team slot 2', exact: true }).selectOption(original.id)
  await failNextSave(page)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByText('Team not saved', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  const first = page.getByRole('region', { name: 'Team slot 1 loadout', exact: true })
  await first.getByRole('button', { name: 'Edit member', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Team member context', exact: true })).toContainText('Synthetic member workflow')
  await choose(page, 'Main hand', 'Diamond Sword')
  expect(new URL(page.url()).hash).toBe(NEW_TEAM_ROUTE)
  await failNextSave(page)
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByText('Revision not saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Diamond Sword')
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic member workflow')
  await expect(page.getByText('Team not saved', { exact: true })).toHaveCount(0)
  const saved = await storedData(page)
  const team = Object.values(saved.teams)[0]!
  const next = saved.buildRevisions[team.slots[0]!]!
  expect(new URL(page.url()).hash).toBe(formatAppRoute({ page: { page: 'teams', view: 'team', teamId: team.id }, overlays: [], query: {} }))
  expect(next.revision).toBe(original.revision + 1)
  expect(team.slots[1]).toBe(original.id)
  expect(saved.buildRevisions[original.id]).toEqual(original)
  expect(saved.playthroughs).toEqual(before.playthroughs)
  await expect(page.getByRole('region', { name: 'Team review', exact: true })).toContainText('2/4 slots filled')
  const second = page.getByRole('region', { name: 'Team slot 2 loadout', exact: true })
  await expect(second.getByText(`Newer checkpoint available: r${next.revision}`, { exact: true })).toBeVisible()
  await second.getByText('Compare checkpoints', { exact: true }).click()
  await expect(second.locator('.team-checkpoint-comparison')).toContainText('Diamond Sword')
  await second.getByRole('button', { name: `Update this slot to r${next.revision}`, exact: true }).click()
  expect((await storedData(page)).teams[team.id]!.slots[1]).toBe(original.id)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save Team', exact: true })).toBeDisabled()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Team slot 2', exact: true })).toHaveValue(next.id)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('canceling a new member preserves the unsaved Team name and checkpoint selections', async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic draft retained')
  const before = await storedData(page)
  const revision = Object.values(before.buildRevisions)[0]!
  await page.getByRole('combobox', { name: 'Team slot 1', exact: true }).selectOption(revision.id)
  await page.getByRole('region', { name: 'Team slot 2 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill('Unsaved member')
  await choose(page, 'Class', 'Cleric')
  await page.getByRole('button', { name: 'Cancel and return to Team', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic draft retained')
  await expect(page.getByRole('combobox', { name: 'Team slot 1', exact: true })).toHaveValue(revision.id)
  await expect(page.getByRole('combobox', { name: 'Team slot 2', exact: true })).toHaveValue('')
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Team review', exact: true })).toContainText('Saved draft Team')
})

test('creates members directly in Team slots and reuses the first member setup', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic reusable setup')
  const before = await storedData(page)
  await page.getByRole('region', { name: 'Team slot 1 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill('First caster')
  await choose(page, 'Class', 'Cleric')
  await choose(page, 'Main hand', 'Diamond Staff')
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic reusable setup')
  const firstSaved = await storedData(page)
  const team = Object.values(firstSaved.teams)[0]!
  const firstRevision = firstSaved.buildRevisions[team.slots[0]!]!
  await page.getByRole('region', { name: 'Team slot 2 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Team member context', exact: true })).toContainText("Starting with this Team's Game Setup:")
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill('Second caster')
  await choose(page, 'Class', 'Wizard')
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic reusable setup')
  const secondSaved = await storedData(page)
  const secondRevision = secondSaved.buildRevisions[secondSaved.teams[team.id]!.slots[1]!]!
  expect(buildBehavior(secondSaved.gameSetups[secondRevision.gameSetupRevisionId]!)).toEqual(buildBehavior(firstSaved.gameSetups[firstRevision.gameSetupRevisionId]!))
  expect(secondSaved.buildRevisions[firstRevision.id]).toEqual(firstRevision)
  expect(secondSaved.playthroughs).toEqual(before.playthroughs)
  await expect(page.getByRole('region', { name: 'Team slot 1 loadout', exact: true }).getByRole('heading', { name: 'First caster', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Team slot 2 loadout', exact: true }).getByRole('heading', { name: 'Second caster', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('a Team member confirms its mod source and retains class and growth pins after reload', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const teamTitle = 'Synthetic mod member Team'
  const memberTitle = 'Synthetic Freelancer member'
  const source = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'moonlight-project' && mod.declaredVersion === '2.2')!
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill(teamTitle)
  const before = await storedData(page)
  const first = page.getByRole('region', { name: 'Team slot 1 loadout', exact: true })
  await first.getByRole('button', { name: 'Create member', exact: true }).click()
  const title = page.getByRole('textbox', { name: 'Build title', exact: true })
  await title.fill(memberTitle)
  const context = page.getByRole('region', { name: 'Team member context', exact: true })
  const field = page.getByRole('combobox', { name: 'Class', exact: true })
  await field.fill('Freelancer')
  const results = page.getByRole('listbox', { name: 'Choose Class', exact: true })
  const freelancer = results.getByRole('option').filter({ has: page.locator('strong', { hasText: /^Freelancer$/ }) })
  await expect(freelancer).toHaveCount(0)
  await results.getByText('Broader planning options', { exact: true }).click()
  await results.getByRole('checkbox', { name: 'Include disabled or unconfirmed mods', exact: true }).check()
  await freelancer.click()
  const dialog = page.getByRole('dialog', { name: 'Enable Moonlight Project?', exact: true })
  const confirm = dialog.getByRole('button', { name: 'Enable and select Freelancer', exact: true })
  await expect(confirm).toBeFocused()
  await expect(field).toHaveValue('')
  await expect(page.getByRole('button', { name: SAVE_MEMBER, exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(field).toHaveValue('')
  await expect(field).toBeFocused()
  await expect(results).toHaveCount(0)
  await expect(context).toContainText(`${teamTitle} · Slot 1`)
  await expect(title).toHaveValue(memberTitle)
  expect(await storedData(page)).toEqual(before)
  await field.click()
  await field.fill('Freelancer')
  await freelancer.click()
  await expect(dialog).toContainText(`Version ${source.declaredVersion}`)
  await dialog.getByText('Version details', { exact: true }).click()
  const version = dialog.getByRole('combobox', { name: 'Mod version', exact: true })
  await expect(version).toHaveValue(`${BUNDLED_VERSION_PREFIX}${source.sourceDigest}`)
  await expect(version.locator('option:checked')).toContainText(`format ${source.editorVersion}`)
  await confirm.click()
  await expect(dialog).toHaveCount(0)
  await expect(field).toHaveValue('Freelancer')
  await expect(context).toContainText(`${teamTitle} · Slot 1`)
  await expect(title).toHaveValue(memberTitle)
  const enabled = await storedData(page)
  expect(enabled.buildRevisions).toEqual(before.buildRevisions)
  expect(enabled.gameSetups).toEqual(before.gameSetups)
  expect(enabled.teams).toEqual(before.teams)
  await page.getByRole('button', { name: SAVE_MEMBER, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue(teamTitle)
  await expect(first.getByRole('heading', { name: memberTitle, exact: true })).toBeVisible()
  const saved = await storedData(page)
  const team = Object.values(saved.teams).find(team => team.title === teamTitle)!
  const revision = saved.buildRevisions[team.slots[0]!]!
  const build = saved.builds[revision.buildId]!
  const setup = saved.gameSetups[revision.gameSetupRevisionId]!
  const primaryClass = revision.content.primaryClass
  expect(team.slots).toEqual([revision.id, null, null, null])
  expect(build).toMatchObject({ title: memberTitle, latestRevisionId: revision.id, gameSetupId: setup.gameSetupId })
  expect(setup.modComposition!.layers).toHaveLength(1)
  expect(setup.modComposition!.layers[0]).toMatchObject({ catalogId: source.id, enabled: true })
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
  await expect(first.getByRole('combobox', { name: 'Team slot 1', exact: true })).toHaveValue(revision.id)
  await expect(first).toContainText('Freelancer')
  const reloaded = await storedData(page)
  expect(reloaded.teams[team.id]).toEqual(team)
  expect(reloaded.builds[build.id]).toEqual(build)
  expect(reloaded.buildRevisions[revision.id]).toEqual(revision)
  expect(reloaded.gameSetups[setup.id]).toEqual(setup)
  expect(errors).toEqual([])
})

test('the navigation guard saves the Team and its open member before continuing', async ({ page }) => {
  await page.goto(`/${NEW_TEAM_ROUTE}`)
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic guarded Team')
  await page.getByRole('region', { name: 'Team slot 1 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill('Guarded member')
  await choose(page, 'Class', 'Cleric')
  await page.getByRole('button', { name: 'Builds', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const saved = await storedData(page)
  const team = Object.values(saved.teams).find(team => team.title === 'Synthetic guarded Team')!
  const revision = saved.buildRevisions[team.slots[0]!]!
  expect(saved.builds[revision.buildId]!.title).toBe('Guarded member')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
})

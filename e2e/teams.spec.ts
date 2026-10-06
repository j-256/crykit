import { chooseTeamCheckpoint } from './team-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { createBlankPlaythrough, selectedPlaythrough } from './local-data-helpers'

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

async function failNextSave(page: Page) {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = put; throw new DOMException('Synthetic Team save failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
}

test('deletes the starter Team from the list after confirmation and keeps its underlying records', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/teams')
  const card = page.locator('.team-list-card').filter({ has: page.getByRole('heading', { name: 'Sample starter Team', exact: true }) })
  await expect(card.getByLabel('Team overview')).toContainText('4/4 members')
  const before = await storedData(page)
  await card.getByRole('button', { name: 'Delete Team', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete Team', exact: true })
  await expect(confirm).toContainText('Its Builds, checkpoints, tracked characters, and party plans will remain.')
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await storedData(page)).toEqual(before)
  await card.getByRole('button', { name: 'Delete Team', exact: true }).click()
  await failNextSave(page)
  await confirm.getByRole('button', { name: 'Delete Team', exact: true }).click()
  await expect(confirm.getByText('Team not deleted', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await confirm.getByRole('button', { name: 'Delete Team', exact: true }).click()
  await expect(card).toHaveCount(0)
  const after = await storedData(page)
  expect(after.teams).toEqual({})
  expect(after.builds).toEqual(before.builds)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.playthroughs).toEqual(before.playthroughs)
  await page.reload()
  expect((await storedData(page)).teams).toEqual({})
})

test('deletes a Team from its detail page and returns to the list', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/teams')
  const card = page.locator('.team-list-card').filter({ has: page.getByRole('heading', { name: 'Sample starter Team', exact: true }) })
  await card.getByRole('button', { name: 'Open Team', exact: true }).click()
  const before = await storedData(page)
  await page.getByRole('button', { name: 'Delete Team', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete Team', exact: true })
  await failNextSave(page)
  await confirm.getByRole('button', { name: 'Delete Team', exact: true }).click()
  await expect(confirm.getByText('Team not deleted', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await confirm.getByRole('button', { name: 'Delete Team', exact: true }).click()
  await expect(page).toHaveURL(/#\/teams$/)
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible()
  const after = await storedData(page)
  expect(after.teams).toEqual({})
  expect(after.builds).toEqual(before.builds)
  expect(after.playthroughs).toEqual(before.playthroughs)
})

test('plans and shares four checkpoints with no tracked characters and retries a failed save', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/teams')
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
  const before = await storedData(page)
  expect(selectedPlaythrough(before).characters).toEqual({})
  await expect(page.getByRole('button', { name: /^Playthrough:/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'New Team', exact: true }).click()
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic independent Team')
  const revisions = Object.values(before.builds).filter(build => build.title.includes(': sample ')).map(build => build.latestRevisionId!)
  for (let index = 0; index < 4; index += 1) await chooseTeamCheckpoint(page, index + 1, revisions[index]!)
  await failNextSave(page)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByText('Team not saved', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await expect(page.getByLabel('Team name')).toHaveValue('Synthetic independent Team')
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page).toHaveURL(/#\/teams\/team_/)
  const after = await storedData(page)
  const team = Object.values(after.teams).find(team => team.title === 'Synthetic independent Team')!
  expect(team.slots).toEqual(revisions)
  expect(after.playthroughs).toEqual(before.playthroughs)
  await expect(page.getByLabel('Team overview')).toContainText('4/4 members')
  await expect(page.getByRole('region', { name: 'Team slot 1 overview', exact: true })).toContainText('Checkpoint r1')
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Team slot 1 overview', exact: true }).getByRole('button', { name: /^Open Main hand:/ })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: team.title, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit Team', exact: true }).click()
  await expect(page.getByLabel('Team name')).toHaveValue(team.title)
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic failed edit')
  await failNextSave(page)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByText('Team not saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic failed edit')
  expect(await storedData(page)).toEqual(after)
  await page.getByRole('button', { name: 'Teams', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible()
  await expect(page.locator('.team-list-card').filter({ has: page.getByRole('heading', { name: team.title, exact: true }) }).getByLabel('Team overview')).toContainText('4/4 members')
  await page.getByRole('heading', { name: team.title, exact: true }).locator('..').getByRole('button', { name: 'Open Team', exact: true }).click()
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  const share = page.getByRole('dialog', { name: 'Share team', exact: true })
  const url = await share.getByLabel('Share URL').inputValue()
  await page.goto(url)
  await expect(page.getByRole('region', { name: /^Shared team slot/ })).toHaveCount(4)
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page).toHaveURL(/#\/teams\/team_/)
  const copied = await storedData(page)
  expect(Object.keys(copied.teams)).toHaveLength(Object.keys(after.teams).length + 1)
  expect(copied.playthroughs).toEqual(before.playthroughs)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('compares without changing tracking, then records one build without a party', async ({ page }) => {
  await page.goto('/#/characters')
  await expect(page.getByRole('heading', { name: 'Characters', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
  await page.getByRole('button', { name: 'Add character', exact: true }).first().click()
  const form = page.getByRole('dialog', { name: 'Add character', exact: true })
  await form.getByLabel('Character name').fill('Synthetic solo')
  await form.getByRole('button', { name: 'Add character', exact: true }).click()
  await expect(form).not.toBeVisible()
  const before = await storedData(page)
  const character = Object.values(selectedPlaythrough(before).characters)[0]!
  const revision = Object.values(before.buildRevisions)[0]!
  await page.goto(`/#/characters/${character.id}/current`)
  await page.getByText('Compare or apply a Build', { exact: true }).click()
  await page.getByLabel('Build checkpoint to compare').selectOption(revision.id)
  await page.getByRole('button', { name: 'Compare / apply Build', exact: true }).click()
  const compare = page.getByRole('dialog', { name: 'Compare and record Build', exact: true })
  await expect(compare.getByRole('columnheader', { name: 'Recorded now' })).toBeVisible()
  await expect(compare.getByRole('columnheader', { name: 'Proposed build' })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await expect(compare.getByRole('button', { name: 'Record as current', exact: true })).toBeDisabled()
  await compare.getByRole('checkbox', { name: 'I made these changes in game', exact: true }).check()
  await compare.getByRole('button', { name: 'Record as current', exact: true }).click()
  await expect(compare).not.toBeVisible()
  const after = await storedData(page)
  const updated = selectedPlaythrough(after).characters[character.id]!
  expect(Object.keys(updated.snapshots)).toHaveLength(Object.keys(character.snapshots).length + 1)
  expect(updated.snapshots[updated.currentSnapshotId!]!.gameSetupRevisionId).toBe(revision.gameSetupRevisionId)
  expect(updated.learnedNodes).toEqual(character.learnedNodes)
  expect(selectedPlaythrough(after).scenarios).toEqual({})
})

test('adopts a whole Team atomically after reviewing characters and shared equipment', async ({ page }) => {
  await page.goto('/#/teams/new')
  await expect(page.getByLabel('Team name')).toBeVisible()
  const initial = await storedData(page)
  await page.getByLabel('Team name').fill('Synthetic adopted Team')
  const revisions = Array.from({ length: 4 }, () => Object.values(initial.builds)[0]!.latestRevisionId!)
  for (let index = 0; index < 4; index += 1) await chooseTeamCheckpoint(page, index + 1, revisions[index]!)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit Team', exact: true })).toBeVisible()
  const before = await storedData(page)
  const team = Object.values(before.teams).find(team => team.title === 'Synthetic adopted Team')!
  await page.getByRole('button', { name: 'Adopt Team', exact: true }).click()
  const characters = Object.values(selectedPlaythrough(before).characters)
  for (let index = 0; index < 4; index += 1) await page.getByRole('combobox', { name: `Tracked character ${index + 1}`, exact: true }).selectOption(characters[index]!.id)
  await page.getByText('Compare with current loadout', { exact: true }).first().click()
  await expect(page.getByRole('columnheader', { name: 'Recorded now' })).toBeVisible()
  await page.getByText('Check party readiness and shared equipment', { exact: true }).click()
  await expect(page.getByText('Shared stock', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('checkbox', { name: 'I applied these builds in game', exact: true }).check()
  await failNextSave(page)
  await page.getByRole('button', { name: 'Record Team as current', exact: true }).click()
  await expect(page.getByText('Team not recorded', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Record Team as current', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Characters', exact: true })).toBeVisible()
  const after = await storedData(page)
  expect(after.teams[team.id]).toEqual(team)
  expect(selectedPlaythrough(after).inventory).toEqual(selectedPlaythrough(before).inventory)
  for (const character of characters) {
    const next = selectedPlaythrough(after).characters[character.id]!
    expect(Object.keys(next.snapshots)).toHaveLength(Object.keys(character.snapshots).length + 1)
    expect(next.learnedNodes).toEqual(character.learnedNodes)
    expect(next.classProgress).toEqual(character.classProgress)
  }
  await page.reload()
  expect((await storedData(page)).teams).toEqual(after.teams)
})

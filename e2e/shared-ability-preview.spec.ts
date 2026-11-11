import { expect, test } from '@playwright/test'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../src/catalog/bundled'
import { createSampleLocalData } from '../src/domain/sample-data'
import { createPublicSnapshot, createPublicShareUrl } from '../src/interchange/public-share'
import { publicRefKey } from '../src/interchange/public-share-schema'
import { readLocalData, waitForPlannerReady } from './local-data-helpers'
import { MOBILE_TEST_TAG } from './test-tags'

const localData = createSampleLocalData(CURRENT_CATALOG)
const snapshots = Object.values(localData.buildRevisions).map(revision => createPublicSnapshot({ planner: { localData, catalogs: BUNDLED_CATALOGS } }, { kind: 'build', revisionId: revision.id }, { includeNotes: false }))
const rogue = snapshots.find(snapshot => snapshot.title === 'Tavi: sample Rogue')!
const warrior = snapshots.find(snapshot => snapshot.title === 'Rowan: sample Warrior')!

for (const kind of ['build', 'team'] as const) test(`shared ${kind} previews allow ability selection without changing saved data`, { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const snapshot = kind === 'build' ? rogue : { ...rogue, kind, slots: [{ ...rogue.slots[0]!, name: 'Tavi' }, { ...warrior.slots[0]!, name: 'Rowan' }, null, null], receipts: [...new Map([...rogue.receipts, ...warrior.receipts].map(receipt => [publicRefKey(receipt.ref), receipt])).values()] }
  const url = createPublicShareUrl(snapshot, `${baseURL}/`)
  await page.goto(url)
  await waitForPlannerReady(page)
  const before = await readLocalData(page)
  const openPreview = async () => {
    await page.getByRole('button', { name: 'Checks & Notes', exact: true }).click()
    await page.getByText('Ability and hit-chance preview', { exact: true }).click()
  }
  await openPreview()
  const ability = page.getByRole('combobox', { name: 'Preview ability', exact: true })
  await expect(ability).toBeVisible()
  await ability.click()
  const choices = page.getByRole('listbox', { name: 'Choose Preview ability', exact: true })
  const classChoices = choices.getByRole('group', { name: 'Class: Rogue', exact: true })
  await expect(classChoices.getByRole('option')).not.toHaveCount(0)
  await classChoices.getByRole('option').filter({ has: page.getByText('Steal', { exact: true }) }).click()
  await expect(ability).toHaveValue('Steal')
  await expect(page.getByLabel('Effective ability costs', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add battle scenario', exact: true }).click()
  await expect(page.getByText('Used only in this preview.', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(url)
  expect(await readLocalData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Reset preview', exact: true }).click()
  await expect(ability).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Add battle scenario', exact: true })).toBeVisible()
  await ability.fill('Steal')
  await choices.getByRole('option').filter({ has: page.getByText('Steal', { exact: true }) }).click()
  if (kind === 'team') {
    await page.getByRole('button', { name: 'View Rowan', exact: true }).click()
    await openPreview()
    await expect(ability).toHaveValue('')
    await ability.click()
    await expect(choices.getByRole('group', { name: 'Class: Warrior', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  }
  await page.reload()
  await openPreview()
  await expect(ability).toHaveValue('')
  expect(await readLocalData(page)).toEqual(before)
  if (kind === 'build') {
    await ability.fill('Steal')
    await choices.getByRole('option').filter({ has: page.getByText('Steal', { exact: true }) }).click()
    await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
    await expect(page.getByText('Independent saved copy', { exact: true })).toBeVisible()
    const saved = await readLocalData(page)
    const copy = Object.values(saved.builds).find(build => !before.builds[build.id])!
    expect(saved.buildRevisions[copy.latestRevisionId!]!.content.calculation).toEqual(rogue.slots[0]!.calculation)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

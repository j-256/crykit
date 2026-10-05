import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { skipInitialModSetup, createBlankPlaythrough } from './local-data-helpers'
import { expectOfflineReady } from './offline-helpers'

test('the first expanded package export works offline without loading it at startup', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await createBlankPlaythrough(page)
  await page.goto('/#/builds/library/new')
  const button = page.getByRole('button', { name: 'Export calculation package', exact: true })
  await expect(button).toBeVisible()
  expect(
    await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .some((entry) => entry.name.includes('/calculation-package-')),
    ),
  ).toBe(false)
  await page
    .getByRole('button', { name: /^(Data & settings|Open data and settings)$/ })
    .filter({ visible: true })
    .click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  const download = page.waitForEvent('download')
  await button.click()
  const file = await download
  expect(file.suggestedFilename()).toBe('crystal-project-calculations-pc-1.6.9-package-v2.json')
  const path = await file.path()
  if (!path) throw new Error('Offline calculation download failed')
  const exported = JSON.parse(await readFile(path, 'utf8'))
  expect(exported.schemaVersion).toBe(2)
  expect(Object.hasOwn(exported, 'legacy')).toBe(false)
  expect(exported.combat.id).toBe(exported.combatData.engine)
  expect(exported.combatVerification.engine).toBe(exported.combat.id)
  expect(exported.previewVerification.evidence.executableSha256).toBe(exported.data.executableSha256)
  expect(exported.previewVerification.cases.some((vector: { formula: string }) => vector.formula === 'abilityPower')).toBe(true)
  expect(exported.combat.formulas.dotResistance).toBeDefined()
  expect(JSON.stringify(exported)).not.toMatch(/playthroughs|personalDefinitions|displayedStats/)
  await expect(button).toBeEnabled()
})

test.describe('failed package downloads', () => {
  test.use({ serviceWorkers: 'block' })

  test('shows load-failure recovery instructions and preserves a saved plan across reload', async ({
    page,
  }) => {
    await page.goto('/')
    await skipInitialModSetup(page)
    await createBlankPlaythrough(page)
    await page.goto('/#/builds/library/new')
    const classField = page.getByRole('combobox', { name: 'Class', exact: true })
    await classField.fill('Warrior')
    await page
      .getByRole('listbox', { name: 'Choose Class', exact: true })
      .getByRole('option')
      .filter({ has: page.locator('strong', { hasText: /^Warrior$/ }) })
      .filter({ hasText: 'Windows 1.6.9' })
      .click()
    const packageUrl = '**/assets/calculation-package-*.js'
    await page.route(packageUrl, (route) => route.abort())
    const button = page.getByRole('button', { name: 'Export calculation package', exact: true })
    const level = page.getByLabel('Calculation level', { exact: true })
    await level.fill('20')
    await button.click()
    await expect(page.getByRole('alert')).toContainText(/fetch|load|import/i)
    await expect(
      page.getByText(
        'Save any pending edits, restore your connection, and reload the page before trying again. Offline preparation includes the calculation package.',
      ),
    ).toBeVisible()
    await expect(button).toBeEnabled()
    await expect(level).toHaveValue('20')
    await page.getByRole('button', { name: 'Save build', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
    await page.unroute(packageUrl)
    await page.reload()
    const download = page.waitForEvent('download')
    await button.click()
    expect((await download).suggestedFilename()).toBe(
      'crystal-project-calculations-pc-1.6.9-package-v2.json',
    )
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(level).toHaveValue('20')
    await expect(classField).toHaveValue('Warrior')
  })
})

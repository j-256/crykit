import { MOBILE_TEST_TAG } from './test-tags'
import { saveAndApplyGameSetup, openCurrentGameSetup, createBlankPlaythrough, openGameSetupSection } from './local-data-helpers'
import { expect, test, type Page } from '@playwright/test'

async function navigate(page: Page, destination: string) {
  const name = destination === 'Builds' ? /^(Builds|Builds & teams)$/ : new RegExp(`^${destination}$`)
  await page.getByRole('button', { name }).filter({ visible: true }).click()
}

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function setHash(page: Page, hash: string) {
  await page.evaluate((nextHash) => { window.location.hash = nextHash }, hash)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(hash)
}

async function configureGameSetup(page: Page) {
  const panel = await openData(page)
  await openCurrentGameSetup(panel)
  await panel.getByLabel('Game Setup label').fill('Synthetic navigation Game Setup')
  await panel.getByRole('combobox', { name: 'Difficulty', exact: true }).selectOption('0')
  await saveAndApplyGameSetup(panel)
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
}

async function addCharacter(page: Page, name: string) {
  await navigate(page, 'Characters')
  await page.getByRole('button', { name: 'Add character', exact: true }).first().click()
  const form = page.getByRole('dialog', { name: 'Add character', exact: true })
  await form.getByLabel('Character name').fill(name)
  await form.getByRole('button', { name: 'Add character', exact: true }).click()
  await expect(form).not.toBeVisible()
  await page.getByRole('article', { name, exact: true }).getByRole('link', { name, exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/inventory')
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
})

test('character learning and nested definition routes restore exact UI state', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await addCharacter(page, 'Synthetic route keeper')
  await expect(page).toHaveURL(/#\/characters\/[^/]+\/current$/)

  const currentUrl = page.url()
  await page.goto(currentUrl.replace(/\/current$/, ''))
  await expect(page).toHaveURL(/#\/characters\/[^/]+\/current$/)
  const skills = page.getByRole('button', { name: 'Skills', exact: true })
  await expect(skills).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('region', { name: 'Character skills', exact: true })).toBeVisible()
  await skills.click()
  await expect(skills).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('region', { name: 'Character skills', exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/#\/characters\/[^/]+\/current$/)
  await skills.click()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Character skills', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Character', exact: true })).toHaveAttribute('aria-current', 'page')

  await page.getByRole('button', { name: 'Character', exact: true }).click()
  await page.getByRole('button', { name: 'Capture current sheet', exact: true }).click()
  const capture = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
  await expect(page).toHaveURL(/#\/characters\/[^/]+\/current\/snapshots\/new$/)
  const characterRoute = page.url().match(/#\/characters\/([^/]+)\/current/)
  expect(characterRoute).not.toBeNull()
  await capture.getByLabel('Level certainty', { exact: true }).selectOption('known')
  await capture.getByLabel('Level', { exact: true }).fill('17')
  await capture.getByRole('button', { name: /Choose Primary class/i }).click()
  const picker = page.getByRole('dialog', { name: 'Choose Primary class', exact: true })
  await expect(page).toHaveURL(/\/snapshots\/new\/pick\/primary-class/)
  await picker.getByRole('searchbox', { name: 'Search available definitions', exact: true }).fill('Synthetic route class')
  await picker.getByRole('button', { name: 'Create "Synthetic route class"', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Create personal definition', exact: true })
  await expect(page).toHaveURL(/\/pick\/primary-class\/definitions\/new/)

  await page.goBack()
  await expect(editor).not.toBeVisible()
  await expect(picker).toBeVisible()
  await expect(capture.getByLabel('Level', { exact: true })).toHaveValue('17')
  await page.goForward()
  await expect(editor).toBeVisible()
  await expect(capture.getByLabel('Level', { exact: true })).toHaveValue('17')

  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  await expect(picker).toBeVisible()
  await expect(page).toHaveURL(/\/snapshots\/new\/pick\/primary-class/)

  await page.evaluate((characterId) => { window.location.hash = `#/characters/${characterId}/current/snapshots/new/pick/slot/synthetic-missing-slot` }, characterRoute![1]!)
  await expect(capture.getByText('Character field unavailable', { exact: true })).toBeVisible()
  await expect(picker).not.toBeVisible()
  await expect(capture.getByLabel('Level', { exact: true })).toHaveValue('17')
  await capture.getByRole('button', { name: 'Close picker route', exact: true }).click()
  await expect(page).toHaveURL(/#\/characters\/[^/]+\/current\/snapshots\/new$/)
  await expect(capture.getByLabel('Level', { exact: true })).toHaveValue('17')
})

test('settings routes retain dirty forms and expired previews recover explicitly', async ({ page }) => {
  const panel = await openData(page)
  await expect(page).toHaveURL(/#\/settings\/data$/)
  await openCurrentGameSetup(panel)
  await expect(page).toHaveURL(/#\/settings\/game-setup\?gameSetup=/)
  await panel.getByLabel('Game Setup label').fill('Unsaved semantic route Game Setup')

  await page.evaluate(() => { window.location.hash = '#/settings/game-setup' })
  await expect(page).toHaveURL(/#\/settings\/game-setup\?gameSetup=/)
  await expect(panel.getByLabel('Game Setup label')).toHaveValue('Unsaved semantic route Game Setup')

  await page.goBack()
  await expect(page).toHaveURL(/#\/settings\/game-setup\?gameSetup=/)
  await expect(panel.getByLabel('Game Setup label')).toHaveValue('Unsaved semantic route Game Setup')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await panel.getByRole('button', { name: 'Discard and close', exact: true }).click()

  const reopened = await openData(page)
  await reopened.locator('input[type="file"]').setInputFiles({
    name: 'synthetic-navigation-reference.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schema_version: '1.1.0', classes: [{ id: 'synthetic:route', name: 'Synthetic route class' }] })),
  })
  await expect(reopened.getByText('Import preview', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/data\/import\/[^/?]+$/)
  await page.reload()
  const restored = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await expect(restored.getByText('Import preview expired', { exact: true })).toBeVisible()

  await page.evaluate(() => { window.location.hash = '#/settings/data' })
  await expect(page).toHaveURL(/#\/settings\/data$/)
  await expect(restored.getByText('Import preview expired', { exact: true })).not.toBeVisible()
})

test('build drafts, checkpoint pickers, and comparisons have restorable routes', async ({ page }) => {
  await configureGameSetup(page)
  await addCharacter(page, 'Synthetic routed character')
  await addCharacter(page, 'Synthetic routed companion 2')
  await addCharacter(page, 'Synthetic routed companion 3')
  await addCharacter(page, 'Synthetic routed companion 4')
  await navigate(page, 'Builds')
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/library\/new$/)
  const creation = page.locator('.build-sheet')
  await creation.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await creation.getByText('Build details & notes', { exact: true }).click()
  await creation.getByLabel('Build title').fill('Synthetic routed character build')
  const editor = page.locator('.build-sheet')
  await expect(page).toHaveURL(/#\/builds\/library\/new$/)
  await editor.getByLabel('Rotation or use notes').fill('Draft retained across nested history')
  await editor.getByRole('button', { name: 'Loadout', exact: true }).click()
  await editor.getByRole('combobox', { name: 'Main hand', exact: true }).click()
  const picker = page.getByRole('listbox', { name: 'Choose Main hand', exact: true })
  await expect(page).toHaveURL(/\/library\/new\/pick\/slot\/[^?]+/)
  await page.getByRole('combobox', { name: 'Main hand', exact: true }).fill('routed choice')

  await page.goBack()
  await expect(picker).not.toBeVisible()
  await editor.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await expect(editor.getByLabel('Rotation or use notes')).toHaveValue('Draft retained across nested history')
  await editor.getByRole('button', { name: 'Loadout', exact: true }).click()
  await page.goForward()
  await expect(picker).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('routed choice')
  await picker.getByRole('option', { name: /Leave empty/ }).click()

  const acceptedUrl = page.url()
  await page.evaluate(() => { window.location.hash = '#/inventory' })
  await expect(page).toHaveURL(acceptedUrl)
  await editor.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await expect(editor.getByLabel('Rotation or use notes')).toHaveValue('Draft retained across nested history')
  await editor.getByRole('button', { name: 'Loadout', exact: true }).click()
  await editor.getByRole('combobox', { name: 'Class', exact: true }).click()
  const classPicker = page.getByRole('listbox', { name: 'Choose Class', exact: true })
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Warrior')
  await classPicker.getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: /^Warrior$/ }) }).click()
  await expect(classPicker).not.toBeVisible()
  const newRevisionUrl = page.url()
  await page.locator('.context-bar').getByRole('button', { name: /^Save (build|new revision)$/ }).click()
  await expect.poll(() => page.url()).not.toBe(newRevisionUrl)
  await expect(page).toHaveURL(/\/revisions\/[^/]+\/edit$/)
  const firstRevisionRoute = page.url().match(/#\/builds\/library\/([^/]+)\/revisions\/([^/?]+)/)
  expect(firstRevisionRoute).not.toBeNull()

  const secondEditor = page.locator('.build-sheet')
  await secondEditor.getByRole('combobox', { name: 'Class', exact: true }).click()
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option', { name: /Leave empty/ }).click()
  await secondEditor.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  await secondEditor.getByText('Build details & notes', { exact: true }).click()
  await secondEditor.getByLabel('Checkpoint name').fill('Second routed checkpoint')
  const firstRevisionUrl = page.url()
  await page.locator('.context-bar').getByRole('button', { name: /^Save (build|new revision)$/ }).click()
  await expect.poll(() => page.url()).not.toBe(firstRevisionUrl)
  const secondRevisionRoute = page.url().match(/#\/builds\/library\/([^/]+)\/revisions\/([^/?]+)/)
  expect(secondRevisionRoute).not.toBeNull()
  expect(secondRevisionRoute?.[2]).not.toBe(firstRevisionRoute?.[2])

  await page.evaluate(({ buildId, revisionId }) => { window.location.hash = `#/builds/library/${buildId}/revisions/${revisionId}/edit/pick/slot/synthetic-missing-slot` }, { buildId: secondRevisionRoute![1]!, revisionId: secondRevisionRoute![2]! })
  await expect(page.getByText('Build field unavailable', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close picker route', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/builds/library/${secondRevisionRoute![1]!}/revisions/${secondRevisionRoute![2]!}/edit`)

  await setHash(page, `#/builds/library/${secondRevisionRoute![1]!}/revisions/${secondRevisionRoute![2]!}/record-current`)
  const recording = page.locator('dialog').filter({ has: page.getByRole('heading', { name: 'Compare and record Build', exact: true }) })
  await expect(recording).toContainText('Synthetic routed character build r2')
  await recording.getByRole('combobox', { name: /^Character/ }).selectOption({ label: 'Synthetic routed character' })
  const confirmation = recording.getByRole('checkbox', { name: /I made these changes in game/ })
  await confirmation.check()
  await setHash(page, `#/builds/library/${firstRevisionRoute![1]!}/revisions/${firstRevisionRoute![2]!}/record-current`)
  await expect(recording).toContainText('Synthetic routed character build r1')
  await expect(confirmation).not.toBeChecked()
  await confirmation.check()
  await recording.getByRole('button', { name: 'Record as current', exact: true }).click()
  await expect(recording).not.toBeVisible()
  await navigate(page, 'Characters')
  await expect(page.getByRole('article', { name: 'Synthetic routed character', exact: true }).getByText('Warrior', { exact: true })).toBeVisible()

  await navigate(page, 'Builds')
  await page.getByRole('button', { name: 'Compare revisions', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/compare$/)
  await page.getByLabel('Revision A').selectOption({ index: 1 })
  await page.getByLabel('Revision B').selectOption({ index: 2 })
  await expect(page).toHaveURL(/#\/builds\/compare\/[^/]+\/[^/]+$/)
  const comparisonUrl = page.url()
  await page.reload()
  await expect(page).toHaveURL(comparisonUrl)
  await expect(page.getByLabel('Revision A')).not.toHaveValue('')
  await expect(page.getByLabel('Revision B')).not.toHaveValue('')

  await page.goto('/#/builds/teams')
  await expect(page).toHaveURL(/#\/builds\/teams$/)
  await page.getByRole('button', { name: 'New party plan', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/teams\/new$/)
})

test('malformed semantic routes recover without choosing a record', async ({ page }) => {
  await page.evaluate(() => { window.location.hash = '#/characters/%E0%A4%A/current' })
  await expect(page.getByRole('heading', { name: 'This link could not be opened', exact: true })).toBeVisible()
  await expect(page.getByText('No record was selected', { exact: true })).toBeVisible()
})

test('prototype-shaped missing IDs use record recovery', async ({ page }) => {
  const routes = [
    ['#/characters/__proto__/current', 'Character unavailable'],
    ['#/inventory/items/__proto__/edit', 'Inventory entry unavailable'],
    ['#/progress/__proto__/edit', 'Progress record unavailable'],
    ['#/builds/library/__proto__/revisions/new', 'Build unavailable'],
    ['#/builds/teams/__proto__', 'Party plan unavailable'],
    ['#/builds/compare/__proto__/constructor', 'Comparison checkpoint unavailable'],
  ] as const

  for (const [hash, notice] of routes) {
    await setHash(page, hash)
    await expect(page.getByText(notice, { exact: true })).toBeVisible()
    await expect(page.getByText('Application recovery', { exact: true })).not.toBeVisible()
  }
})

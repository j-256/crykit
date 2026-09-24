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

async function configureRuleset(page: Page) {
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Ruleset', exact: true }).click()
  await panel.getByLabel('Ruleset label').fill('Synthetic navigation ruleset')
  await panel.getByRole('button', { name: 'Add slot', exact: true }).click()
  await panel.getByLabel('Slot 1', { exact: true }).fill('Main hand')
  await panel.getByRole('button', { name: 'Create ruleset', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click()
}

async function addCharacter(page: Page, name: string) {
  await navigate(page, 'Characters')
  await page.getByRole('button', { name: 'Add character', exact: true }).first().click()
  const form = page.getByRole('dialog', { name: 'Add character', exact: true })
  await form.getByLabel('Character name').fill(name)
  await form.getByRole('button', { name: 'Add character', exact: true }).click()
  await expect(form).not.toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
})

test('character tabs and nested definition routes restore exact UI state', async ({ page }) => {
  await addCharacter(page, 'Synthetic route keeper')
  await expect(page).toHaveURL(/#\/characters\/[^/]+\/current$/)

  await page.getByRole('tab', { name: 'Monster Magic', exact: true }).click()
  await expect(page).toHaveURL(/#\/characters\/[^/]+\/magic$/)
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Monster Magic', exact: true })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: 'Current', exact: true }).click()
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
  await panel.getByRole('button', { name: 'Ruleset', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings\/ruleset$/)
  await panel.getByLabel('Ruleset label').fill('Unsaved semantic route ruleset')

  await page.goBack()
  await expect(page).toHaveURL(/#\/settings\/ruleset$/)
  await expect(panel.getByLabel('Ruleset label')).toHaveValue('Unsaved semantic route ruleset')
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click()

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

test('build drafts, checkpoint pickers, and comparisons have restorable routes', async ({ page, isMobile }) => {
  await configureRuleset(page)
  await addCharacter(page, 'Synthetic routed character')
  await navigate(page, 'Builds')
  await page.getByRole('button', { name: 'New build', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/library\/new$/)
  const creation = page.getByRole('dialog', { name: 'Create build', exact: true })
  await creation.getByLabel('Build title').fill('Synthetic routed character build')
  await creation.getByRole('button', { name: 'Create build', exact: true }).click()
  if (isMobile) await page.getByRole('button', { name: 'Edit selected build', exact: true }).click()
  const editor = isMobile ? page.getByRole('dialog', { name: 'Synthetic routed character build', exact: true }) : page.locator('.build-column').filter({ has: page.getByRole('button', { name: 'Save new revision', exact: true }) })
  await expect(page).toHaveURL(/#\/builds\/library\/[^/]+\/revisions\/new$/)
  await editor.getByLabel('Rotation or use notes').fill('Draft retained across nested history')
  await editor.getByRole('button', { name: 'Main hand Empty slot', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose Main hand', exact: true })
  await expect(page).toHaveURL(/\/revisions\/new\/pick\/slot\/[^?]+/)
  await picker.getByRole('searchbox', { name: 'Search available definitions', exact: true }).fill('routed choice')

  await page.goBack()
  await expect(picker).not.toBeVisible()
  await expect(editor.getByLabel('Rotation or use notes')).toHaveValue('Draft retained across nested history')
  await page.goForward()
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('searchbox', { name: 'Search available definitions', exact: true })).toHaveValue('routed choice')
  await picker.getByRole('button', { name: /Leave empty/ }).click()

  const acceptedUrl = page.url()
  await page.evaluate(() => { window.location.hash = '#/inventory' })
  await expect(page).toHaveURL(acceptedUrl)
  await expect(editor.getByLabel('Rotation or use notes')).toHaveValue('Draft retained across nested history')
  await editor.getByRole('button', { name: 'Primary class Unselected', exact: true }).click()
  const classPicker = page.getByRole('dialog', { name: 'Choose Primary class', exact: true })
  await classPicker.getByRole('searchbox', { name: 'Search available definitions', exact: true }).fill('Synthetic historical class')
  await classPicker.getByRole('button', { name: 'Create "Synthetic historical class"', exact: true }).click()
  const classEditor = page.getByRole('dialog', { name: 'Create personal definition', exact: true })
  await classEditor.getByRole('button', { name: 'Create definition', exact: true }).click()
  await expect(classEditor).not.toBeVisible()
  await expect(classPicker).not.toBeVisible()
  const newRevisionUrl = page.url()
  await editor.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect.poll(() => page.url()).not.toBe(newRevisionUrl)
  await expect(page).toHaveURL(isMobile ? /\/revisions\/[^/]+$/ : /\/revisions\/[^/]+\/edit$/)
  const firstRevisionRoute = page.url().match(/#\/builds\/library\/([^/]+)\/revisions\/([^/?]+)/)
  expect(firstRevisionRoute).not.toBeNull()

  if (isMobile) await page.getByRole('button', { name: 'Edit selected build', exact: true }).click()
  const secondEditor = isMobile ? page.getByRole('dialog', { name: 'Synthetic routed character build', exact: true }) : page.locator('.build-column').filter({ has: page.getByRole('button', { name: 'Save new revision', exact: true }) })
  await secondEditor.getByRole('button', { name: 'Primary class Synthetic historical class', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose Primary class', exact: true }).getByRole('button', { name: /Leave empty/ }).click()
  await secondEditor.getByLabel('Checkpoint name').fill('Second routed checkpoint')
  const firstRevisionUrl = page.url()
  await secondEditor.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect.poll(() => page.url()).not.toBe(firstRevisionUrl)
  const secondRevisionRoute = page.url().match(/#\/builds\/library\/([^/]+)\/revisions\/([^/?]+)/)
  expect(secondRevisionRoute).not.toBeNull()
  expect(secondRevisionRoute?.[2]).not.toBe(firstRevisionRoute?.[2])

  await page.evaluate(({ buildId, revisionId }) => { window.location.hash = `#/builds/library/${buildId}/revisions/${revisionId}/edit/pick/slot/synthetic-missing-slot` }, { buildId: secondRevisionRoute![1]!, revisionId: secondRevisionRoute![2]! })
  await expect(page.getByText('Build field unavailable', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close picker route', exact: true }).click()

  await setHash(page, `#/builds/library/${secondRevisionRoute![1]!}/revisions/${secondRevisionRoute![2]!}/record-current`)
  const recording = page.getByRole('dialog', { name: 'Record build as current', exact: true })
  await expect(recording.getByText(/revision 2/)).toBeVisible()
  const confirmation = recording.getByRole('checkbox', { name: /I made these changes in game/ })
  await confirmation.check()
  await setHash(page, `#/builds/library/${firstRevisionRoute![1]!}/revisions/${firstRevisionRoute![2]!}/record-current`)
  await expect(recording.getByText(/revision 1/)).toBeVisible()
  await expect(confirmation).not.toBeChecked()
  await confirmation.check()
  await recording.getByRole('button', { name: 'Record as current', exact: true }).click()
  await navigate(page, 'Characters')
  await expect(page.getByText('Synthetic historical class', { exact: true }).first()).toBeVisible()

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

  await page.getByRole('button', { name: 'Team scenarios', exact: true }).click()
  await expect(page).toHaveURL(/#\/builds\/teams$/)
  await page.getByRole('button', { name: 'New scenario', exact: true }).click()
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
    ['#/builds/teams/__proto__', 'Team scenario unavailable'],
    ['#/builds/compare/__proto__/constructor', 'Comparison checkpoint unavailable'],
  ] as const

  for (const [hash, notice] of routes) {
    await setHash(page, hash)
    await expect(page.getByText(notice, { exact: true })).toBeVisible()
    await expect(page.getByText('Application recovery', { exact: true })).not.toBeVisible()
  }
})

import { expect, test } from '@playwright/test'
import { newMapProject } from '../../src/mod-inspector/map-editor'

const LOCAL_EDITOR_COMMAND_MS = 15_000
const REMOTE_EDITOR_PROJECTION_MS = 60_000
const editorRoute = '/__accounts-proof/account-workspace.html#/mods/editor'
test('guest unfinished JSON survives successive quiet saves and reload without applying', async ({ page }) => {
  await page.goto(editorRoute)
  await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'durable-editor.json', mimeType: 'application/json', buffer: Buffer.from('{"Name":"Original","Count":1}') })
  await expect(page.getByRole('button', { name: 'Edit whole document JSON', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
  const field = page.getByRole('textbox', { name: /^Exact JSON value/ })
  await field.fill('{"broken":')
  await field.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 7, 'backward'))
  await expect(page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })).toBeEnabled()
  await expect(field).toHaveValue('{"broken":')
  await expect(field).toBeFocused()
  expect(await field.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd, direction: (element as HTMLTextAreaElement).selectionDirection }))).toEqual({ start: 2, end: 7, direction: 'backward' })
  await field.fill('{"still-broken":')
  await expect(page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })).toBeEnabled()
  await expect(field).toHaveValue('{"still-broken":')
  await page.reload()
  const files = page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })
  const option = files.locator('option').filter({ hasText: 'durable-editor.json' })
  await expect(option).toHaveCount(1)
  await files.selectOption((await option.getAttribute('value'))!)
  await expect(field).toHaveValue('{"still-broken":')
  await expect(page.locator('.inspector-error')).toBeVisible()
  await expect(page.locator('.inspector-tree')).toContainText('Original')
})

test('account unfinished JSON reopens on a second browser with exact original and applied separation', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })])
  const [first, second] = await Promise.all(contexts.map(context => context.newPage()))
  const pollRequests: number[] = []
  second.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/sync/changes') pollRequests.push(Date.now()) })
  const password = 'synthetic editor persistence test password'
  const username = `editor_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
  const email = `${username}@example.org`
  try {
    await first.goto('/__accounts-proof/')
    await expect(first.locator('#status')).toHaveText('Browser worker and offline cache ready')
    await first.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await first.request.post('/__accounts/jobs')
    const emails = await (await first.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
    await first.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(row => row.recipient === email)!.capability)
    for (const page of [first, second]) {
      await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
      await page.getByLabel('Email', { exact: true }).fill(email)
      await page.getByLabel('Password', { exact: true }).fill(password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
      await page.evaluate(() => { window.location.hash = '#/mods/editor' })
      await expect(page.getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
    }
    const importStarted = Date.now()
    await first.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'private-editor.json', mimeType: 'application/json', buffer: Buffer.from('{"Name":"Exact original","Count":1}\r\n') })
    await expect(first.getByRole('button', { name: 'Edit whole document JSON', exact: true })).toBeVisible({ timeout: LOCAL_EDITOR_COMMAND_MS })
    console.info('editor-local-import', { elapsedMilliseconds: Date.now() - importStarted })
    await first.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
    const field = first.getByRole('textbox', { name: /^Exact JSON value/ })
    await first.evaluate(() => (window as unknown as { workspaceProof: { captureEditorAuthority(): void } }).workspaceProof.captureEditorAuthority())
    const saveStarted = Date.now()
    await field.fill('{"private unfinished":')
    await expect(first.getByRole('combobox', { name: 'Files opened in this tool', exact: true })).toBeEnabled({ timeout: LOCAL_EDITOR_COMMAND_MS })
    await expect(field).toHaveValue('{"private unfinished":')
    expect(await first.evaluate(() => (window as unknown as { workspaceProof: { inspectCapturedEditorAuthority(): unknown } }).workspaceProof.inspectCapturedEditorAuthority())).toEqual({ sameProfile: true, repositoryCurrent: false, viewRetired: true })
    console.info('editor-local-unfinished', { elapsedMilliseconds: Date.now() - saveStarted })
    await expect(first.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 90_000 })
    const projectionDeadline = Date.now() + REMOTE_EDITOR_PROJECTION_MS
    const remainingProjection = () => Math.max(1, projectionDeadline - Date.now())
    const files = second.getByRole('combobox', { name: 'Files opened in this tool', exact: true })
    const option = files.locator('option').filter({ hasText: 'private-editor.json' })
    await expect(option).toHaveCount(1, { timeout: remainingProjection() })
    await files.selectOption((await option.getAttribute('value'))!)
    await expect(second.getByRole('textbox', { name: /^Exact JSON value/ })).toHaveValue('{"private unfinished":', { timeout: remainingProjection() })
    await expect(second.getByRole('textbox', { name: /^Exact JSON value/ })).toBeEnabled({ timeout: remainingProjection() })
    await expect(second.locator('.inspector-tree')).toContainText('Exact original', { timeout: remainingProjection() })
    const reopened = await second.evaluate(() => (window as unknown as { workspaceProof: { editorContent(): Promise<{ original: number[]; appliedText: string; unfinishedText: string }> } }).workspaceProof.editorContent())
    expect(reopened.original).toEqual(Array.from(Buffer.from('{"Name":"Exact original","Count":1}\r\n')))
    expect(reopened.appliedText).toBe('{"Name":"Exact original","Count":1}\r\n')
    expect(reopened.unfinishedText).toBe('{"private unfinished":\r\n')
    expect(Date.now()).toBeLessThanOrEqual(projectionDeadline)
    console.info('editor-remote-projection', { elapsedMilliseconds: REMOTE_EDITOR_PROJECTION_MS - remainingProjection(), changesRequestOffsetsMilliseconds: pollRequests.map(at => at - (projectionDeadline - REMOTE_EDITOR_PROJECTION_MS)), pollGapsMilliseconds: pollRequests.slice(1).map((at, index) => at - pollRequests[index]) })
    const downloadPromise = second.waitForEvent('download')
    await second.getByRole('button', { name: 'Download original', exact: true }).click()
    const download = await downloadPromise, stream = await download.createReadStream(), chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('{"Name":"Exact original","Count":1}\r\n'))
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('navigation flush keeps invalid text and continues only after owned hydration', async ({ page }) => {
  await page.goto(editorRoute)
  await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'navigation.json', mimeType: 'application/json', buffer: Buffer.from('{"Count":1}') })
  await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
  await page.getByRole('textbox', { name: /^Exact JSON value/ }).fill('{"pending":')
  await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Builds', exact: true }).click()
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await page.evaluate(() => { window.location.hash = '#/mods/editor' })
  await expect(page.getByRole('textbox', { name: /^Exact JSON value/ })).toHaveValue('{"pending":')
})


test('composition defers autosave and preserves the final composed input and selection', async ({ page }) => {
  await page.goto(editorRoute)
  await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'composition.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
  await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
  const field = page.getByRole('textbox', { name: /^Exact JSON value/ })
  await field.dispatchEvent('compositionstart')
  await field.fill('{"composed":')
  await page.waitForTimeout(900)
  expect(await page.evaluate(() => (window as unknown as { workspaceProof: { editorDiagnostics(): { pending: boolean; dirty: boolean } } }).workspaceProof.editorDiagnostics())).toMatchObject({ pending: false, dirty: true })
  await field.dispatchEvent('compositionend')
  await expect(page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })).toBeEnabled({ timeout: LOCAL_EDITOR_COMMAND_MS })
  await expect(field).toHaveValue('{"composed":')
  await expect(field).toBeFocused()
})

test('unfinished map coordinates, tool and validation reopen without applying map bytes', async ({ page }) => {
  await page.goto(editorRoute)
  await page.getByRole('button', { name: 'New map mod', exact: true }).click()
  await page.getByRole('link', { name: 'Map Editor', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Voxel platform', exact: true }).click()
  await page.getByRole('textbox', { name: 'Placement X', exact: true }).fill('-')
  await page.getByRole('button', { name: 'Add voxel platform', exact: true }).click()
  await expect(page.getByText('Enter an integer for X, height Y and Z before applying the placement.', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })).toBeEnabled({ timeout: LOCAL_EDITOR_COMMAND_MS })
  await page.reload()
  const files = page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })
  const option = files.locator('option').filter({ hasNotText: 'Choose a recent file' }).last()
  await files.selectOption((await option.getAttribute('value'))!)
  await expect(page.getByRole('button', { name: 'Voxel platform', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('textbox', { name: 'Placement X', exact: true })).toHaveValue('-')
  await expect(page.getByText('Enter an integer for X, height Y and Z before applying the placement.', { exact: true })).toBeVisible()
})

async function accountPair(browser: import('@playwright/test').Browser, baseURL: string | undefined) {
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })])
  const [first, second] = await Promise.all(contexts.map(context => context.newPage()))
  const username = `editor_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`, password = 'synthetic editor map password'
  try {
    await first.goto('/__accounts-proof/')
    await expect(first.locator('#status')).toHaveText('Browser worker and offline cache ready')
    await first.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await first.request.post('/__accounts/jobs')
    const emails = await (await first.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
    await first.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(row => row.recipient === email)!.capability)
    for (const page of [first, second]) {
      await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
      await page.getByLabel('Email', { exact: true }).fill(email)
      await page.getByLabel('Password', { exact: true }).fill(password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
      await page.evaluate(() => { window.location.hash = '#/mods/editor' })
      await expect(page.getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
    }
    return { first, second, close: () => Promise.all(contexts.map(context => context.close())) }
  } catch (error) { await Promise.all(contexts.map(context => context.close())); throw error }
}

for (const failure of ['integer', 'dimensions', 'bounds'] as const) test(`encrypted map fields and ${failure} placement validation reopen on another browser`, async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const { first, second, close } = await accountPair(browser, baseURL)
  try {
    const localFiles = first.getByRole('combobox', { name: 'Files opened in this tool', exact: true })
    async function localCommand(operation: string, action: (remaining: () => number) => Promise<void>, verify: (remaining: () => number) => Promise<void> = async () => {}) {
      const started = Date.now(), deadline = started + LOCAL_EDITOR_COMMAND_MS
      const remaining = () => Math.max(1, deadline - Date.now())
      await action(remaining)
      await expect(localFiles).toBeEnabled({ timeout: remaining() })
      await verify(remaining)
      const elapsedMilliseconds = Date.now() - started
      expect(elapsedMilliseconds).toBeLessThanOrEqual(LOCAL_EDITOR_COMMAND_MS)
      console.info('editor-map-command', { operation, elapsedMilliseconds })
    }
    const source = newMapProject('synthetic-validation', '2026-01-01T00:00:00.000Z').replace('"Entities": []', '"Entities": [{"ID":1,"Coord":{"X":10,"Y":20,"Z":30},"BiomeID":1,"EntityType":5,"TreasureData":{"LootType":2,"LootValue":18}}]')
    if (failure === 'integer') await localCommand('create', remaining => first.getByRole('button', { name: 'New map mod', exact: true }).click({ timeout: remaining() }))
    else await localCommand('import', remaining => first.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'map-placements.json', mimeType: 'application/json', buffer: Buffer.from(source) }, { timeout: remaining() }))
    await first.getByRole('link', { name: 'Map Editor', exact: true }).filter({ visible: true }).click()
    if (failure !== 'integer') await localCommand('select', remaining => first.locator('.map-editor-placement-list button').filter({ hasText: 'Treasure #1' }).click({ timeout: remaining() }))
    const x = failure === 'integer' ? '-' : failure === 'dimensions' ? '42' : '2147483648'
    const validationError = failure === 'integer' ? 'Enter an integer for X, height Y and Z before applying the placement.' : failure === 'dimensions' ? 'Platform width and depth must be between 1 and 8.' : 'Placement coordinates must be signed 32-bit integers.'
    // Separate user commands can each trigger quiet persistence; keep one shared budget per complete command
    await localCommand('tool', remaining => first.getByRole('button', { name: 'Voxel platform', exact: true }).click({ timeout: remaining() }), remaining => expect(first.getByRole('button', { name: 'Voxel platform', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: remaining() }))
    await localCommand('coordinate', async remaining => {
      await first.getByRole('textbox', { name: 'Placement X', exact: true }).fill(x, { timeout: remaining() })
      if (failure !== 'integer') {
        await first.getByRole('textbox', { name: 'Placement height Y', exact: true }).fill('50', { timeout: remaining() })
        await first.getByRole('textbox', { name: 'Placement Z', exact: true }).fill('60', { timeout: remaining() })
        if (failure === 'dimensions') await first.locator('[data-editor-focus="map-width"]').fill('0', { timeout: remaining() })
      }
    }, remaining => expect(first.getByRole('textbox', { name: 'Placement X', exact: true })).toHaveValue(x, { timeout: remaining() }))
    await localCommand('validation', remaining => first.getByRole('button', { name: 'Add voxel platform', exact: true }).click({ timeout: remaining() }), async remaining => {
      await expect(first.getByText(validationError, { exact: true })).toBeVisible({ timeout: remaining() })
      await expect(first.getByRole('textbox', { name: 'Placement X', exact: true })).toHaveValue(x, { timeout: remaining() })
    })
    const captured = await first.evaluate(() => (window as unknown as { workspaceProof: { editorContent(): Promise<{ original: number[]; appliedText: string; unfinishedText: string }> } }).workspaceProof.editorContent())
    if (failure !== 'integer') expect(captured).toMatchObject({ original: Array.from(Buffer.from(source)), appliedText: source, unfinishedText: source })
    await expect(first.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 90_000 })
    const deadline = Date.now() + REMOTE_EDITOR_PROJECTION_MS, remaining = () => Math.max(1, deadline - Date.now())
    const files = second.getByRole('combobox', { name: 'Files opened in this tool', exact: true }), option = files.locator('option').filter({ hasText: 'map-placements.json' })
    await expect(option).toHaveCount(1, { timeout: remaining() })
    await files.selectOption((await option.getAttribute('value'))!)
    await expect(second.getByRole('textbox', { name: 'Placement X', exact: true })).toHaveValue(x, { timeout: remaining() })
    await expect(second.getByRole('textbox', { name: 'Placement X', exact: true })).toBeEnabled({ timeout: remaining() })
    await expect(second.getByRole('button', { name: 'Voxel platform', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: remaining() })
    await expect(second.getByText(validationError, { exact: true })).toBeVisible({ timeout: remaining() })
    if (failure !== 'integer') {
      await expect(second.getByRole('textbox', { name: 'Placement height Y', exact: true })).toHaveValue('50', { timeout: remaining() })
      await expect(second.getByRole('textbox', { name: 'Placement Z', exact: true })).toHaveValue('60', { timeout: remaining() })
      if (failure === 'dimensions') await expect(second.locator('[data-editor-focus="map-width"]')).toHaveValue('0', { timeout: remaining() })
    }
    expect(await second.evaluate(() => (window as unknown as { workspaceProof: { editorContent(): Promise<{ original: number[]; appliedText: string; unfinishedText: string }> } }).workspaceProof.editorContent())).toEqual(captured)
    expect(Date.now()).toBeLessThanOrEqual(deadline)
    console.info('editor-map-remote-projection', { elapsedMilliseconds: Date.now() - (deadline - REMOTE_EDITOR_PROJECTION_MS) })
  } finally { await close() }
})

test('live placement drag defers remount and preserves camera and released coordinates', async ({ page }) => {
  const source = newMapProject('synthetic-gesture', '2026-01-01T00:00:00.000Z').replace('"Entities": []', '"Entities": [{"ID":1,"Coord":{"X":-12,"Y":99,"Z":4},"BiomeID":1,"EntityType":5,"TreasureData":{"LootType":2,"LootValue":18}}]')
  await page.goto(editorRoute)
  await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'gesture.json', mimeType: 'application/json', buffer: Buffer.from(source) })
  await page.getByRole('link', { name: 'Map Editor', exact: true }).filter({ visible: true }).click()
  await page.locator('.map-editor-placement-list button').filter({ hasText: 'Treasure #1' }).click()
  const files = page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })
  await expect(files).toBeEnabled({ timeout: LOCAL_EDITOR_COMMAND_MS })
  await page.getByRole('button', { name: 'Rotate view right', exact: true }).click()
  const svg = page.locator('.iso-canvas')
  const rotation = await svg.getAttribute('data-rotation')
  await svg.scrollIntoViewIfNeeded()
  const box = (await page.locator('[data-placement-id="1"]').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  expect(await page.evaluate(() => (window as unknown as { workspaceProof: { editorDiagnostics(): { canTransfer: boolean } } }).workspaceProof.editorDiagnostics())).toMatchObject({ canTransfer: false })
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10)
  await page.waitForTimeout(900)
  expect(await page.evaluate(() => (window as unknown as { workspaceProof: { editorDiagnostics(): { pending: boolean; canTransfer: boolean } } }).workspaceProof.editorDiagnostics())).toMatchObject({ pending: false, canTransfer: false })
  await page.mouse.up()
  await expect(files).toBeEnabled({ timeout: LOCAL_EDITOR_COMMAND_MS })
  await expect(svg).toHaveAttribute('data-rotation', rotation!)
  const saved = await page.evaluate(() => (window as unknown as { workspaceProof: { editorContent(): Promise<{ original: number[]; appliedText: string; unfinishedText: string }> } }).workspaceProof.editorContent())
  expect(saved.original).toEqual(Array.from(Buffer.from(source)))
  expect(saved.appliedText).toBe(source)
  expect(saved.unfinishedText).not.toBe(source)
})

test('remote encrypted drafts wait for dirty input and install after explicit discard', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const { first, second, close } = await accountPair(browser, baseURL)
  try {
    await first.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'dirty-remote.json', mimeType: 'application/json', buffer: Buffer.from('{"base":1}') })
    await expect(first.getByRole('button', { name: 'Edit whole document JSON', exact: true })).toBeVisible({ timeout: LOCAL_EDITOR_COMMAND_MS })
    await expect(first.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 90_000 })
    const files = second.getByRole('combobox', { name: 'Files opened in this tool', exact: true }), option = files.locator('option').filter({ hasText: 'dirty-remote.json' })
    await expect(option).toHaveCount(1, { timeout: REMOTE_EDITOR_PROJECTION_MS })
    await files.selectOption((await option.getAttribute('value'))!)
    await second.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
    const local = second.getByRole('textbox', { name: /^Exact JSON value/ })
    await local.dispatchEvent('compositionstart')
    await local.fill('{"keep-local":')
    await first.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
    await first.getByRole('textbox', { name: /^Exact JSON value/ }).fill('{"remote":')
    await expect(first.getByRole('combobox', { name: 'Files opened in this tool', exact: true })).toBeEnabled({ timeout: LOCAL_EDITOR_COMMAND_MS })
    await expect(first.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 90_000 })
    await second.evaluate(() => (window as unknown as { workspaceProof: { flushSync(): void } }).workspaceProof.flushSync())
    await expect(second.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Sync paused', { timeout: REMOTE_EDITOR_PROJECTION_MS })
    await expect(local).toHaveValue('{"keep-local":')
    expect(await second.evaluate(() => (window as unknown as { workspaceProof: { editorDiagnostics(): { dirty: boolean } } }).workspaceProof.editorDiagnostics())).toMatchObject({ dirty: true })
    await second.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Builds', exact: true }).click()
    await second.getByRole('button', { name: 'Discard and continue', exact: true }).click()
    await expect(second.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
    // A paused scheduler requires the explicit retry action after its draft guard clears
    await second.getByRole('button', { name: 'Retry', exact: true }).click()
    const deadline = Date.now() + REMOTE_EDITOR_PROJECTION_MS, remaining = () => Math.max(1, deadline - Date.now())
    await expect(second.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: remaining() })
    await second.evaluate(() => { window.location.hash = '#/mods/editor' })
    await expect(local).toHaveValue('{"remote":', { timeout: remaining() })
    await expect(local).toBeEnabled({ timeout: remaining() })
  } finally { await close() }
})

test('unattempted Move input survives quiet persistence and reload without claiming a failed action', async ({ page }) => {
  const source = newMapProject('synthetic-unattempted', '2026-01-01T00:00:00.000Z').replace('"Entities": []', '"Entities": [{"ID":1,"Coord":{"X":10,"Y":20,"Z":30},"BiomeID":1,"EntityType":5,"TreasureData":{"LootType":2,"LootValue":18}}]')
  await page.goto(editorRoute)
  const files = page.getByRole('combobox', { name: 'Files opened in this tool', exact: true })
  let deadline = Date.now() + LOCAL_EDITOR_COMMAND_MS
  const remaining = () => Math.max(1, deadline - Date.now())
  await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'unattempted.json', mimeType: 'application/json', buffer: Buffer.from(source) }, { timeout: remaining() })
  await expect(files).toBeEnabled({ timeout: remaining() })
  await page.getByRole('link', { name: 'Map Editor', exact: true }).filter({ visible: true }).click()
  deadline = Date.now() + LOCAL_EDITOR_COMMAND_MS
  await page.locator('.map-editor-placement-list button').filter({ hasText: 'Treasure #1' }).click({ timeout: remaining() })
  await expect(files).toBeEnabled({ timeout: remaining() })
  deadline = Date.now() + LOCAL_EDITOR_COMMAND_MS
  await page.getByRole('textbox', { name: 'Placement X', exact: true }).fill('-', { timeout: remaining() })
  await expect(files).toBeEnabled({ timeout: remaining() })
  await expect(page.getByRole('textbox', { name: 'Placement X', exact: true })).toHaveValue('-', { timeout: remaining() })
  await expect(page.getByText('Map edit was not applied', { exact: true })).toHaveCount(0, { timeout: remaining() })
  await page.reload()
  const option = files.locator('option').filter({ hasText: 'unattempted.json' })
  await expect(option).toHaveCount(1)
  await files.selectOption((await option.getAttribute('value'))!)
  await expect(page.getByRole('textbox', { name: 'Placement X', exact: true })).toHaveValue('-')
  await expect(page.getByText('Map edit was not applied', { exact: true })).toHaveCount(0)
  const content = await page.evaluate(() => (window as unknown as { workspaceProof: { editorContent(): Promise<unknown> } }).workspaceProof.editorContent())
  expect(content).toMatchObject({ original: Array.from(Buffer.from(source)), appliedText: source, unfinishedText: source, fieldState: { map: { tool: 'move', selectedId: 1, dirty: true, values: { X: '-', Y: '20', Z: '30' } } } })
})

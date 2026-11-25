import { expect, test, type Page, type BrowserContext, type TestInfo } from './accounts/test-fixture'
import { cpus, platform, release, totalmem } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { installSaveWorkCounters } from './local-save-work-counters'
import type { SaveApplyProof } from '../worker/testing/local-save-oracle'
import { PERFORMANCE_EDITOR_ID, PERFORMANCE_SAVE_ID } from '../worker/testing/local-save-workload'

const SAVE_CEILING_MS = 1000
const REPEATED_SAVES = 30
const MAX_MAPPING_SAMPLE_ATTEMPTS = 2
const NEXT_INPUT_KEY = 'Space'
const operations = ['Build notes', 'progress tile', 'invalid Editor draft', 'valid Editor Apply', 'Save inventory'] as const
type Operation = typeof operations[number]
type SaveApplyProofWindow = typeof window & { localSaveProof: SaveApplyProof & { diagnostics(): Record<string, unknown> } }
interface BodyRecord { key: string; kind: string; ref: { documentId: string; revisionId: string }; digest: string; storageId: string }
const bodyKey = (ref: { documentId: string; revisionId: string }) => JSON.stringify(['blob', JSON.stringify([ref.documentId, ref.revisionId])])
function consumedKeys(file: any, operation: Operation): Set<string> {
  if (operation === 'Save inventory') return new Set([file.original, file.working].map(bodyKey))
  if (operation.includes('Editor')) return new Set([file.original, file.lastApplied, file.unfinished.text].map(bodyKey))
  return new Set()
}

async function arm(page: Page, event: 'click' | 'input', selector: string, withMapping = false, nextInput?: Parameters<Window['armSaveWork']>[2], captureSaveApply = false) {
  if (withMapping) await ensureMapping(page)
  return page.evaluate(({ event, selector, nextInput, captureSaveApply }) => {
    const attempt = captureSaveApply ? (window as SaveApplyProofWindow).localSaveProof.beginSaveApply() : undefined
    window.armSaveWork(event, selector, nextInput)
    return attempt
  }, { event, selector, nextInput, captureSaveApply })
}
async function ensureMapping(page: Page) {
  // Reuse real in-flight projection across edits; draining it per save serializes bulk work
  // A worker reply can precede main-profile activation, so start another only after that tail settles
  await page.waitForFunction(async () => {
    const proof = (window as any).localSaveProof, state = proof.mapping()
    if (state.error) throw new Error(state.error)
    const replies = new Set(window.mapperEvents.filter(event => event.direction === 'received').map(event => event.id))
    if (window.mapperEvents.some(event => event.direction === 'sent' && event.kind === 'map' && !replies.has(event.id))) return true
    if (!state.pending) await proof.startMapping()
    return false
  })
}
async function diagnostics(page: Page) { return page.evaluate(() => (window as any).localSaveProof.diagnostics()) }
async function inspect(page: Page, kind: 'planner' | 'save' | 'editor') { return page.evaluate(kind => (window as any).localSaveProof.inspect(kind), kind) }
async function idle(page: Page, kind: 'save' | 'editor', savedLabel?: string, captureReadiness = false) {
  await page.waitForFunction(({ kind, savedLabel, captureReadiness }) => {
    const state = (window as any).localSaveProof.diagnostics()
    const label = savedLabel === undefined ? undefined : document.querySelector<HTMLElement>('.inspector-save-state')
    const bounds = label?.getBoundingClientRect()
    const acknowledged = savedLabel === undefined || !!label && label.textContent === savedLabel && !!bounds?.width && !!bounds?.height && getComputedStyle(label).visibility === 'visible'
    const field = captureReadiness ? document.querySelector<HTMLTextAreaElement>('.inspector-editor textarea') : undefined
    const fieldBounds = field?.getBoundingClientRect()
    const editable = !captureReadiness || !!field && !field.disabled && !field.readOnly && !!fieldBounds?.width && !!fieldBounds?.height && getComputedStyle(field).visibility === 'visible'
    const ready = editable && acknowledged && state.current && !state.pending && state[`${kind}Phase`] === 'idle' && !state[`${kind}Dirty`] && !state[`${kind}Hydrating`]
    if (ready && captureReadiness && window.saveWork) window.saveWork.readyMs ??= performance.now() - window.saveWork.started
    // Observe the existing predicate without another polling timer or a changed deadline
    // A post-timeout idle snapshot cannot establish when the UI became ready
    window.recordSaveIdleObservation({ current: state.current, pending: state.pending, phase: state[`${kind}Phase`], dirty: state[`${kind}Dirty`], hydrating: state[`${kind}Hydrating`], acknowledged, editable, ready, visibility: document.visibilityState })
    return ready
  }, { kind, savedLabel, captureReadiness }, { timeout: SAVE_CEILING_MS })
}

async function openOperation(page: Page, operation: Operation, observePreparation: (phase: string) => Promise<void>) {
  if (operation === 'Build notes') {
    await page.evaluate(() => { location.hash = '#/builds/library' })
    await page.getByRole('button', { name: 'Rowan: sample Warrior', exact: true }).click()
    await page.getByRole('button', { name: 'Checks & Notes', exact: true }).click()
  } else if (operation === 'progress tile') {
    await page.evaluate(() => { location.hash = '#/progress/summons' })
    await page.getByRole('heading', { name: 'Progress', exact: true }).waitFor()
  } else if (operation === 'Save inventory') {
    await page.evaluate(() => { location.hash = '#/save-editor' })
    await page.locator('select').filter({ has: page.locator(`option[value="${PERFORMANCE_SAVE_ID}"]`) }).selectOption(PERFORMANCE_SAVE_ID)
    await page.getByRole('heading', { name: 'synthetic-performance.sav', exact: true }).waitFor()
    // Opening authenticates the selected file before the category change begins its bounded local save
    await page.waitForFunction(() => {
      const state = (window as any).localSaveProof.diagnostics()
      return state.current && state.savePhase === 'idle' && !state.saveHydrating && !state.pending
    })
    await page.getByRole('combobox', { name: 'Inventory category', exact: true }).selectOption('item')
    // Each filter persists separately; check each preparation save against the same one-second ceiling
    await idle(page, 'save')
    await page.getByRole('combobox', { name: 'Stock filter', exact: true }).selectOption('carried')
    // Both filters are durable presentation; finish opening before capturing the timed operation's baseline
    await idle(page, 'save')
  } else {
    await page.evaluate(() => { location.hash = '#/mods/editor' })
    await page.getByRole('combobox', { name: 'Files opened in this tool', exact: true }).selectOption(PERFORMANCE_EDITOR_ID)
    await observePreparation('editor-file-selected')
    // This changes only editor presentation; explicit field and durable-idle checks below own readiness
    // The pinned browser can strand the implicit navigation waiter after the click has already completed
    await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click({ noWaitAfter: true })
    await observePreparation('editor-document-click-completed')
    await page.getByLabel('Exact JSON value').waitFor()
    // Selecting the editable path persists inert editor presentation before the timed content edit
    await idle(page, 'editor')
  }
}

for (const mode of ['guest', 'account', 'account-mapping'] as const) for (const size of ['small', 'large'] as const) for (const operation of operations) test.describe(`${mode} ${size}: ${operation}`, () => {
  let retainedContext: BrowserContext | undefined
  let page: Page, context: BrowserContext, browserVersion: string, startedAt: number
  let receiptIndex = 0
  let baseline: any, startingEditor: any, previousFile: any
  let previousRecords: BodyRecord[]
  let setupSnapshot: Readonly<Record<string, unknown>> | undefined
  const preparation: { phase: string; elapsedMs: number; diagnostics?: unknown }[] = []
  const errors: string[] = [], measures: unknown[] = []
  const draftPreparations: unknown[] = []
  const postProbeDrains: unknown[] = []
  let unverifiedMeasure: { index: number; work: ReturnType<Window['finishSaveWork']> } | undefined

  async function releaseJourney() {
    try { await retainedContext?.close() }
    finally {
      // Collected suite callbacks outlive their browser context in the test worker
      // Release complete originals and per-save observations after their assertions and attachments
      retainedContext = undefined
      baseline = startingEditor = previousFile = undefined
      previousRecords = []
      unverifiedMeasure = undefined
      setupSnapshot = undefined; preparation.length = 0
      measures.length = 0; errors.length = 0; draftPreparations.length = 0; postProbeDrains.length = 0
    }
  }
  async function finishJourney(info: TestInfo) {
    try {
      if (info.status !== 'passed') {
        // A timed-out body can remain suspended until teardown closes its page
        // Capture the collected evidence before cleanup, without asking that page to respond
        const receipt = JSON.stringify({ operation, mode, size, browser: browserVersion, status: info.status, elapsedMs: startedAt === undefined ? undefined : Date.now() - startedAt, setup: setupSnapshot, preparation, measures, unverifiedMeasure, draftPreparations, postProbeDrains, errors }, (_key, value) => typeof value === 'bigint' ? { bigint: value.toString() } : value, 2)
        const path = info.outputPath('save-work-failure-state.json')
        await writeFile(path, receipt)
        await info.attach('save-work-failure-state', { contentType: 'application/json', path })
      }
    } finally { await releaseJourney() }
  }
  // Independent cases release their own observations without creating file-level shard groups
  // Mapping journeys retain afterAll cleanup because beforeAll owns their browser context
  if (mode === 'account-mapping') test.afterAll(async ({}, info) => finishJourney(info))
  else test.afterEach(async ({}, info) => finishJourney(info))

  async function prepare(ownedPage: Page, ownedContext: BrowserContext, version: string) {
    page = ownedPage; context = ownedContext; browserVersion = version; startedAt = Date.now()
    await installSaveWorkCounters(page)
    page.on('pageerror', error => errors.push(String(error)))
    page.on('crash', () => errors.push('The browser page crashed'))
    preparation.push({ phase: 'fixture-navigation', elapsedMs: Date.now() - startedAt })
    const path = process.env.CRYKIT_SAVE_FIXTURE ?? '/__accounts-proof/local-save-performance.html'
    await page.goto(`${path}?mode=${mode === 'guest' ? 'guest' : 'account'}&size=${size}${operation === 'Save inventory' ? '&saveApplyOracle=1' : ''}`)
    await page.waitForFunction(() => (window as any).localSaveProof?.ready() || (window as any).localSaveFailure)
    expect(await page.evaluate(() => (window as any).localSaveFailure)).toBeUndefined()
    setupSnapshot = await page.evaluate(() => (window as any).localSaveProof.setup)
    if (process.env.CRYKIT_SAVE_ALLOW_DEV !== '1') expect(setupSnapshot?.build).toBe('compiled')
    await page.evaluate(() => {
      const sodium = (window as any).localSaveProof.sodium
      const push = sodium.crypto_secretstream_xchacha20poly1305_push, pull = sodium.crypto_secretstream_xchacha20poly1305_pull
      sodium.crypto_secretstream_xchacha20poly1305_push = function (...args: any[]) { if (window.saveWork) window.saveWork.encrypted += args[1].byteLength; return push.apply(this, args) }
      sodium.crypto_secretstream_xchacha20poly1305_pull = function (...args: any[]) { if (window.saveWork) window.saveWork.decrypted += args[1].byteLength; return pull.apply(this, args) }
    })
    if (mode === 'account-mapping') {
      await page.evaluate(() => (window as any).localSaveProof.queueMapping())
      // The synthetic external command changes the repository revision, not App's captured planner
      // Use the normal guarded reopen before editing, retaining the queued encrypted projection
      await page.getByRole('button', { name: 'Load updated data', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Load updated data', exact: true })).toBeHidden()
    }
    // Retain setup evidence in the test process so an unresponsive page cannot erase its last known state
    // These reads occur before any timed save; they do not poll or add work inside the qualification window
    const observePreparation = async (phase: string) => {
      const observation: (typeof preparation)[number] = { phase, elapsedMs: Date.now() - startedAt }
      preparation.push(observation)
      observation.diagnostics = await diagnostics(page)
    }
    await observePreparation('workspace-ready')
    await openOperation(page, operation, observePreparation)
    await observePreparation('operation-opened')
    // Preparation includes loading route chunks; offline measurement begins only after that bulk work
    if (mode !== 'guest') await context.setOffline(true)
    baseline = await page.evaluate(() => (window as any).localSaveProof.full())
    startingEditor = operation.includes('Editor') ? await inspect(page, 'editor') : undefined
    previousRecords = baseline.records
    previousFile = operation === 'Save inventory' ? baseline.saveDocuments.find((file: any) => file.id === PERFORMANCE_SAVE_ID) : startingEditor?.file
  }

  async function saveOne(index: number) {
    // Restoring the next-input probe is a distinct quiet pending-form command
    // Capture its durable revision before the timed content Apply
    const beforeInventory = operation === 'Save inventory' ? await (async () => {
      await idle(page, 'save')
      const saved = await inspect(page, 'save')
      expect(saved.file.original).toEqual(previousFile.original)
      expect(saved.file.working).toEqual(previousFile.working)
      expect(saved.file.pendingForm.fields).toEqual({})
      return saved.file
    })() : undefined
    let expected: unknown
    let saveApplyAttempt: number | undefined
    let editorProbe: { value: string; canApply: boolean; work: ReturnType<Window['finishSaveWork']> } | undefined
    let nextInputWork: ReturnType<Window['finishSaveWork']> | undefined
    if (operation === 'Build notes') {
      const notes = page.getByPlaceholder('Optional play notes', { exact: true }), value = `Synthetic performance note ${index}`
      await notes.fill(value)
      await arm(page, 'click', 'button[type=submit]', mode === 'account-mapping', { selector: 'textarea[placeholder="Optional play notes"]', value: `${value} `, budgetMs: SAVE_CEILING_MS })
      await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
      // Observe saved revision, editable visibility and exact text together so driver round trips do not serialize these checks
      await page.waitForFunction(({ revision, value }) => {
        const field = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Optional play notes"]'), bounds = field?.getBoundingClientRect()
        const ready = document.querySelector('select[title="View or edit the latest checkpoint."] option:checked')?.textContent?.startsWith(`r${revision}`)
          && document.querySelector('.context-status--saved')?.textContent?.includes('Saved locally')
          && !!field && !field.disabled && !field.readOnly && !!bounds?.width && !!bounds?.height && getComputedStyle(field).visibility === 'visible' && field.value === value
        // Match filling's end cursor without making caret retention another save requirement
        if (ready && field) {
          if (window.saveWork) window.saveWork.readyMs ??= performance.now() - window.saveWork.started
          field.focus({ preventScroll: true })
          field.setSelectionRange(field.value.length, field.value.length)
        }
        return ready
      }, { revision: index + 2, value }, { timeout: SAVE_CEILING_MS })
      await page.keyboard.press(NEXT_INPUT_KEY)
      nextInputWork = await page.evaluate(() => window.finishNextInputWork())
      expected = value
    } else if (operation === 'Save inventory') {
      const row = page.locator('.save-editor__inventory-row').filter({ hasText: 'Item #0 ·' }), input = row.getByRole('textbox'), value = String(3 + index % 2)
      const name = await input.getAttribute('aria-label')
      if (!name) throw new Error('The inventory input has no accessible name')
      const selector = `.save-editor__inventory-row input[aria-label=${JSON.stringify(name)}]`, nextValue = String(3 + (index + 1) % 2)
      await input.fill(value)
      saveApplyAttempt = await arm(page, 'click', '.save-editor__inventory-row button', mode === 'account-mapping', { selector, value: nextValue, budgetMs: SAVE_CEILING_MS, enabledSelector: `.save-editor__inventory-row:has(input[aria-label=${JSON.stringify(name)}]) button` }, true)
      await row.getByRole('button').click()
      // Read the same durable and visible conditions together; driver queries are not separate user actions
      // The clock still includes the next trusted input, enabled Apply action and paint
      await page.waitForFunction(({ selector, value, attempt }) => {
        const proof = (window as SaveApplyProofWindow).localSaveProof
        const state = proof.diagnostics(), field = document.querySelector<HTMLInputElement>(selector)
        const action = field?.closest('form')?.querySelector<HTMLButtonElement>('button'), label = document.querySelector<HTMLElement>('.save-editor__state')
        const bounds = label?.getBoundingClientRect(), fieldBounds = field?.getBoundingClientRect()
        const ready = state.current && !state.pending && state.savePhase === 'idle' && !state.saveDirty && !state.saveHydrating
          && !!action?.disabled && !!label?.textContent?.startsWith('Saved locally') && !!bounds?.width && !!bounds?.height && getComputedStyle(label).visibility === 'visible'
          && !!field && !field.disabled && !field.readOnly && !!fieldBounds?.width && !!fieldBounds?.height && getComputedStyle(field).visibility === 'visible' && field.value === value
        if (ready && window.saveWork) window.saveWork.readyMs ??= performance.now() - window.saveWork.started
        // Queue the persisted Apply fence in this readiness turn, then leave the next trusted input as the next driver action
        if (ready) proof.captureSaveApply(attempt)
        return ready
      }, { selector, value, attempt: saveApplyAttempt! }, { timeout: SAVE_CEILING_MS })
      await input.fill(nextValue)
      nextInputWork = await page.evaluate(() => window.finishNextInputWork())
      expected = Number(value)
    } else if (operation === 'progress tile') {
      const tile = page.locator('.summon-tile').filter({ has: page.getByRole('button', { name: /^Shaku, Deity of/ }) })
      const before = await tile.getAttribute('data-unlocked')
      await arm(page, 'click', '.summon-tile button', mode === 'account-mapping')
      await tile.getByRole('button').click()
      await expect(tile.getByRole('button')).not.toHaveAttribute('aria-busy', 'true', { timeout: SAVE_CEILING_MS })
      await expect(tile).toHaveAttribute('data-unlocked', before === 'true' ? 'false' : 'true', { timeout: SAVE_CEILING_MS })
      await tile.getByRole('button').focus()
      expect(await tile.getByRole('button').isEnabled()).toBe(true)
      expected = before !== 'true'
    } else {
      const field = page.getByLabel('Exact JSON value'), value = operation === 'invalid Editor draft' ? `${startingEditor.applied.slice(0, -1)},"Invalid${index}":` : JSON.stringify({ ...JSON.parse(startingEditor.applied), Title: `Synthetic performance ${index}` })
      if (operation === 'invalid Editor draft') {
        await arm(page, 'input', '.inspector-editor textarea', mode === 'account-mapping')
        await field.fill(value)
        // Observe durability and its visible acknowledgement in one browser turn
        // A separate automation query delays the next real input without testing more application work
        await idle(page, 'editor', 'Saved JSON edit; not applied', true)
      } else {
        // The quiet draft is a distinct command; Apply starts at its actual durable boundary
        // Retain its work on failure too, before the Apply measurement replaces the counters
        await arm(page, 'input', '.inspector-editor textarea')
        try {
          await field.fill(value)
          await idle(page, 'editor', 'Saved JSON edit; not applied')
        } finally {
          draftPreparations.push({ index, work: await page.evaluate(() => window.saveWork ? window.finishSaveWork() : undefined).catch(() => undefined) })
        }
        await arm(page, 'click', '.inspector-actions button', mode === 'account-mapping')
        await page.getByRole('button', { name: 'Apply JSON edit', exact: true }).click()
        await idle(page, 'editor', mode === 'guest' ? 'Saved in this browser' : 'Saved on this device', true)
      }
      if (operation === 'valid Editor Apply') {
        const displayed = await field.evaluate(element => {
          if (!(element instanceof HTMLTextAreaElement)) throw new Error('The editor field is unavailable')
          // Match filling's end cursor without retransmitting the complete document
          element.setSelectionRange(element.value.length, element.value.length)
          return element.value
        })
        expect(displayed).toBe(value)
      }
      await page.evaluate(({ value, budgetMs }) => window.armEditorNextInputWork({ selector: '.inspector-editor textarea', value: `${value} `, key: ' ', enabledSelector: '.inspector-editor .inspector-actions button:first-child', budgetMs }), { value, budgetMs: SAVE_CEILING_MS })
      if (operation === 'invalid Editor draft') {
        // Preserve the field's retained focus; locator.press would hide a continuation regression
        // One real character avoids retransmitting the complete document before checking its exact next text
        await page.keyboard.press(NEXT_INPUT_KEY)
      } else {
        // Focus follows the same explicit field interaction as filling, while one trusted key avoids resending the document
        await field.press(NEXT_INPUT_KEY)
      }
      editorProbe = await page.evaluate(async () => {
        const work = await window.finishEditorInputWork()
        const element = document.activeElement
        if (!(element instanceof HTMLTextAreaElement) || !element.matches('.inspector-editor textarea')) throw new Error('The editor lost focus during autosave')
        const value = element.value
        const apply = [...document.querySelectorAll<HTMLButtonElement>('.inspector-actions button')].find(button => button.textContent?.trim() === 'Apply JSON edit')
        return { value, canApply: !!apply?.matches(':enabled'), work }
      })
      expected = value
    }
    const work = editorProbe?.work ?? nextInputWork ?? await page.evaluate(() => window.finishSaveWork())
    // A later drain or durable read failure must retain the completed timing without claiming its integrity checks passed
    unverifiedMeasure = { index, work }
    // The trusted probe and undo are ordinary autosaved input after the timed readiness boundary
    // Drain only their local command before the durable oracle; real background mapping stays live
    if (operation.includes('Editor')) {
      // A failed drain needs its own work receipt; the completed Apply/input counters cannot explain it
      await arm(page, 'input', '.inspector-editor textarea')
      try {
        await page.keyboard.press('Backspace')
        await idle(page, 'editor')
      } finally {
        postProbeDrains.push({ index, work: await page.evaluate(() => window.saveWork ? window.finishSaveWork() : undefined).catch(() => undefined) })
      }
      expect(await page.getByLabel('Exact JSON value').inputValue()).toBe(expected)
    }
    const persisted = operation === 'Save inventory'
      ? await page.evaluate(attempt => (window as SaveApplyProofWindow).localSaveProof.inspectSaveApply(attempt), saveApplyAttempt!)
      : await inspect(page, operation.includes('Editor') ? 'editor' : 'planner')
    measures.push({ index, work, expected, persisted, ...(beforeInventory ? { beforeInventory } : {}), ...(editorProbe ? { nextInput: { exactText: editorProbe.value === `${expected} `, applyEnabled: editorProbe.canApply } } : nextInputWork ? { nextInput: { exactText: nextInputWork.nextInputReady === true, focused: nextInputWork.nextInputReady === true } } : {}) })
    unverifiedMeasure = undefined
    // Editor receipts retain the entire interval; only the measured driver gap is excluded from the application budget
    expect(editorProbe ? work.applicationElapsedMs : work.elapsedMs).toBeLessThanOrEqual(SAVE_CEILING_MS)
    if (nextInputWork) expect(nextInputWork.nextInputReady).toBe(true)
    if (editorProbe) {
      expect(work.nextInputReady).toBe(true)
      expect(editorProbe.value).toBe(`${expected} `)
      expect(editorProbe.canApply).toBe(true)
    }
    if (mode === 'account-mapping') {
      expect(await page.evaluate(() => (window as any).localSaveProof.mapping().error)).toBeUndefined()
      const messages = await page.evaluate(started => window.mapperEvents.filter(event => event.at >= started && event.kind === 'foreground'), work.started)
      expect(messages.some(event => event.pending === true)).toBe(true)
      expect(messages.some(event => event.pending === false)).toBe(true)
    }
    const consumed = consumedKeys(previousFile, operation)
    const observedReads = new Set(Object.values(work.recordsRead).flat())
    const observedWrites = new Set(Object.values(work.recordsWritten).flat())
    const persistedRecords = new Map(persisted.records.map((record: BodyRecord) => [record.key, record]))
    // Keep the keyed comparison for every immutable body and catalog
    // Group the checks to avoid tracing each unchanged record separately
    expect(previousRecords.map(record => persistedRecords.get(record.key))).toEqual(previousRecords)
    expect(previousRecords.filter(record => observedWrites.has(record.storageId))).toEqual([])
    // Only the edited file's actual current dependencies may be read by the foreground operation
    expect(previousRecords.filter(record => !consumed.has(record.key) && observedReads.has(record.storageId))).toEqual([])
    previousRecords = persisted.records
    previousFile = persisted.file
    if (operation === 'Build notes') {
      expect(persisted.values.some((value: any) => value.kind === 'build-checkpoint' && value.value.content.rotationNotes === expected && value.value.revision === index + 2)).toBe(true)
      await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
    } else if (operation === 'Save inventory') {
      expect(persisted.native.party.value.Items.value.Stock.value[0].value.Count.value).toBe(expected)
      expect(persisted.file.revision).toBe(beforeInventory.revision + 1)
      await page.locator('.save-editor__inventory-row').filter({ hasText: 'Item #0 ·' }).getByRole('textbox').fill(String(expected))
    } else if (operation.includes('Editor')) {
      expect(operation === 'valid Editor Apply' ? persisted.applied : persisted.file.unfinished.fieldState.editor).toBe(expected)
      if (operation === 'invalid Editor draft') expect(persisted.applied).toBe(startingEditor.applied)
    } else expect(persisted.values.some((value: any) => value.kind === 'progress' && value.value.displayName.startsWith('Shaku') && value.value.unlocked.state === 'known' && value.value.unlocked.value === expected)).toBe(true)
    return work
  }

  async function assertComplete() {
    if (operation.includes('Editor')) await idle(page, 'editor')
    if (operation === 'Save inventory') await idle(page, 'save')
    if (mode === 'account-mapping') {
      // Finish only the last requested map; the complete cloud drain has its own journey
      await page.waitForFunction(() => !(window as any).localSaveProof.mapping().pending)
      expect(await page.evaluate(() => (window as any).localSaveProof.mapping().error)).toBeUndefined()
    }
    const final = await page.evaluate(() => (window as any).localSaveProof.full())
    for (const original of baseline.blobs) expect(final.blobs).toContainEqual(original)
    expect(final.planner.history.slice(0, baseline.planner.history.length)).toEqual(baseline.planner.history)
    expect(errors).toEqual([])
  }

  async function attach(info: TestInfo, samples: readonly unknown[] = measures) {
    // JSON reporters inline body attachments, so the combined exact evidence can exceed V8's string limit
    // Keep every sample and integrity observation in a linked per-test file instead
    // Timeout teardown can clear the suite arrays while a final page query is still pending
    const preparationSnapshot = preparation.map(observation => ({ ...observation }))
    const receipt = JSON.stringify({ operation, mode, size, browser: browserVersion, hardware: { cpu: cpus()[0]?.model, memoryBytes: totalmem(), platform: platform(), release: release() }, setup: setupSnapshot, preparation: preparationSnapshot, measures: samples, unverifiedMeasure, draftPreparations: draftPreparations.splice(0), postProbeDrains: postProbeDrains.splice(0), diagnostics: await diagnostics(page).catch(() => undefined), mapperEvents: await page.evaluate(() => window.mapperEvents).catch(() => undefined), errors, qualification: 'Prepared synthetic managed root; installed account key is local-only. Main-thread payload/work observations exclude untimed durable oracles, worker activity and physical disk allocation. Long tasks are observed callbacks, not a complete trace. Mapping mode uses the actual profile-owned worker with encrypted queued projection; it does not establish cloud publication or complete portable restore.' }, (_key, value) => typeof value === 'bigint' ? { bigint: value.toString() } : value, 2)
    const path = info.outputPath(`save-work-receipt-${receiptIndex++}.json`)
    await writeFile(path, receipt)
    await info.attach('save-work-receipt', { contentType: 'application/json', path })
  }

  if (mode === 'account-mapping') {
    // Each command retains its one-second ceiling inside the complete journey budget
    // One real map may span multiple saves; each accepted sample still requires observed overlap
    // One live context preserves the entire sequence and original final history oracle
    test.describe.configure({ mode: 'serial' })
    test.beforeAll(async ({ browser, accountOrigin: baseURL, ignoreHTTPSErrors, viewport, isMobile, hasTouch, userAgent, colorScheme }) => {
      retainedContext = await browser.newContext({ baseURL, ignoreHTTPSErrors, viewport, isMobile, hasTouch, userAgent, colorScheme })
      page = await retainedContext.newPage()
    })
    test('first and repeated saves stay durable and usable within one second and retain exact history', async ({ browser }, info) => {
      await test.step('prepare the complete workspace', async () => {
        try { await prepare(page, retainedContext!, browser.version()) }
        finally { await attach(info, []) }
      })
      for (let index = 0; index <= REPEATED_SAVES; index++) await test.step(`save ${index}: durable and usable within one second`, async () => {
        const before = measures.length
        try {
          // A real mapper can finish between preparation and the trusted UI event
          // Keep every save's timing and integrity checks; only repeated slots may add one genuine overlap sample
          const attempts = index === 0 ? 1 : MAX_MAPPING_SAMPLE_ATTEMPTS
          let work: Awaited<ReturnType<typeof saveOne>> | undefined
          for (let attempt = 0; attempt < attempts; attempt++) {
            work = await saveOne(measures.length)
            if (work.activeMappings.length) break
          }
          expect(work!.activeMappings.length).toBeGreaterThan(0)
        }
        finally { await attach(info, measures.slice(before)) }
      })
      await test.step('retain complete history and originals after the same active save sequence', async () => {
        try {
          await assertComplete()
          await info.attach('complete-sequence-receipt', { contentType: 'application/json', body: JSON.stringify({ elapsedMs: Date.now() - startedAt, qualification: 'One unchanged live context across setup, every timed save and the complete final oracle; an active real map can span multiple saves. Every attempt retains foreground and integrity checks; first and accepted repeated samples require overlap. Final mapping completion remains separately bounded, and total journey time is reported.' }) })
        } finally { await attach(info, []) }
      })
    })
  } else test('is durable and usable within one second', async ({ page, context, browser }, info) => {
    try {
      await prepare(page, context, browser.version())
      for (let index = 0; index <= REPEATED_SAVES; index++) await saveOne(index)
      await assertComplete()
    } finally { await attach(info) }
  })
})

interface EditorForegroundObservation {
  editorPhase: string
  editorDirty: boolean
  editorHydrating: boolean
  pending: boolean
  foreground?: boolean
}

declare global {
  interface Window {
    editorForegroundProof: { transitions: EditorForegroundObservation[]; inputs: EditorForegroundObservation[] }
  }
}

async function runEditorForegroundMapping(page: Page) {
  const request = await page.evaluate(async () => {
    const proof = (window as any).localSaveProof
    const start = window.mapperEvents.length
    await proof.startMapping()
    return start
  })
  await expect.poll(() => page.evaluate(start => {
    const mapping = (window as any).localSaveProof.mapping()
    const events = window.mapperEvents.slice(start)
    const map = events.find(event => event.direction === 'sent' && event.kind === 'map')
    const complete = map?.id && events.some(event => event.direction === 'received' && event.id === map.id && event.status === 'complete')
    return { pending: mapping.pending, error: mapping.error, complete: !!complete }
  }, request)).toEqual({ pending: false, error: undefined, complete: true })
}

async function prepareEditorForeground(page: Page) {
  await installSaveWorkCounters(page)
  const path = process.env.CRYKIT_SAVE_FIXTURE ?? '/__accounts-proof/local-save-performance.html'
  await page.goto(`${path}?mode=account&size=small`)
  await page.waitForFunction(() => (window as any).localSaveProof?.ready() || (window as any).localSaveFailure)
  expect(await page.evaluate(() => (window as any).localSaveFailure)).toBeUndefined()
  await page.evaluate(async () => {
    const proof = (window as any).localSaveProof
    if (proof.setup.build !== 'compiled') throw new Error('The queued Editor regression requires a compiled account fixture')
    await proof.queueMapping()
  })
  const reload = page.getByRole('button', { name: 'Load updated data', exact: true })
  await reload.click()
  await expect(reload).toBeHidden()
  await openOperation(page, 'invalid Editor draft', async () => {})
  return page.getByLabel('Exact JSON value')
}

async function observeEditorForeground(page: Page) {
  await page.evaluate(() => {
    const proof = (window as any).localSaveProof
    const capture = (foreground?: boolean): EditorForegroundObservation => {
      const { editorPhase, editorDirty, editorHydrating, pending } = proof.diagnostics()
      return { foreground, editorPhase, editorDirty, editorHydrating, pending }
    }
    const observations: Window['editorForegroundProof'] = { transitions: [], inputs: [] }
    window.editorForegroundProof = observations
    let mapper: Worker | undefined
    const postMessage = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (this: Worker, ...args: [message: unknown, transfer?: Transferable[] | StructuredSerializeOptions]) {
      const message = args[0] as { kind?: string; pending?: boolean } | undefined
      if (message?.kind === 'map') mapper ??= this
      if (this === mapper && message?.kind === 'foreground') observations.transitions.push(capture(message.pending))
      Reflect.apply(postMessage, this, args)
    }
    // Window sees the textarea event after React handles it, in the same task as the edit
    // The quiet timer cannot explain a foreground transition captured here
    window.addEventListener('input', event => {
      if (event.target instanceof HTMLTextAreaElement && event.target.matches('.inspector-editor textarea')) {
        observations.inputs.push(capture(observations.transitions.at(-1)?.foreground))
      }
    })
  })
  await runEditorForegroundMapping(page)
}

async function focusSettledEditorField(page: Page) {
  const field = await prepareEditorForeground(page)
  await observeEditorForeground(page)
  await field.blur()
  await field.focus()
  await expect(field).toBeFocused()
  expect(await page.evaluate(() => window.editorForegroundProof.transitions)).toEqual([])
  return field
}

test('queued Editor input reserves foreground through readiness', async ({ page }) => {
  const field = await focusSettledEditorField(page)
  const draft = '{"queued":'
  await field.fill(draft)
  const input = await page.evaluate(() => window.editorForegroundProof.inputs.at(-1))
  expect(input).toMatchObject({ editorDirty: true, editorPhase: 'idle', pending: false, editorHydrating: false })
  expect(input?.foreground, 'foreground priority sent to the real mapper during queued input').toBe(true)

  await idle(page, 'editor', 'Saved JSON edit; not applied', true)
  const transitions = await page.evaluate(() => window.editorForegroundProof.transitions)
  expect(transitions).toMatchObject([
    { foreground: true, editorDirty: true, editorPhase: 'idle', pending: false, editorHydrating: false },
    { foreground: false, editorDirty: false, editorPhase: 'idle', pending: false, editorHydrating: false },
  ])
  await expect(field).toHaveValue(draft)
  const persisted = await inspect(page, 'editor')
  expect(persisted.unfinished).toBe(draft)
  expect(persisted.file.unfinished.fieldState.editor).toBe(draft)
  await runEditorForegroundMapping(page)
})

test('queued Editor input releases foreground after a stopped autosave', async ({ page }) => {
  const field = await focusSettledEditorField(page)
  const baseline = await inspect(page, 'editor')
  await page.evaluate(() => (window as any).localSaveProof.armEditorSaveReadFailure())
  const draft = '{"failed":'
  await field.fill(draft)
  await expect(page.getByText('Synthetic Editor staging read failed', { exact: true })).toBeVisible()
  await expect(field).toHaveValue(draft)
  const transitions = await page.evaluate(() => window.editorForegroundProof.transitions)
  expect(transitions).toMatchObject([
    { foreground: true, editorDirty: true, editorPhase: 'idle', pending: false, editorHydrating: false },
    { foreground: false, editorDirty: true, editorPhase: 'idle', pending: false, editorHydrating: false },
  ])

  const later = '{"retained":'
  await field.fill(later)
  await expect(field).toHaveValue(later)
  expect(await page.evaluate(() => window.editorForegroundProof.inputs.at(-1))).toMatchObject({ foreground: false, editorDirty: true, editorPhase: 'idle', pending: false })
  await runEditorForegroundMapping(page)
  expect(await page.evaluate(() => window.editorForegroundProof.transitions)).toEqual(transitions)
  const persisted = await inspect(page, 'editor')
  expect(persisted.file.revision).toBe(baseline.file.revision)
  expect(persisted.unfinished).toBe(baseline.unfinished)
})

test('queued Editor map layer change holds foreground across both field updates', async ({ page }) => {
  await prepareEditorForeground(page)
  await page.getByRole('tab', { name: 'Map Editor', exact: true }).click({ noWaitAfter: true })
  await page.getByRole('button', { name: 'New map mod', exact: true }).click({ noWaitAfter: true })
  await idle(page, 'editor')
  const fileId = await page.getByRole('combobox', { name: 'Files opened in this tool', exact: true }).inputValue()
  expect(fileId).not.toBe(PERFORMANCE_EDITOR_ID)
  const inspectMap = () => page.evaluate(id => (window as any).localSaveProof.inspect('editor', id), fileId)
  const layer = page.getByRole('combobox', { name: 'Editor map layer', exact: true })
  const plane = page.getByRole('button', { name: 'Construction plane', exact: true })
  await expect(plane).toHaveAttribute('aria-pressed', 'false')
  await expect(plane).toBeEnabled()
  const initialLayer = await layer.inputValue()
  const nextLayer = await layer.locator('option').evaluateAll(options => options.find(option => !(option as HTMLOptionElement).selected)?.getAttribute('value'))
  if (nextLayer == null) throw new Error('The map fixture needs two layers')
  await layer.selectOption(nextLayer)
  await idle(page, 'editor')
  await layer.selectOption(initialLayer)
  await idle(page, 'editor')
  await plane.click({ noWaitAfter: true })
  await idle(page, 'editor')
  await plane.click({ noWaitAfter: true })
  await idle(page, 'editor')
  const baseline = await inspectMap()
  expect(baseline.file.unfinished.fieldState.map).toMatchObject({ constructionPlane: false, layerId: Number(initialLayer) })
  await observeEditorForeground(page)

  const observation = await page.evaluate(async ({ initialLayer, nextLayer }) => {
    const layer = document.querySelector<HTMLSelectElement>('[data-editor-focus="map-layer"]')!
    const plane = document.querySelector<HTMLButtonElement>('.map-editor button[aria-label="Construction plane"]')!
    const proof = (window as any).localSaveProof
    const changedLayer = (value: string) => {
      layer.value = value
      layer.dispatchEvent(new Event('change', { bubbles: true }))
    }
    // Deliver the real handlers before the quiet callback can fire, and let registered waiters settle
    plane.click()
    const queued = proof.diagnostics()
    let resumed = false
    const waiting = proof.waitForForeground().then(() => { resumed = true })
    changedLayer(nextLayer)
    await Promise.resolve()
    await Promise.resolve()
    const switched = { resumed, ...proof.diagnostics(), plane: plane.getAttribute('aria-pressed'), layer: layer.value, edges: window.editorForegroundProof.transitions.map(state => state.foreground) }
    changedLayer(initialLayer)
    // The candidate drop runs in a microtask. Report an unsettled waiter without hanging on a stranded lease
    await Promise.race([waiting, Promise.resolve().then(() => {}).then(() => {}).then(() => {})])
    return { queued, switched, cancelled: { resumed, ...proof.diagnostics(), edges: window.editorForegroundProof.transitions.map(state => state.foreground) } }
  }, { initialLayer, nextLayer })

  expect(observation.queued).toMatchObject({ editorDirty: true, editorPhase: 'idle', pending: false })
  expect(observation.switched).toMatchObject({ editorDirty: true, editorPhase: 'idle', pending: false, plane: 'false', layer: nextLayer })
  expect(observation.switched.edges, 'the compound map event keeps the original foreground reservation').toEqual([true])
  expect(observation.switched.resumed).toBe(false)
  expect(observation.cancelled).toMatchObject({ resumed: true, editorDirty: false, editorPhase: 'idle', pending: false, edges: [true, false] })
  await runEditorForegroundMapping(page)
  expect((await inspectMap()).file.revision).toBe(baseline.file.revision)
})

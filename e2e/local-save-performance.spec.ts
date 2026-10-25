import { expect, test, type Page, type BrowserContext, type TestInfo } from './accounts/test-fixture'
import { cpus, platform, release, totalmem } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { installSaveWorkCounters } from './local-save-work-counters'
import { PERFORMANCE_EDITOR_ID, PERFORMANCE_SAVE_ID } from '../worker/testing/local-save-workload'

const SAVE_CEILING_MS = 1000
const REPEATED_SAVES = 30
const MAX_MAPPING_SAMPLE_ATTEMPTS = 2
const NEXT_INPUT_KEY = 'Space'
const operations = ['Build notes', 'progress tile', 'invalid Editor draft', 'valid Editor Apply', 'Save inventory'] as const
type Operation = typeof operations[number]
interface BodyRecord { key: string; kind: string; ref: { documentId: string; revisionId: string }; digest: string; storageId: string }
const bodyKey = (ref: { documentId: string; revisionId: string }) => JSON.stringify(['blob', JSON.stringify([ref.documentId, ref.revisionId])])
function consumedKeys(file: any, operation: Operation): Set<string> {
  if (operation === 'Save inventory') return new Set([file.original, file.working].map(bodyKey))
  if (operation.includes('Editor')) return new Set([file.original, file.lastApplied, file.unfinished.text].map(bodyKey))
  return new Set()
}

async function arm(page: Page, event: 'click' | 'input', selector: string, withMapping = false) {
  if (withMapping) await ensureMapping(page)
  await page.evaluate(({ event, selector }) => window.armSaveWork(event, selector), { event, selector })
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
async function idle(page: Page, kind: 'save' | 'editor', savedLabel?: string) {
  await page.waitForFunction(({ kind, savedLabel }) => {
    const state = (window as any).localSaveProof.diagnostics()
    const label = savedLabel === undefined ? undefined : document.querySelector<HTMLElement>('.inspector-save-state')
    const bounds = label?.getBoundingClientRect()
    const acknowledged = savedLabel === undefined || !!label && label.textContent === savedLabel && !!bounds?.width && !!bounds?.height && getComputedStyle(label).visibility === 'visible'
    return acknowledged && state.current && !state.pending && state[`${kind}Phase`] === 'idle' && !state[`${kind}Dirty`] && !state[`${kind}Hydrating`]
  }, { kind, savedLabel }, { timeout: SAVE_CEILING_MS })
}

async function openOperation(page: Page, operation: Operation) {
  if (operation === 'Build notes') {
    await page.evaluate(() => { location.hash = '#/builds/library' })
    await page.getByRole('button', { name: 'Rowan: sample Warrior', exact: true }).click()
    await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  } else if (operation === 'progress tile') {
    await page.evaluate(() => { location.hash = '#/progress/summons' })
    await page.getByRole('heading', { name: 'Progress', exact: true }).waitFor()
  } else if (operation === 'Save inventory') {
    await page.evaluate(() => { location.hash = '#/save-editor' })
    await page.locator('select').filter({ has: page.locator(`option[value="${PERFORMANCE_SAVE_ID}"]`) }).selectOption(PERFORMANCE_SAVE_ID)
    await page.getByRole('heading', { name: 'synthetic-performance.sav', exact: true }).waitFor()
    await page.getByRole('combobox', { name: 'Inventory category', exact: true }).selectOption('item')
    await page.getByRole('combobox', { name: 'Stock filter', exact: true }).selectOption('carried')
    // The category is durable presentation; finish opening before capturing the timed operation's baseline
    await idle(page, 'save')
  } else {
    await page.evaluate(() => { location.hash = '#/mods/editor' })
    await page.getByRole('combobox', { name: 'Files opened in this tool', exact: true }).selectOption(PERFORMANCE_EDITOR_ID)
    await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
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
  const errors: string[] = [], measures: unknown[] = []

  test.afterAll(async () => {
    try { await retainedContext?.close() }
    finally {
      // Collected suite callbacks outlive their browser context in the test worker
      // Release complete originals and per-save observations after their assertions and attachments
      retainedContext = undefined
      baseline = startingEditor = previousFile = undefined
      previousRecords = []
      measures.length = 0; errors.length = 0
    }
  })

  async function prepare(ownedPage: Page, ownedContext: BrowserContext, version: string) {
    page = ownedPage; context = ownedContext; browserVersion = version; startedAt = Date.now()
    await installSaveWorkCounters(page)
    page.on('pageerror', error => errors.push(String(error)))
    const path = process.env.CRYKIT_SAVE_FIXTURE ?? '/__accounts-proof/local-save-performance.html'
    await page.goto(`${path}?mode=${mode === 'guest' ? 'guest' : 'account'}&size=${size}`)
    await page.waitForFunction(() => (window as any).localSaveProof?.ready() || (window as any).localSaveFailure)
    expect(await page.evaluate(() => (window as any).localSaveFailure)).toBeUndefined()
    if (process.env.CRYKIT_SAVE_ALLOW_DEV !== '1') expect(await page.evaluate(() => (window as any).localSaveProof.setup.build)).toBe('compiled')
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
    await openOperation(page, operation)
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
    let editorProbe: { value: string; canApply: boolean; work: ReturnType<Window['finishSaveWork']> } | undefined
    let nextInputWork: ReturnType<Window['finishSaveWork']> | undefined
    if (operation === 'Build notes') {
      const notes = page.getByPlaceholder('Optional play notes', { exact: true }), value = `Synthetic performance note ${index}`
      await notes.fill(value)
      await arm(page, 'click', 'button[type=submit]', mode === 'account-mapping')
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
          field.setSelectionRange(field.value.length, field.value.length)
        }
        return ready
      }, { revision: index + 2, value }, { timeout: SAVE_CEILING_MS })
      await notes.press(NEXT_INPUT_KEY)
      nextInputWork = await page.evaluate(value => {
        const field = document.activeElement
        if (!(field instanceof HTMLTextAreaElement) || !field.matches('textarea[placeholder="Optional play notes"]') || field.value !== `${value} `) throw new Error('The Build lost its next trusted input after saving')
        return window.finishSaveWork()
      }, value)
      expected = value
    } else if (operation === 'Save inventory') {
      const row = page.locator('.save-editor__inventory-row').filter({ hasText: 'Item #0 ·' }), input = row.getByRole('textbox'), value = String(3 + index % 2)
      await input.fill(value)
      await arm(page, 'click', '.save-editor__inventory-row button', mode === 'account-mapping')
      await row.getByRole('button').click()
      await idle(page, 'save')
      await expect(row.getByRole('button')).toBeDisabled({ timeout: SAVE_CEILING_MS })
      await expect(page.locator('.save-editor__state').filter({ hasText: /^Saved locally/ })).toBeVisible({ timeout: SAVE_CEILING_MS })
      expect(await input.inputValue()).toBe(value)
      await input.fill(String(3 + (index + 1) % 2))
      expect(await row.getByRole('button').isEnabled()).toBe(true)
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
        await idle(page, 'editor', 'Saved JSON edit; not applied')
      } else {
        await field.fill(value)
        // The quiet draft is a distinct command; Apply starts at its actual durable boundary
        await page.getByText('Saved JSON edit; not applied', { exact: true }).waitFor()
        await idle(page, 'editor')
        await arm(page, 'click', '.inspector-actions button', mode === 'account-mapping')
        await page.getByRole('button', { name: 'Apply JSON edit', exact: true }).click()
        await idle(page, 'editor')
        await expect(page.locator('.inspector-save-state')).toHaveText(mode === 'guest' ? 'Saved in this browser' : 'Saved on this device', { timeout: SAVE_CEILING_MS })
      }
      if (operation === 'invalid Editor draft') {
        // Exact saved text and the complete next-input text are checked below
        // Another full textarea read here only adds automation work to the measured interval
        // Type one real next character instead of retransmitting the complete document
        // Capture readiness and the clock together so later automation queries cannot extend this boundary
        // Use the field's retained focus; locator.press would refocus it and hide a continuation regression
        await page.keyboard.press(NEXT_INPUT_KEY)
      } else {
        const displayed = await field.evaluate(element => {
          if (!(element instanceof HTMLTextAreaElement)) throw new Error('The editor field is unavailable')
          // Match filling's end cursor without retransmitting the complete document
          element.setSelectionRange(element.value.length, element.value.length)
          return element.value
        })
        expect(displayed).toBe(value)
        // Focus follows the same explicit field interaction as filling, while one trusted key avoids resending the document
        await field.press(NEXT_INPUT_KEY)
      }
      editorProbe = await page.evaluate(() => {
        const element = document.activeElement
        if (!(element instanceof HTMLTextAreaElement) || !element.matches('.inspector-editor textarea')) throw new Error('The editor lost focus during autosave')
        const value = element.value
        const apply = [...document.querySelectorAll<HTMLButtonElement>('.inspector-actions button')].find(button => button.textContent?.trim() === 'Apply JSON edit')
        return { value, canApply: !!apply?.matches(':enabled'), work: window.finishSaveWork() }
      })
      expected = value
    }
    const work = editorProbe?.work ?? nextInputWork ?? await page.evaluate(() => window.finishSaveWork())
    // The trusted probe and undo are ordinary autosaved input after the timed readiness boundary
    // Drain only their local command before the durable oracle; real background mapping stays live
    if (operation.includes('Editor')) {
      await page.keyboard.press('Backspace')
      await idle(page, 'editor')
      expect(await page.getByLabel('Exact JSON value').inputValue()).toBe(expected)
    }
    const persisted = await inspect(page, operation === 'Save inventory' ? 'save' : operation.includes('Editor') ? 'editor' : 'planner')
    measures.push({ index, work, expected, persisted, ...(beforeInventory ? { beforeInventory } : {}), ...(editorProbe ? { nextInput: { exactText: editorProbe.value === `${expected} `, applyEnabled: editorProbe.canApply } } : nextInputWork ? { nextInput: { exactText: true, focused: true } } : {}) })
    expect(work.elapsedMs).toBeLessThanOrEqual(SAVE_CEILING_MS)
    if (editorProbe) {
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
    for (const record of previousRecords) {
      // Existing immutable bodies and catalogs retain their authenticated storage identities
      // Only the edited file's actual current dependencies may be consumed by this foreground operation
      expect(persisted.records.find((value: BodyRecord) => value.key === record.key)).toEqual(record)
      expect(observedWrites.has(record.storageId)).toBe(false)
      if (!consumed.has(record.key)) expect(observedReads.has(record.storageId)).toBe(false)
    }
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
    const receipt = JSON.stringify({ operation, mode, size, browser: browserVersion, hardware: { cpu: cpus()[0]?.model, memoryBytes: totalmem(), platform: platform(), release: release() }, setup: await page.evaluate(() => (window as any).localSaveProof?.setup).catch(() => undefined), measures: samples, diagnostics: await diagnostics(page).catch(() => undefined), mapperEvents: await page.evaluate(() => window.mapperEvents).catch(() => undefined), errors, qualification: 'Prepared synthetic managed root; installed account key is local-only. Main-thread payload/work observations exclude untimed durable oracles, worker activity and physical disk allocation. Long tasks are observed callbacks, not a complete trace. Mapping mode uses the actual profile-owned worker with encrypted queued projection; it does not establish cloud publication or complete portable restore.' }, (_key, value) => typeof value === 'bigint' ? { bigint: value.toString() } : value, 2)
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

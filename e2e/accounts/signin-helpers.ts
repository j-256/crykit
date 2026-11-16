import { expect, type Page, type CDPSession } from '@playwright/test'

export const ACCOUNT_PREPARATION_TIMEOUT_MS = 60_000

// User journeys wait for the real automatic continuation and explicitly leave meaningful guest work local
export async function finishAccountSignin(page: Page) {
  const choices = page.getByRole('heading', { name: 'Choose what to keep', exact: true })
  const ready = page.getByRole('complementary', { name: 'Account sync' })
  const acknowledgment = page.getByRole('button', { name: 'I have saved my security information. Continue', exact: true })
  await expect(choices.or(ready).or(acknowledgment)).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  if (await acknowledgment.isVisible()) { await acknowledgment.click(); await expect(choices.or(ready)).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }) }
  if (await choices.isVisible()) {
    await page.getByRole('button', { name: 'Use account data on this device', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm use account data', exact: true }).click()
  }
  await expect(ready).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
}

// These synthetic fixture paths need an authenticated key before initial account admission
// They preserve remember-device choice and mount the actual provider only after exact fixture creation
export async function beginSeededAccount(page: Page, app: string, email: string, password: string, remember = false) {
  const path = app.split('#')[0]
  await page.goto(`${path}?fixture-setup=1#/settings/account`)
  await page.waitForFunction(() => !!(window as any).accountBootstrapProof)
  await page.evaluate(input => (window as any).accountBootstrapProof.signIn(input), { email, password, remember })
}
export async function mountSeededAccount(page: Page) {
  await page.evaluate(() => (window as any).accountBootstrapProof.mount())
  await expect(page.getByRole('complementary', { name: 'Account sync' })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
}

export const SIGNIN_MERGE_REVIEW_TARGET_MS = 2_000
export const SIGNIN_MERGE_INPUT_TO_PAINT_TARGET_MS = 250

// Native request timings describe browser work; observer delivery can be delayed by the main thread
export async function installSigninMergeResponsivenessProbe(page: Page) {
  await page.evaluate(() => {
    const probe: any = { paints: [], events: [], longTasks: null, phases: [] }
    const input = document.createElement('input')
    input.setAttribute('aria-label', 'Synthetic responsiveness probe')
    input.style.cssText = 'position:fixed;right:8px;bottom:8px;width:120px;z-index:9999'
    const targets = new Map<number, EventTarget | null>()
    let responseSequence = 0
    const keydown = (event: KeyboardEvent) => {
      const requestedAt = event.timeStamp, handledAt = performance.now(), trusted = event.isTrusted
      const pendingAtInput = Array.from(document.querySelectorAll('h1, h2')).some(heading => heading.textContent === 'Preparing your workspace')
      targets.set(event.timeStamp, event.target)
      input.style.backgroundColor = ++responseSequence % 2 ? 'yellow' : 'white'
      requestAnimationFrame(() => requestAnimationFrame(() => probe.paints.push({ requestEpochMs: performance.timeOrigin + requestedAt, paintEpochMs: performance.timeOrigin + performance.now(), requestedAt, handledAt, pendingAtInput, trusted, keydownStartTime: event.timeStamp, paintOpportunityAt: performance.now(), elapsedMs: performance.now() - requestedAt })))
    }
    document.addEventListener('keydown', keydown, true)
    document.body.append(input)
    let activePhase: { name: string; trusted: boolean; startEpochMs: number; readyEpochMs?: number } | undefined
    let checkingPaint = false
    const visibleButton = (label: string) => Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === label && !button.disabled && button.getClientRects().length > 0)
    const visibleHeading = (label: string) => Array.from(document.querySelectorAll('h1, h2')).some(heading => heading.textContent?.trim() === label && heading.getClientRects().length > 0)
    const ready = () => activePhase?.name === 'signin' ? visibleHeading('Choose what to keep') && visibleButton('Merge (recommended)')
      : activePhase?.name === 'review' ? visibleHeading('Included records') && visibleButton('Confirm merge')
        : activePhase?.name === 'confirm' ? !!document.querySelector('aside[aria-label="Account sync"]')?.getClientRects().length && visibleButton('Account') : false
    const checkReady = () => {
      if (!activePhase || checkingPaint || !ready()) return
      checkingPaint = true
      const phase = activePhase
      requestAnimationFrame(() => requestAnimationFrame(() => {
        checkingPaint = false
        if (activePhase === phase && ready()) { phase.readyEpochMs = performance.timeOrigin + performance.now(); activePhase = undefined }
      }))
    }
    const mutations = new MutationObserver(checkReady)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
    const click = (event: Event) => {
      const button = (event.target as Element).closest('button')
      const label = button?.textContent?.trim()
      const name = label === 'Sign in' ? 'signin' : label === 'Merge (recommended)' ? 'review' : label === 'Confirm merge' ? 'confirm' : undefined
      if (name) {
        activePhase = { name, trusted: event.isTrusted, startEpochMs: performance.timeOrigin + event.timeStamp }
        probe.phases.push(activePhase)
      }
    }
    document.addEventListener('click', click, true)
    const observers: PerformanceObserver[] = []
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      probe.longTasks = []
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.longTasks.push({ startTime: entry.startTime, duration: entry.duration, observedAt: performance.now() }) })
      observer.observe({ type: 'longtask' }); observers.push(observer)
    }
    if (PerformanceObserver.supportedEntryTypes.includes('event')) {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries() as PerformanceEventTiming[]) if (entry.interactionId && ['keydown', 'keypress', 'keyup'].includes(entry.name)) probe.events.push({ name: entry.name, interactionId: entry.interactionId, syntheticTarget: targets.has(entry.startTime) && targets.get(entry.startTime) === entry.target, startTime: entry.startTime, duration: entry.duration, processingStart: entry.processingStart, processingEnd: entry.processingEnd, observedAt: performance.now() })
      })
      observer.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit); observers.push(observer)
    }
    probe.stop = () => { observers.forEach(observer => observer.disconnect()); mutations.disconnect(); document.removeEventListener('click', click, true); document.removeEventListener('keydown', keydown, true); input.remove() }
    ;(window as any).signinMergeResponsiveness = probe
  })
}

export async function readSigninMergeResponsivenessProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as any).signinMergeResponsiveness
    return { paints: probe.paints, events: probe.events, longTasks: probe.longTasks, phases: probe.phases, eventTimingAvailable: PerformanceObserver.supportedEntryTypes.includes('event') }
  })
}

export async function observeSigninMergeReadback<T>(read: () => Promise<T>): Promise<{ outcome: 'complete'; value: T } | { outcome: 'unavailable'; errorCode: 'observation-unavailable' }> {
  // A captured repository can retire after acceptance; optional diagnostics must not invent zero sizes
  // Mandatory acceptance assertions run before this boundary and are never caught here
  try { return { outcome: 'complete', value: await read() } }
  catch { return { outcome: 'unavailable', errorCode: 'observation-unavailable' } }
}

interface SigninMergeInputReceipt {
  readonly pendingAtInput: boolean
  readonly trusted: boolean
  readonly keydownStartTime?: number
  readonly requestedAt: number
  readonly handledAt: number
  readonly paintOpportunityAt: number
  readonly elapsedMs: number
}
interface SigninMergeInputTiming {
  readonly name: string
  readonly syntheticTarget: boolean
  readonly startTime: number
  readonly duration: number
}
interface SigninMergeResponsivenessReadback {
  readonly paints: readonly SigninMergeInputReceipt[]
  readonly events: readonly SigninMergeInputTiming[]
  readonly eventTimingAvailable: boolean
}
export function assessSigninMergeResponsiveness(probe: SigninMergeResponsivenessReadback | null) {
  const unavailable = (receiptStatus: 'missing' | 'off-phase' | 'untrusted' | 'unassociated' | 'pending', reason: 'probe-unavailable' | 'receipt-missing' | 'receipt-off-phase' | 'receipt-untrusted' | 'receipt-unassociated' | 'api-unsupported' | 'no-matching-entry') => ({ receiptStatus, eventTiming: { status: 'unavailable' as const, reason }, sampledInputToPaint: null })
  if (!probe) return unavailable('missing', 'probe-unavailable')
  if (!probe.paints.length) return unavailable('missing', 'receipt-missing')
  const pending = probe.paints.filter(receipt => receipt.pendingAtInput)
  if (!pending.length) return unavailable('off-phase', 'receipt-off-phase')
  const trusted = pending.filter(receipt => receipt.trusted)
  if (!trusted.length) return unavailable('untrusted', 'receipt-untrusted')
  const receipt = trusted.find(receipt => Number.isFinite(receipt.keydownStartTime) && Number.isFinite(receipt.paintOpportunityAt) && receipt.paintOpportunityAt >= receipt.handledAt)
  if (!receipt) return unavailable('unassociated', 'receipt-unassociated')
  if (!probe.eventTimingAvailable) return unavailable('pending', 'api-unsupported')
  // The native keydown timestamp and target identify this input, not another keyboard event in the interval
  // A receipt is mandatory even when Event Timing omits the matching event or the API is unavailable
  const timing = probe.events.find(event => event.name === 'keydown' && event.syntheticTarget && event.startTime === receipt.keydownStartTime && Number.isFinite(event.duration) && event.duration > 0)
  if (!timing) return unavailable('pending', 'no-matching-entry')
  return { receiptStatus: 'pending' as const, eventTiming: { status: 'available' as const, durationMs: timing.duration }, sampledInputToPaint: timing.duration <= SIGNIN_MERGE_INPUT_TO_PAINT_TARGET_MS }
}


export const SIGNIN_MERGE_INPUT_CADENCE_MS = 100
export const SIGNIN_MERGE_PREPARATION_PHASES = ['signin', 'review', 'confirm'] as const
const INPUT_CLOCK_TOLERANCE_MS = 1
export interface ScheduledSigninMergeInput {
  readonly id: number
  readonly phase: string
  readonly scheduledEpochMs: number
  readonly dispatchedEpochMs: number
  completedEpochMs: number
  outcome: 'pending' | 'complete' | 'failed'
}
export interface ScheduledSigninMergeProbe {
  readonly phases: readonly { name: string; trusted: boolean; startEpochMs: number; readyEpochMs?: number }[]
  readonly paints: readonly { requestEpochMs: number; paintEpochMs: number; trusted: boolean; keydownStartTime?: number }[]
}

// The schedule is fixed before each dispatch; CDP timestamps preserve time spent queued behind renderer work
// Keep actual dispatch/completion clocks separately and never infer paint from command completion
export async function sampleSigninMergePreparation(cdp: CDPSession, phase: string, samples: ScheduledSigninMergeInput[], action: () => Promise<void>) {
  let finished = false
  const started = performance.now(), epoch = Date.now()
  let due = started + SIGNIN_MERGE_INPUT_CADENCE_MS
  let wake: (() => void) | undefined
  const pump = (async () => {
    while (!finished) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(0, due - performance.now()))
        wake = () => { clearTimeout(timer); resolve() }
        if (finished) wake()
      })
      if (finished) break
      const sample: ScheduledSigninMergeInput = { id: samples.length, phase, scheduledEpochMs: epoch + due - started, dispatchedEpochMs: Date.now(), completedEpochMs: 0, outcome: 'pending' }
      samples.push(sample)
      try {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', timestamp: sample.scheduledEpochMs / 1000 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' })
        sample.outcome = 'complete'
      } catch { sample.outcome = 'failed' }
      finally { sample.completedEpochMs = Date.now() }
      due += SIGNIN_MERGE_INPUT_CADENCE_MS
    }
  })()
  try { await action() } finally { finished = true; wake?.(); await pump }
}

export function assessScheduledSigninMergeInputs(probe: ScheduledSigninMergeProbe | null, samples: readonly ScheduledSigninMergeInput[], requiredPhases: readonly string[] = SIGNIN_MERGE_PREPARATION_PHASES) {
  const browserPhases = requiredPhases.map(name => {
    const matches = probe?.phases.filter(phase => phase.name === name) ?? []
    const phase = matches.length === 1 ? matches[0] : undefined
    const status = !matches.length ? 'missing' : matches.length > 1 ? 'duplicate' : !phase?.trusted ? 'untrusted'
      : !Number.isFinite(phase.startEpochMs) || !Number.isFinite(phase.readyEpochMs) ? 'unfinished'
        : phase.readyEpochMs! < phase.startEpochMs ? 'invalid-clock' : 'complete'
    return { ...phase, name, status, elapsedMs: status === 'complete' ? phase!.readyEpochMs! - phase!.startEpochMs : null }
  })
  const scheduledInputReceipts = samples.map(sample => {
    const matches = probe?.paints.filter(receipt => Math.abs(receipt.requestEpochMs - sample.scheduledEpochMs) < INPUT_CLOCK_TOLERANCE_MS) ?? []
    const receipt = matches.length === 1 ? matches[0] : undefined
    const phase = browserPhases.find(phase => phase.name === sample.phase)
    const inPhase = phase?.status === 'complete' ? sample.scheduledEpochMs >= phase.startEpochMs! && sample.scheduledEpochMs <= phase.readyEpochMs! : null
    const receiptStatus = matches.length > 1 ? 'duplicate' : sample.outcome !== 'complete' ? 'dispatch-failed' : !receipt ? 'missing'
      : !receipt.trusted ? 'untrusted' : !Number.isFinite(receipt.keydownStartTime) || !Number.isFinite(receipt.paintEpochMs) ? 'unfinished' : 'associated'
    return { ...sample, inPhase, receiptStatus, scheduledToPaintOpportunityMs: receiptStatus === 'associated' ? receipt!.paintEpochMs - sample.scheduledEpochMs : null }
  })
  const phaseInputCoverage = browserPhases.map(phase => {
    const inputs = scheduledInputReceipts.filter(sample => sample.phase === phase.name && sample.inPhase)
    const points = [phase.startEpochMs!, ...inputs.map(sample => sample.scheduledEpochMs), phase.readyEpochMs!]
    const maximumScheduledGapMs = phase.status === 'complete' ? Math.max(...points.slice(1).map((point, index) => point - points[index])) : null
    // A phase shorter than the first cadence is explicitly unsampled, not a zero-latency success
    const available = phase.status === 'complete' && inputs.length > 0
    const passes = !available ? null : maximumScheduledGapMs! <= SIGNIN_MERGE_INPUT_TO_PAINT_TARGET_MS && inputs.every(input => input.receiptStatus === 'associated' && input.scheduledToPaintOpportunityMs! >= 0 && input.scheduledToPaintOpportunityMs! <= SIGNIN_MERGE_INPUT_TO_PAINT_TARGET_MS)
    return { name: phase.name, samples: inputs.length, maximumScheduledGapMs, status: !available ? phase.status === 'complete' ? 'unsampled' : phase.status : passes ? 'within-budget' : 'over-budget-or-missing-receipt', passes }
  })
  const wholePreparationResponsiveness = phaseInputCoverage.some(phase => phase.passes === false) ? false : phaseInputCoverage.some(phase => phase.passes === null) ? null : true
  const review = browserPhases.find(phase => phase.name === 'review')
  return { browserPhases, scheduledInputReceipts, phaseInputCoverage, wholePreparationResponsiveness, review: review?.status === 'complete' ? review.elapsedMs! < SIGNIN_MERGE_REVIEW_TARGET_MS : null }
}

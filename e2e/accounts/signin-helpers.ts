import { expect, type Page } from '@playwright/test'

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
    const probe: any = { paints: [], events: [], longTasks: null }
    const input = document.createElement('input')
    input.setAttribute('aria-label', 'Synthetic responsiveness probe')
    input.style.cssText = 'position:fixed;right:8px;bottom:8px;width:120px;z-index:9999'
    let keydownStartTime: number | undefined
    input.addEventListener('keydown', event => { keydownStartTime = event.isTrusted ? event.timeStamp : undefined })
    input.addEventListener('input', event => {
      const requestedAt = event.timeStamp, handledAt = performance.now(), trusted = event.isTrusted
      const keydown = keydownStartTime; keydownStartTime = undefined
      const pendingAtInput = Array.from(document.querySelectorAll('h1, h2')).some(heading => heading.textContent === 'Preparing your workspace')
      input.style.backgroundColor = input.value.length % 2 ? 'yellow' : 'white'
      requestAnimationFrame(() => requestAnimationFrame(() => probe.paints.push({ requestedAt, handledAt, pendingAtInput, trusted, keydownStartTime: keydown, paintOpportunityAt: performance.now(), elapsedMs: performance.now() - requestedAt })))
    })
    document.body.append(input)
    const focus = (event: Event) => {
      const button = (event.target as Element).closest('button')
      if (button?.textContent?.includes('Merge (recommended)')) input.focus()
    }
    document.addEventListener('click', focus)
    const observers: PerformanceObserver[] = []
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      probe.longTasks = []
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.longTasks.push({ startTime: entry.startTime, duration: entry.duration, observedAt: performance.now() }) })
      observer.observe({ type: 'longtask' }); observers.push(observer)
    }
    if (PerformanceObserver.supportedEntryTypes.includes('event')) {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries() as PerformanceEventTiming[]) if (entry.interactionId && ['keydown', 'keypress', 'keyup'].includes(entry.name)) probe.events.push({ name: entry.name, interactionId: entry.interactionId, syntheticTarget: entry.target === input, startTime: entry.startTime, duration: entry.duration, processingStart: entry.processingStart, processingEnd: entry.processingEnd, observedAt: performance.now() })
      })
      observer.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit); observers.push(observer)
    }
    probe.stop = () => { observers.forEach(observer => observer.disconnect()); document.removeEventListener('click', focus); input.remove() }
    ;(window as any).signinMergeResponsiveness = probe
  })
}

export async function readSigninMergeResponsivenessProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as any).signinMergeResponsiveness
    return { paints: probe.paints, events: probe.events, longTasks: probe.longTasks, eventTimingAvailable: PerformanceObserver.supportedEntryTypes.includes('event') }
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

import type { Page } from '@playwright/test'

interface SaveIdleObservation {
  current: boolean
  pending: boolean
  phase: string
  dirty: boolean
  hydrating: boolean
  acknowledged: boolean
  editable: boolean
  ready: boolean
  visibility: DocumentVisibilityState
}
interface SaveTransactionTiming {
  startedMs: number
  endedMs?: number
  mode: string
  stores: string[]
  outcome?: 'complete' | 'abort'
  requestCount: number
  requestSuccessCount: number
  firstRequestMs?: number
  firstRequestSuccessMs?: number
  lastRequestSuccessMs?: number
}
export interface SaveWork {
  started: number
  // Browser-observed acknowledgement; editor application time also includes trusted next-key handling and paint
  readyMs?: number
  applicationElapsedMs?: number
  driverGapMs?: number
  nextInputResponseMs?: number
  nextInputReady?: boolean
  transactions: Record<string, number>
  transactionTimings: SaveTransactionTiming[]
  idlePolling?: { firstMs: number; lastMs: number; maximumGapMs: number; samples: number; observations: (SaveIdleObservation & { atMs: number })[] }
  requests: Record<string, number>
  rowsRead: Record<string, number>
  rowsWritten: Record<string, number>
  recordsRead: Record<string, string[]>
  recordsWritten: Record<string, string[]>
  payloadRead: number
  payloadWritten: number
  encoded: number
  decoded: number
  encrypted: number
  decrypted: number
  longTasks: number[]
  longTaskTimings: { startedMs: number; durationMs: number }[]
  activeMappings: string[]
}
interface NextInputCapture { selector: string; value: string; budgetMs: number; enabledSelector?: string }
interface EditorNextInputCapture extends NextInputCapture { key: string }
declare global {
  interface Window {
    mapperEvents: { at: number; direction: 'sent' | 'received'; kind?: string; id?: string; pending?: boolean; status?: string }[]
    saveWork?: SaveWork
    recordSaveIdleObservation(observation: SaveIdleObservation): void
    armSaveWork(event: 'click' | 'input', selector: string, nextInput?: NextInputCapture): void
    armEditorNextInputWork(input: EditorNextInputCapture): void
    finishSaveWork(): SaveWork & { elapsedMs: number }
    finishNextInputWork(): Promise<SaveWork & { elapsedMs: number }>
    finishEditorInputWork(): Promise<SaveWork & { elapsedMs: number }>
  }
}

// Installed before Dexie captures native methods; counters span the full interval, including separately reported driver delay
// Payload bytes describe stored buffers, not physical browser disk allocation
export async function installSaveWorkCounters(page: Page) {
  await page.addInitScript(() => {
    window.mapperEvents = []
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (String(url).includes('account-local-mapping-worker')) this.addEventListener('message', event => {
          window.mapperEvents.push({ at: performance.now(), direction: 'received', id: event.data.id, status: event.data.status })
        })
      }
      override postMessage(message: any, transfer: Transferable[] | StructuredSerializeOptions = []) {
        // Record scheduling evidence only, never initialization keys, intent payloads or worker results
        if (message?.kind === 'map' || message?.kind === 'foreground') window.mapperEvents.push({ at: performance.now(), direction: 'sent', kind: message.kind, id: message.id, pending: message.pending })
        if (Array.isArray(transfer)) super.postMessage(message, transfer)
        else super.postMessage(message, transfer)
      }
    }
    const transactionProgress = new WeakMap<IDBTransaction, { started: number; timing: SaveTransactionTiming }>()
    const observeRequest = (request: IDBRequest) => {
      const progress = request.transaction && transactionProgress.get(request.transaction)
      if (!progress) return
      progress.timing.requestCount++
      progress.timing.firstRequestMs ??= performance.now() - progress.started
      request.addEventListener('success', () => {
        const atMs = performance.now() - progress.started
        progress.timing.firstRequestSuccessMs ??= atMs
        progress.timing.lastRequestSuccessMs = atMs
        progress.timing.requestSuccessCount++
      })
    }
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      const counters = window.saveWork, mode = args[1] ?? 'readonly'
      if (counters) counters.transactions[mode] = (counters.transactions[mode] ?? 0) + 1
      const result = transaction.apply(this, args)
      if (counters) {
        // Request and completion timestamps include callback scheduling, not just native storage work
        // Aggregate progress separates pre-request and post-request gaps without retaining keys or values
        // Retain only store names and outcomes, never database names, keys or record bodies
        const timing: SaveTransactionTiming = { startedMs: performance.now() - counters.started, mode, stores: Array.from(result.objectStoreNames), requestCount: 0, requestSuccessCount: 0 }
        counters.transactionTimings.push(timing)
        transactionProgress.set(result, { started: counters.started, timing })
        for (const outcome of ['complete', 'abort'] as const) result.addEventListener(outcome, () => {
          timing.endedMs = performance.now() - counters.started
          timing.outcome = outcome
        }, { once: true })
      }
      return result
    }
    for (const method of ['get', 'getAll', 'getKey', 'openCursor', 'openKeyCursor', 'getAllKeys', 'count'] as const) {
      const original = IDBObjectStore.prototype[method]
      Object.defineProperty(IDBObjectStore.prototype, method, { configurable: true, writable: true, value: function (this: IDBObjectStore, ...args: unknown[]) {
        const counters = window.saveWork, name = this.name
        const request = Reflect.apply(original, this, args) as IDBRequest
        observeRequest(request)
        if (counters) {
          counters.requests[name] = (counters.requests[name] ?? 0) + 1
          request.addEventListener('success', () => {
            const result = request.result, values = Array.isArray(result) ? result : result === undefined || result === null ? [] : [result.value ?? result]
            for (const value of values) if (value && typeof value === 'object') {
              counters.rowsRead[name] = (counters.rowsRead[name] ?? 0) + 1
              counters.payloadRead += value.bytes?.byteLength ?? 0
              const identity = value.payloadId ?? value.revisionId
              if (typeof identity === 'string') (counters.recordsRead[name] ??= []).push(identity)
            }
          })
        }
        return request
      } })
    }
    for (const method of ['put', 'add'] as const) {
      const original = IDBObjectStore.prototype[method]
      IDBObjectStore.prototype[method] = function (...args: Parameters<typeof original>) {
        const counters = window.saveWork
        if (counters) {
          counters.rowsWritten[this.name] = (counters.rowsWritten[this.name] ?? 0) + 1
          counters.payloadWritten += args[0]?.bytes?.byteLength ?? 0
          const identity = args[0]?.payloadId ?? args[0]?.revisionId
          if (typeof identity === 'string') (counters.recordsWritten[this.name] ??= []).push(identity)
        }
        const request = original.apply(this, args)
        observeRequest(request)
        return request
      }
    }
    for (const [prototype, methods] of [
      [IDBIndex.prototype, ['get', 'getAll', 'getKey', 'getAllKeys', 'openCursor', 'openKeyCursor', 'count']],
      [IDBObjectStore.prototype, ['delete', 'clear']],
    ] as const) for (const method of methods) {
      const original = Object.getOwnPropertyDescriptor(prototype, method)!.value
      Object.defineProperty(prototype, method, { configurable: true, writable: true, value: function (...args: unknown[]) {
        const request = Reflect.apply(original, this, args) as IDBRequest
        observeRequest(request)
        return request
      } })
    }
    const encode = TextEncoder.prototype.encode, decode = TextDecoder.prototype.decode
    TextEncoder.prototype.encode = function (...args) { const result = encode.apply(this, args); if (window.saveWork) window.saveWork.encoded += result.byteLength; return result }
    TextDecoder.prototype.decode = function (...args) { const result = decode.apply(this, args); if (window.saveWork) window.saveWork.decoded += args[0]?.byteLength ?? 0; return result }
    new PerformanceObserver(list => {
      const work = window.saveWork
      if (work) for (const entry of list.getEntries()) if (entry.startTime >= work.started) {
        work.longTasks.push(entry.duration)
        work.longTaskTimings.push({ startedMs: entry.startTime - work.started, durationMs: entry.duration })
      }
    }).observe({ type: 'longtask', buffered: true })
    window.recordSaveIdleObservation = observation => {
      const work = window.saveWork
      if (!work) return
      const atMs = performance.now() - work.started
      const polling = work.idlePolling ??= { firstMs: atMs, lastMs: atMs, maximumGapMs: 0, samples: 0, observations: [] }
      polling.maximumGapMs = Math.max(polling.maximumGapMs, atMs - polling.lastMs)
      polling.lastMs = atMs
      polling.samples++
      const previous = polling.observations.at(-1)
      if (!previous || Object.entries(observation).some(([key, value]) => previous[key as keyof SaveIdleObservation] !== value)) polling.observations.push({ atMs, ...observation })
    }
    let nextInputWork: Promise<SaveWork & { elapsedMs: number }> | undefined
    let cancelCapture: (() => void) | undefined
    let finishMissingEditorInput: (() => void) | undefined
    window.armSaveWork = (event, selector, nextInput) => {
      cancelCapture?.()
      cancelCapture = undefined
      finishMissingEditorInput = undefined
      nextInputWork = undefined
      const controller = new AbortController()
      document.addEventListener(event, received => {
        if (!(received.target instanceof Element) || !received.target.closest(selector)) return
        controller.abort()
        const replies = new Set(window.mapperEvents.filter(event => event.direction === 'received').map(event => event.id))
        const activeMappings = window.mapperEvents.filter(event => event.direction === 'sent' && event.kind === 'map' && event.id && !replies.has(event.id)).map(event => event.id!)
        window.saveWork = { started: performance.now(), transactions: {}, transactionTimings: [], requests: {}, rowsRead: {}, rowsWritten: {}, recordsRead: {}, recordsWritten: {}, payloadRead: 0, payloadWritten: 0, encoded: 0, decoded: 0, encrypted: 0, decrypted: 0, longTasks: [], longTaskTimings: [], activeMappings }
        if (nextInput) {
          const work = window.saveWork, capture = new AbortController()
          nextInputWork = new Promise(resolve => {
            let settled = false
            const finish = (ready: boolean) => {
              if (settled) return
              settled = true
              clearTimeout(deadline)
              capture.abort()
              if (window.saveWork === work) window.saveWork = undefined
              resolve({ ...work, elapsedMs: performance.now() - work.started, nextInputReady: ready })
            }
            // Capture the user-visible endpoint inside the browser, before driver result transport
            // Expiry is a failed sample even if delayed input arrives after acknowledgement
            const deadline = setTimeout(() => finish(false), nextInput.budgetMs)
            cancelCapture = () => finish(false)
            document.addEventListener('input', received => {
              const field = received.target
              if (!received.isTrusted || !(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) || !field.matches(nextInput.selector) || field.value !== nextInput.value) return
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const bounds = field.getBoundingClientRect()
                const nextActionReady = !nextInput.enabledSelector || document.querySelector(nextInput.enabledSelector)?.matches(':enabled')
                const ready = document.activeElement === field && field.isConnected && !field.disabled && !field.readOnly && !!bounds.width && !!bounds.height && getComputedStyle(field).visibility === 'visible' && field.value === nextInput.value && !!nextActionReady
                if (ready) finish(true)
              }))
            }, { capture: true, signal: capture.signal })
          })
        }
      }, { capture: true, signal: controller.signal })
    }
    window.armEditorNextInputWork = input => {
      const work = window.saveWork
      if (!work || work.readyMs === undefined || !Number.isFinite(work.readyMs) || work.readyMs < 0) throw new Error('Editor readiness was not observed')
      // Start before the driver issues input: native event timestamps can omit a command queued behind application work
      // This conservatively includes dispatch overhead instead of hiding blocked input as driver delay
      const readyMs = work.readyMs, responseStarted = performance.now(), capture = new AbortController()
      let trustedKey = false
      let deadline: number | undefined
      let finish!: (ready: boolean) => void
      nextInputWork = new Promise(resolve => {
        let settled = false
        finish = ready => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          capture.abort()
          const ended = performance.now(), elapsedMs = ended - work.started
          const timing = {
            driverGapMs: responseStarted - work.started - readyMs,
            nextInputResponseMs: ended - responseStarted,
            applicationElapsedMs: readyMs + ended - responseStarted,
          }
          if (window.saveWork === work) window.saveWork = undefined
          resolve({ ...work, ...timing, elapsedMs, nextInputReady: ready && trustedKey && timing.applicationElapsedMs <= input.budgetMs })
        }
        deadline = window.setTimeout(() => finish(false), Math.max(0, input.budgetMs - readyMs))
        window.addEventListener('keydown', event => {
          const field = event.target
          if (!event.isTrusted || event.key !== input.key || !(field instanceof HTMLTextAreaElement) || !field.matches(input.selector)) return
          trustedKey = true
        }, { capture: true, signal: capture.signal })
        document.addEventListener('input', event => {
          const field = event.target
          if (!trustedKey || !event.isTrusted || !(field instanceof HTMLTextAreaElement) || !field.matches(input.selector)) return
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const bounds = field.getBoundingClientRect()
            const nextActionReady = !input.enabledSelector || document.querySelector(input.enabledSelector)?.matches(':enabled')
            finish(document.activeElement === field && field.isConnected && !field.disabled && !field.readOnly && !!bounds.width && !!bounds.height && getComputedStyle(field).visibility === 'visible' && field.value === input.value && !!nextActionReady)
          }))
        }, { capture: true, signal: capture.signal })
      })
      cancelCapture = () => finish(false)
      // A completed driver command without a trusted key is a failed receipt, not an unbounded wait
      finishMissingEditorInput = () => { if (!trustedKey) finish(false) }
    }
    window.finishSaveWork = () => {
      const result = window.saveWork
      if (!result) throw new Error('The actual UI request was not observed')
      const elapsedMs = performance.now() - result.started
      window.saveWork = undefined
      return { ...result, elapsedMs }
    }
    window.finishNextInputWork = () => {
      if (!nextInputWork) throw new Error('The save and its next-input measurement were not observed')
      return nextInputWork
    }
    window.finishEditorInputWork = () => {
      if (!finishMissingEditorInput) throw new Error('The editor next-input measurement was not armed')
      finishMissingEditorInput()
      return window.finishNextInputWork()
    }
  })
}

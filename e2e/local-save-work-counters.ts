import type { Page } from '@playwright/test'

export interface SaveWork {
  started: number
  // Diagnostic acknowledgement time; the gated elapsed interval still includes the actual next input
  readyMs?: number
  transactions: Record<string, number>
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
  activeMappings: string[]
}
declare global {
  interface Window {
    mapperEvents: { at: number; direction: 'sent' | 'received'; kind?: string; id?: string; pending?: boolean; status?: string }[]
    saveWork?: SaveWork
    armSaveWork(event: 'click' | 'input', selector: string): void
    finishSaveWork(): SaveWork & { elapsedMs: number }
  }
}

// Installed before Dexie captures native methods; only the product operation interval is counted
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
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      const counters = window.saveWork, mode = args[1] ?? 'readonly'
      if (counters) counters.transactions[mode] = (counters.transactions[mode] ?? 0) + 1
      return transaction.apply(this, args)
    }
    for (const method of ['get', 'getAll', 'openCursor', 'getAllKeys', 'count'] as const) {
      const original = IDBObjectStore.prototype[method]
      Object.defineProperty(IDBObjectStore.prototype, method, { configurable: true, writable: true, value: function (this: IDBObjectStore, ...args: unknown[]) {
        const counters = window.saveWork, name = this.name
        const request = Reflect.apply(original, this, args) as IDBRequest
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
        return original.apply(this, args)
      }
    }
    const encode = TextEncoder.prototype.encode, decode = TextDecoder.prototype.decode
    TextEncoder.prototype.encode = function (...args) { const result = encode.apply(this, args); if (window.saveWork) window.saveWork.encoded += result.byteLength; return result }
    TextDecoder.prototype.decode = function (...args) { const result = decode.apply(this, args); if (window.saveWork) window.saveWork.decoded += args[0]?.byteLength ?? 0; return result }
    new PerformanceObserver(list => { if (window.saveWork) for (const entry of list.getEntries()) if (entry.startTime >= window.saveWork.started) window.saveWork.longTasks.push(entry.duration) }).observe({ type: 'longtask', buffered: true })
    window.armSaveWork = (event, selector) => {
      const controller = new AbortController()
      document.addEventListener(event, received => {
        if (!(received.target instanceof Element) || !received.target.closest(selector)) return
        controller.abort()
        const replies = new Set(window.mapperEvents.filter(event => event.direction === 'received').map(event => event.id))
        const activeMappings = window.mapperEvents.filter(event => event.direction === 'sent' && event.kind === 'map' && event.id && !replies.has(event.id)).map(event => event.id!)
        window.saveWork = { started: performance.now(), transactions: {}, requests: {}, rowsRead: {}, rowsWritten: {}, recordsRead: {}, recordsWritten: {}, payloadRead: 0, payloadWritten: 0, encoded: 0, decoded: 0, encrypted: 0, decrypted: 0, longTasks: [], activeMappings }
      }, { capture: true, signal: controller.signal })
    }
    window.finishSaveWork = () => {
      const result = window.saveWork
      if (!result) throw new Error('The actual UI request was not observed')
      const elapsedMs = performance.now() - result.started
      window.saveWork = undefined
      return { ...result, elapsedMs }
    }
  })
}

import type { Page } from '@playwright/test'

// Withhold only the caller's completion notification after a native transaction commits
// Independent readback must establish the durable receipt before a test reloads the page
export async function holdSigninInstallationReply(page: Page) {
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    let held = false
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      const value = args[0] as { id?: string }
      if (!held && this.name === 'syncState' && value?.id?.startsWith('signin-receipt:')) {
        held = true
        const transaction = this.transaction, complete = transaction.oncomplete
        transaction.oncomplete = event => {
          ;(window as any).signinInstallationCommitted = true
          ;(window as any).releaseSigninInstallationReply = () => complete?.call(transaction, event)
        }
      }
      return original.apply(this, args)
    }
  })
}

export async function readSigninInstallation(page: Page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(value => value.name).filter((value): value is string => !!value?.startsWith('crykit-account-v1-'))
    if (names.length !== 1) throw new Error('Expected one isolated synthetic account database')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(names[0]); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      const transaction = database.transaction(['profileMeta', 'syncState', 'preparationPayloads', 'encryptedRevisions', 'stagedCipherChunks'], 'readonly')
      const rows = await Promise.all(['profileMeta', 'syncState', 'preparationPayloads', 'encryptedRevisions', 'stagedCipherChunks'].map(name => new Promise<any[]>((resolve, reject) => { const request = transaction.objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })))
      const ciphertext = await Promise.all(rows[4].map(async chunk => ({ payloadId: chunk.payloadId, index: chunk.index, digest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', chunk.bytes)), byte => byte.toString(16).padStart(2, '0')).join('') })))
      return { ciphertext, active: rows[0].find(value => value.key === 'active'), pending: rows[1].find(value => value.id === 'guest-copy:pending'), receipts: rows[1].filter(value => value.id.startsWith('signin-receipt:')), reservations: rows[2], revisions: rows[3].map(value => value.revisionId).sort() }
    } finally { database.close() }
  })
}

// Deliver requests to the actual worker but suppress one response at the transport boundary
// The prepare case loses an inert ticket; the release case loses acknowledgment after installation
export async function holdSigninWorkerReply(page: Page, kind: 'prepare' | 'release') {
  await page.evaluate(kind => {
    const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage')!
    const post = Worker.prototype.postMessage, requests = new WeakMap<Worker, string>()
    Worker.prototype.postMessage = function (message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const input = message as { kind?: string; id?: string }
      if (input.kind === kind && input.id) requests.set(this, input.id)
      return Reflect.apply(post, this, [message, options])
    }
    Object.defineProperty(Worker.prototype, 'onmessage', { ...descriptor, set(listener) {
      descriptor.set!.call(this, listener && ((event: MessageEvent) => {
        if (event.data.status === 'complete' && event.data.id === requests.get(this)) {
          ;(window as any).signinWorkerReplyHeld = kind
          ;(window as any).signinWorkerHeldValue = event.data.value
          return
        }
        listener.call(this, event)
      }))
    } })
  }, kind)
}

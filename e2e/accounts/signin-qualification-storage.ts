import type { Page } from './test-fixture'
import type { AccountFence, CipherChunk, CipherRecord, CipherRef } from '../../src/persistence/account-database'

// Ciphertext readback remains available after explicit local continuation retires the account key
export async function accountTableDigests(page: Page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(value => value.name).filter((value): value is string => !!value?.startsWith('crykit-account-v1-'))
    if (names.length !== 1) throw new Error('Expected one isolated synthetic account database')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(names[0]); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      const stores = Array.from(database.objectStoreNames), transaction = database.transaction(stores, 'readonly')
      const tables = await Promise.all(stores.map(name => new Promise<[string, unknown[]]>((resolve, reject) => { const request = transaction.objectStore(name).getAll(); request.onsuccess = () => resolve([name, request.result]); request.onerror = () => reject(request.error) })))
      return Object.fromEntries(await Promise.all(tables.map(async ([name, rows]) => {
        const bytes = new TextEncoder().encode(JSON.stringify(rows, (_key, value) => value instanceof Uint8Array ? Array.from(value) : value))
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
        return [name, digest]
      })))
    } finally { database.close() }
  })
}


export async function mergeInstallationBoundary(page: Page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(value => value.name).filter((value): value is string => !!value?.startsWith('crykit-account-v1-'))
    if (names.length !== 1) throw new Error('Expected one isolated synthetic account database')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(names[0]); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      const protectedTables = ['profileMeta', 'documentHeads', 'migrationJournal', 'outbox', 'syncState']
      const countedTables = ['preparationPayloads', 'encryptedRevisions', 'stagedCipherChunks']
      const transaction = database.transaction([...protectedTables, ...countedTables], 'readonly')
      const read = (name: string, count: boolean) => new Promise<[string, unknown]>((resolve, reject) => {
        const request = count ? transaction.objectStore(name).count() : transaction.objectStore(name).getAll()
        request.onsuccess = () => resolve([name, request.result]); request.onerror = () => reject(request.error)
      })
      const rows = await Promise.all([...protectedTables.map(name => read(name, false)), ...countedTables.map(name => read(name, true))])
      return { protected: Object.fromEntries(rows.slice(0, protectedTables.length)), counts: Object.fromEntries(rows.slice(protectedTables.length)) }
    } finally { database.close() }
  })
}

// Read one selected dependency graph in a single transaction, excluding unrelated inert staging
// Hash after the transaction so asynchronous WebCrypto cannot silently close an incomplete IDB walk
export async function selectedAccountCiphertext(page: Page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(value => value.name).filter((value): value is string => !!value?.startsWith('crykit-account-v1-'))
    if (names.length !== 1) throw new Error('Expected one isolated synthetic account database')
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(names[0]); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      const captured = await new Promise<{ fence: AccountFence; rows: { record: CipherRecord; chunks: CipherChunk[] }[] }>((resolve, reject) => {
        const transaction = database.transaction(['profileMeta', 'encryptedRevisions', 'stagedCipherChunks'], 'readonly')
        let fence: AccountFence
        const rows: { record: CipherRecord; chunks: CipherChunk[] }[] = [], queued = new Map<string, string>()
        const fail = (error: unknown) => { reject(error); transaction.abort() }
        const enqueue = (ref: CipherRef) => {
          const prior = queued.get(ref.revisionId)
          if (prior) { if (prior !== ref.documentId) throw new Error('Contradictory selected dependency'); return }
          queued.set(ref.revisionId, ref.documentId)
          const request = transaction.objectStore('encryptedRevisions').get(ref.revisionId)
          request.onsuccess = () => {
            try {
              const record: CipherRecord | undefined = request.result
              if (!record || record.revisionId !== ref.revisionId || record.descriptor.revisionId !== ref.revisionId || record.descriptor.documentId !== ref.documentId) throw new Error('Missing or contradictory selected revision')
              const row = { record, chunks: [] as CipherChunk[] }; rows.push(row)
              const chunks = transaction.objectStore('stagedCipherChunks').index('payloadId').getAll(record.payloadId)
              chunks.onsuccess = () => {
                try {
                  row.chunks = (chunks.result as CipherChunk[]).sort((a, b) => a.index - b.index)
                  if (row.chunks.length !== record.descriptor.chunks.length || row.chunks.some((chunk, index) => chunk.payloadId !== record.payloadId || chunk.index !== index || record.descriptor.chunks[index].index !== index || chunk.bytes.byteLength !== record.descriptor.chunks[index].cipherBytes)) throw new Error('Missing or contradictory selected ciphertext chunk')
                } catch (error) { fail(error) }
              }
              for (const dependency of record.descriptor.dependencies) enqueue(dependency)
            } catch (error) { fail(error) }
          }
        }
        const selected = transaction.objectStore('profileMeta').get('active')
        selected.onsuccess = () => {
          try { fence = selected.result; if (!fence?.head) throw new Error('Missing selected account fence'); enqueue(fence.head) }
          catch (error) { fail(error) }
        }
        transaction.oncomplete = () => resolve({ fence, rows })
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error ?? new Error('Selected ciphertext observation aborted'))
      })
      const rows = await Promise.all(captured.rows.sort((a, b) => a.record.revisionId.localeCompare(b.record.revisionId)).map(async ({ record, chunks }) => ({ record, chunks: await Promise.all(chunks.map(async chunk => ({ payloadId: chunk.payloadId, index: chunk.index, byteLength: chunk.bytes.byteLength, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(chunk.bytes))), byte => byte.toString(16).padStart(2, '0')).join('') }))) })))
      return { fence: captured.fence, rows }
    } finally { database.close() }
  })
}

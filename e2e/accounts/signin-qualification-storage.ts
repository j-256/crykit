import type { Page } from './test-fixture'

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

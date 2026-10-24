import Dexie from 'dexie'

export interface FreshGuestTargetOpening {
  readonly dependencies: import('dexie').DexieOptions
  attach(database: Dexie): void
  assertOpen(database: Dexie): void
}

// The first native request is the authority: a prior existence query would leave a creation race
// A failed or late request is terminal so no partial target can be adopted by a retry
export function prepareFreshGuestTargetOpening(name: string, version: number): FreshGuestTargetOpening {
  const factory = Dexie.dependencies.indexedDB
  const nativeOpen = factory?.open.bind(factory)
  let terminal = false
  let attested: IDBDatabase | undefined
  let database: Dexie | undefined
  const deny = () => new Error('The restore target already exists or cannot be opened safely. Retry with a new restore attempt.')
  const indexedDB = {
    open(requestedName: string, requestedVersion?: number): IDBOpenDBRequest {
      if (terminal) throw new Dexie.DatabaseClosedError()
      if (requestedName !== name || requestedVersion !== version) throw deny()
      if (!nativeOpen) throw new Dexie.MissingAPIError()
      const request = nativeOpen(name, version)
      request.addEventListener('upgradeneeded', event => {
        if (terminal || event.oldVersion !== 0) {
          event.stopImmediatePropagation()
          request.transaction?.abort()
          return
        }
        attested = request.result
      })
      request.addEventListener('blocked', () => {
        terminal = true
        database?.close()
      })
      request.addEventListener('success', event => {
        if (terminal) {
          request.result.close()
          event.stopImmediatePropagation()
        }
      })
      return request
    },
    deleteDatabase() { throw new TypeError('A restore preparation cannot delete databases') },
    ...(factory && typeof factory.cmp === 'function' ? { cmp: factory.cmp.bind(factory) } : {}),
    ...(factory && typeof factory.databases === 'function' ? { databases: factory.databases.bind(factory) } : {}),
  }
  return {
    dependencies: { indexedDB, IDBKeyRange: Dexie.dependencies.IDBKeyRange, addons: [] },
    attach(value) {
      database = value
      value.on('close', () => { terminal = true; attested = undefined })
      value.on('ready', () => {
        if (terminal || !attested || value.backendDB() !== attested) throw deny()
      }, true)
    },
    assertOpen(value) {
      if (terminal || value !== database || !value.isOpen() || value.backendDB() !== attested) throw deny()
    },
  }
}

function nativeKeyPath(value: string): string | string[] {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1).split('+') : value
}

// A selected v2 participant must be the same native layout that staging created
// Checking the actual connection keeps an absent/older database from being created or migrated on reopen
export function prepareRequiredGuestTargetOpening(name: string, version: number, stores: Readonly<Record<string, string>>): FreshGuestTargetOpening {
  const factory = Dexie.dependencies.indexedDB
  const nativeOpen = factory?.open.bind(factory)
  let terminal = false
  let attested: IDBDatabase | undefined
  let database: Dexie | undefined
  const deny = () => new Error('The selected restore target is missing or has an unsupported native layout. Keep both profiles and recover explicitly.')
  const matches = (connection: IDBDatabase): boolean => {
    const names = Object.keys(stores).sort()
    if (connection.version !== version || JSON.stringify(Array.from(connection.objectStoreNames).sort()) !== JSON.stringify(names)) return false
    const transaction = connection.transaction(names, 'readonly')
    for (const name of names) {
      const parts = stores[name]!.split(',').map(value => value.trim())
      const store = transaction.objectStore(name)
      if (store.autoIncrement || JSON.stringify(store.keyPath) !== JSON.stringify(nativeKeyPath(parts[0]!))) return false
      const indexes = parts.slice(1).sort()
      if (JSON.stringify(Array.from(store.indexNames).sort()) !== JSON.stringify(indexes)) return false
      for (const index of indexes) {
        const nativeIndex = store.index(index)
        if (nativeIndex.unique || nativeIndex.multiEntry || JSON.stringify(nativeIndex.keyPath) !== JSON.stringify(nativeKeyPath(index))) return false
      }
    }
    return true
  }
  const indexedDB = {
    open(requestedName: string, requestedVersion?: number): IDBOpenDBRequest {
      if (terminal) throw new Dexie.DatabaseClosedError()
      if (requestedName !== name || requestedVersion !== version || !nativeOpen) throw deny()
      const request = nativeOpen(name, version)
      request.addEventListener('upgradeneeded', event => {
        terminal = true
        event.stopImmediatePropagation()
        request.transaction?.abort()
      })
      request.addEventListener('blocked', () => { terminal = true; database?.close() })
      request.addEventListener('success', event => {
        if (terminal) { request.result.close(); event.stopImmediatePropagation(); return }
        if (!matches(request.result)) { terminal = true; return }
        attested = request.result
      })
      return request
    },
    deleteDatabase() { throw new TypeError('A required restore target cannot delete databases') },
    ...(factory && typeof factory.cmp === 'function' ? { cmp: factory.cmp.bind(factory) } : {}),
    ...(factory && typeof factory.databases === 'function' ? { databases: factory.databases.bind(factory) } : {}),
  }
  return {
    dependencies: { indexedDB, IDBKeyRange: Dexie.dependencies.IDBKeyRange, addons: [] },
    attach(value) {
      database = value
      value.on('close', () => { terminal = true; attested = undefined })
      value.on('ready', () => { if (terminal || !attested || value.backendDB() !== attested) throw deny() }, true)
    },
    assertOpen(value) { if (terminal || value !== database || !value.isOpen() || value.backendDB() !== attested) throw deny() },
  }
}

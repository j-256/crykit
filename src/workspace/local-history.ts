import type { CipherRef } from '../persistence/account-database'
import type { PersistedHistoryEntry } from '../interchange/types'
import { immutableHistory } from './history-admission'
import { NativeHistorySchema } from '../interchange/native-schema'

export interface LocalHistoryEntry { readonly id: string; readonly ref: CipherRef }
export interface LocalHistory { readonly entries: readonly LocalHistoryEntry[] }
const captured = new WeakMap<LocalHistory, ReadonlyMap<string, PersistedHistoryEntry>>()

const deepFrozen = new WeakSet<object>()
function freezeHistory(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value) || deepFrozen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value)) freezeHistory(child, seen)
  Object.freeze(value)
  deepFrozen.add(value)
}

// Native checkpoints retain their exact logical values; only new checkpoints invoke the body writer
// Previously admitted values are recursively frozen so identity reuse cannot conceal mutation
export async function prepareLocalHistory(values: readonly PersistedHistoryEntry[], write: (value: PersistedHistoryEntry) => Promise<CipherRef>, previous?: LocalHistory, endpoints?: { readonly before: PersistedHistoryEntry['before']; readonly after: PersistedHistoryEntry['after'] }): Promise<LocalHistory> {
  const old = previous && captured.get(previous)
  if (previous && !old) throw new Error('Unadmitted local history')
  const priorRefs = new Map(previous?.entries.map(entry => [entry.id, entry.ref]))
  const next = new Map<string, PersistedHistoryEntry>(), entries: LocalHistoryEntry[] = []
  for (const value of values) {
    if (next.has(value.id)) throw new Error('Duplicate local history identity')
    const before = old?.get(value.id)
    let ref = priorRefs.get(value.id)
    if (before) {
      if (before !== value && JSON.stringify(before) !== JSON.stringify(value)) throw new Error('Immutable local history changed')
      next.set(value.id, before)
    } else {
      if (endpoints && value.before === endpoints.before && value.after === endpoints.after) {
        const { before: _before, after: _after, ...metadata } = value
        NativeHistorySchema.omit({ before: true, after: true }).parse(metadata)
      } else immutableHistory(value)
      freezeHistory(value)
      ref = await write(value)
      next.set(value.id, value)
    }
    entries.push(Object.freeze({ id: value.id, ref: Object.freeze({ ...ref! }) }))
  }
  if (old && [...old.keys()].some(id => !next.has(id))) throw new Error('Retained local history was removed')
  const result = Object.freeze({ entries: Object.freeze(entries) })
  captured.set(result, next)
  return result
}

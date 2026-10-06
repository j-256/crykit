import { useCallback, useMemo, useRef, useState } from 'react'

interface QueuedTileUpdate<State> {
  readonly count: number
  readonly state: State
}

export function useQueuedTileUpdates<Key, State>() {
  const queuedRef = useRef<ReadonlyMap<Key, QueuedTileUpdate<State>>>(new Map())
  const [queuedUpdates, setQueuedUpdates] = useState(queuedRef.current)
  const pendingCount = useMemo(() => [...queuedUpdates.values()].reduce((total, update) => total + update.count, 0), [queuedUpdates])
  const enqueue = useCallback((key: Key, baseState: State, transition: (state: State) => State, commit: () => Promise<void>, onError: (reason: unknown) => void) => {
    // Refs carry same-frame clicks before React renders; saved props can still describe an earlier intent
    const queued = queuedRef.current.get(key)
    const next = new Map(queuedRef.current)
    next.set(key, { count: (queued?.count ?? 0) + 1, state: transition(queued ? queued.state : baseState) })
    queuedRef.current = next
    setQueuedUpdates(next)

    const settle = () => {
      const current = queuedRef.current.get(key)
      if (!current) return
      const updated = new Map(queuedRef.current)
      // Keep the latest requested state until this key drains, even after intermediate acknowledgments or failures
      if (current.count === 1) updated.delete(key)
      else updated.set(key, { ...current, count: current.count - 1 })
      queuedRef.current = updated
      setQueuedUpdates(updated)
    }

    // Register every intent immediately with the application's serialized save queue
    let saving: Promise<void>
    try { saving = commit() } catch (reason) { saving = Promise.reject(reason) }
    void saving.then(settle, (reason: unknown) => {
      try { onError(reason) } finally { settle() }
    })
  }, [])

  return { queuedUpdates, pendingCount, enqueue }
}

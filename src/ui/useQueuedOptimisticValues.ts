import { useCallback, useState } from 'react'

interface QueuedValue<Value> {
  readonly value: Value
  readonly count: number
}

export function useQueuedOptimisticValues<Value>() {
  const [queued, setQueued] = useState<ReadonlyMap<string, QueuedValue<Value>>>(() => new Map())
  const enqueue = useCallback((key: string, initial: Value, update: (value: Value) => Value, persist: () => Promise<void>) => {
    setQueued(current => {
      const previous = current.get(key)
      const next = new Map(current)
      next.set(key, { value: update(previous?.value ?? initial), count: (previous?.count ?? 0) + 1 })
      return next
    })
    return persist().finally(() => {
      setQueued(current => {
        const pending = current.get(key)
        if (!pending) return current
        const next = new Map(current)
        if (pending.count === 1) next.delete(key)
        else next.set(key, { ...pending, count: pending.count - 1 })
        return next
      })
    })
  }, [])
  return { queued, enqueue }
}

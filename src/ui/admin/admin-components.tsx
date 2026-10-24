import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdminClient } from './admin-client'
import { adminErrorMessage } from './admin-client'
import { capacity } from './admin-math'
import { size, type Page } from './admin-view'
import { AdminHelp } from './admin-help'

export function CapacityMeter({
  used,
  limit,
  label,
  helpText,
}: {
  used: number | null | undefined
  limit: number | null | undefined
  label: string
  helpText?: string
}) {
  const meter = capacity(used, limit)
  const value =
    used == null || limit == null
      ? 'unavailable'
      : limit === 0
        ? `${size(used)} of ${size(limit)}; percentage unavailable${meter.over ? '; over capacity' : ''}`
        : `${size(used)} of ${size(limit)} (${meter.percent?.toFixed(1)}%)${meter.over ? '; over capacity' : ''}`
  const statement = `${label}: ${value}`
  return (
    <div className="admin-capacity">
      <p>{helpText ? <AdminHelp label={label} text={helpText} /> : label}: {value}</p>
      <div className="admin-meter" role="img" aria-label={statement}>
        <span style={{ width: `${meter.barPercent}%` }} />
      </div>
    </div>
  )
}

export function PageControls<T>({
  page,
  index,
  previous,
  next,
  reset,
  noun,
}: {
  page: Page<T>
  index: number
  previous(): void
  next(cursor: string): void
  reset(): void
  noun: string
}) {
  return (
    <div className="admin-page-controls">
      <p>
        Page {index + 1} · {page.items.length} {noun} on this page
      </p>
      <div className="admin-actions">
        <button type="button" disabled={index === 0} onClick={previous}>
          Previous page
        </button>
        <button type="button" disabled={!page.next} onClick={() => page.next && next(page.next)}>
          Next page
        </button>
        {index > 0 && (
          <button type="button" onClick={reset}>
            First page
          </button>
        )}
      </div>
    </div>
  )
}

export function usePage() {
  const [history, setHistory] = useState<string[]>([''])
  const cursor = history[history.length - 1]
  return {
    cursor,
    index: history.length - 1,
    next: (token: string) => setHistory((old) => [...old, token]),
    previous: () => setHistory((old) => (old.length > 1 ? old.slice(0, -1) : old)),
    reset: () => setHistory(['']),
  }
}

export function useActionRefresh(key: number, refresh: () => Promise<void>) {
  const previous = useRef(key)
  useEffect(() => {
    if (previous.current === key) return
    previous.current = key
    void refresh()
  }, [key, refresh])
}

export function useAdminDetail<T>(
  client: AdminClient,
  prefix: string,
  id: string | null,
  refreshKey = 0,
) {
  const [value, setValue] = useState<T | null>(null)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [loadedRefreshKey, setLoadedRefreshKey] = useState(-1)
  const [error, setError] = useState('')
  const [failedId, setFailedId] = useState<string | null>(null)
  const [failedRefreshKey, setFailedRefreshKey] = useState(-1)
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++sequence.current
    setValue(null)
    setLoadedId(null)
    setError('')
    setFailedId(null)
    if (!id) {
      setLoading(false)
      return
    }
    setLoading(true)
    // Selection and receipt changes invalidate older reads before they can become actionable
    try {
      const result = await client.get<T>(`${prefix}/${encodeURIComponent(id)}`)
      if (sequence.current === current) {
        setValue(result)
        setLoadedId(id)
        setLoadedRefreshKey(refreshKey)
      }
    } catch (reason) {
      if (sequence.current === current) {
        setError(adminErrorMessage(reason))
        setFailedId(id)
        setFailedRefreshKey(refreshKey)
      }
    } finally {
      if (sequence.current === current) setLoading(false)
    }
  }, [client, id, prefix, refreshKey])
  useEffect(() => {
    void refresh()
    return () => {
      sequence.current++
    }
  }, [refresh, refreshKey])
  return {
    value: loadedId === id && loadedRefreshKey === refreshKey ? value : null,
    error: failedId === id && failedRefreshKey === refreshKey ? error : '',
    loading,
    refresh,
  }
}

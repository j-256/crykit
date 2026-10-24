import { useCallback, useEffect, useRef, useState } from 'react'
import { AdminClient, adminErrorMessage } from './admin-client'

export function useAdminData<T>(client: AdminClient, path: string) {
  const [value, setValue] = useState<T | null>(null)
  const [loadedPath, setLoadedPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++sequence.current
    setLoading(true)
    setError('')
    try { const result = await client.get<T>(path); if (sequence.current === current) { setValue(result); setLoadedPath(path) } }
    catch (reason) { if (sequence.current === current) { setValue(null); setLoadedPath(path); setError(adminErrorMessage(reason)) } }
    finally { if (sequence.current === current) setLoading(false) }
  }, [client, path])
  useEffect(() => { void refresh(); return () => { sequence.current++ } }, [refresh])
  // A changed filter must never render old rows while the replacement request is pending
  return { value: loadedPath === path ? value : null, loading: loadedPath === path ? loading : true, error: loadedPath === path ? error : '', refresh }
}
export function DataState({ loading, error, empty }: { loading: boolean; error: string; empty?: boolean }) {
  if (loading) return <p role="status">Loading...</p>
  if (error) return <p className="admin-error" role="alert">{error}</p>
  if (empty) return <p>No records match.</p>
  return null
}

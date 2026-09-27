import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { EMPTY_CORRECTIONS, hiddenCorrectionKeys, projectCorrectedCatalogs, type CatalogCorrection, type CorrectionCollection } from '../domain/corrections'
import type { CatalogSnapshot } from '../domain/types'
import { saveCorrections, subscribeCorrections } from '../persistence/corrections'
import { formatAppError } from './model'

const EMPTY_CATALOGS: readonly CatalogSnapshot[] = []

export function useCorrectionStore(baseline: readonly CatalogSnapshot[] = EMPTY_CATALOGS) {
  const [collection, setCollection] = useState<CorrectionCollection>(EMPTY_CORRECTIONS)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => subscribeCorrections(value => {
    setCollection(current => value.revision >= current.revision ? value : current)
    setReady(true)
    setError(undefined)
  }, reason => {
    setError(formatAppError(reason, 'Local corrections could not be loaded.'))
    setReady(true)
  }), [])
  const save = useCallback(async (entries: readonly CatalogCorrection[], revision: number) => {
    const next = await saveCorrections(entries, revision)
    setCollection(current => next.revision >= current.revision ? next : current)
  }, [])
  const catalogs = useMemo(() => projectCorrectedCatalogs(baseline, collection.entries), [baseline, collection.entries])
  const hiddenKeys = useMemo(() => hiddenCorrectionKeys(baseline, collection.entries), [baseline, collection.entries])
  return { collection, catalogs, baseline, hiddenKeys, ready, error, save }
}

export const CorrectionsContext = createContext<ReturnType<typeof useCorrectionStore> | undefined>(undefined)

export function useCorrections() {
  const context = useContext(CorrectionsContext)
  if (!context) throw new Error('CorrectionsContext is required')
  return context
}

export function useOptionalCorrections() {
  return useContext(CorrectionsContext)
}

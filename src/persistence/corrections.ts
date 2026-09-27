import { liveQuery } from 'dexie'
import { sameCorrectionValue, EMPTY_CORRECTIONS, type CatalogCorrection, type CorrectionCollection } from '../domain/corrections'
import { parseCorrectionCollection, serializeCorrectionCollection } from '../interchange/corrections'
import { AppDataError, asAppDataError } from '../interchange/errors'
import { getDatabase } from './database'

export const CORRECTIONS_STORAGE_KEY = 'catalog-corrections-v1'

export async function loadCorrections(): Promise<CorrectionCollection> {
  const record = await getDatabase().meta.get(CORRECTIONS_STORAGE_KEY)
  return record ? parseCorrectionCollection(record.value) : EMPTY_CORRECTIONS
}

export function subscribeCorrections(onValue: (value: CorrectionCollection) => void, onError: (error: unknown) => void): () => void {
  const subscription = liveQuery(loadCorrections).subscribe({ next: onValue, error: onError })
  return () => subscription.unsubscribe()
}

export async function saveCorrections(entries: readonly CatalogCorrection[], expectedRevision: number): Promise<CorrectionCollection> {
  const next = { revision: expectedRevision + 1, entries }
  const value = serializeCorrectionCollection(next)
  const database = getDatabase()
  try {
    await database.transaction('rw', database.meta, async () => {
      const current = await loadCorrections()
      if (current.revision !== expectedRevision) throw new AppDataError('revision-conflict', 'Another tab changed corrections. Your draft is intact. Reopen it against the latest corrections before saving')
      const incoming = new Map(entries.map(entry => [entry.id, entry]))
      if (current.entries.some(entry => !sameCorrectionValue(entry, incoming.get(entry.id)))) throw new AppDataError('import-conflict', 'Saved decisions are immutable. Add a new decision with explicit supersession')
      await database.meta.put({ key: CORRECTIONS_STORAGE_KEY, value })
    })
    return next
  } catch (error) {
    throw asAppDataError(error, { code: 'storage-failure', userMessage: 'Corrections could not be saved. Previous corrections are unchanged', recoverable: true })
  }
}

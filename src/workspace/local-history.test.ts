import { expect, it } from 'vitest'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import type { PersistedHistoryEntry } from '../interchange/types'
import { prepareLocalHistory } from './local-history'

function checkpoint(id: string, revision: number): PersistedHistoryEntry {
  const before = { ...createSampleLocalData(BUNDLED_CATALOGS[0]), revision }
  return { id, localDataId: before.id, command: 'synthetic-save', previousRevision: revision, nextRevision: revision + 1, before, after: { ...before, revision: revision + 1 }, recordedAt: before.updatedAt }
}

it('appends one exact native checkpoint and reuses every prior stored body', async () => {
  const old = checkpoint('old', 0), next = checkpoint('new', 1)
  const written: PersistedHistoryEntry[] = []
  const write = async (value: PersistedHistoryEntry) => {
    written.push(structuredClone(value))
    return { documentId: 'history', revisionId: String(written.length) }
  }
  const first = await prepareLocalHistory([old], write)
  const second = await prepareLocalHistory([old, next], write, first)
  expect(written).toEqual([old, next])
  expect(second.entries[0]).toEqual(first.entries[0])
  expect(second.entries.map(value => value.id)).toEqual(['old', 'new'])
  await prepareLocalHistory([old, next], write, second)
  expect(written).toHaveLength(2)
})

it('rejects changed immutable history, duplicate identity and removal of retained history', async () => {
  const old = checkpoint('old', 0)
  const write = async () => ({ documentId: 'history', revisionId: 'original' })
  const first = await prepareLocalHistory([old], write)
  await expect(prepareLocalHistory([{ ...old, command: 'rewritten' }], write, first)).rejects.toThrow(/histor/i)
  await expect(prepareLocalHistory([old, old], write, first)).rejects.toThrow(/duplicate/i)
  await expect(prepareLocalHistory([], write, first)).rejects.toThrow(/histor/i)
})

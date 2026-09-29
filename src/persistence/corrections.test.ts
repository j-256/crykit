import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLocalData, exportBackup, commitImport, previewImport } from './local-data'
import { createBlankLocalData } from '../domain/local-data'
import { mergeCorrections } from '../domain/corrections'
import { testCorrection } from '../domain/corrections.test-helpers'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import { CORRECTIONS_STORAGE_KEY, loadCorrections, saveCorrectionDraft, saveCorrections, subscribeCorrections } from './corrections'

describe('global correction storage', () => {
  let database: CrystalCompanionDatabase
  beforeEach(() => {
    database = new CrystalCompanionDatabase(`corrections-${crypto.randomUUID()}`)
    setDatabaseForTests(database)
  })
  afterEach(async () => { setDatabaseForTests(undefined); await database.delete() })

  it('merges unrelated concurrent drafts and rejects a changed target atomically', async () => {
    const starting = await loadCorrections()
    const first = testCorrection()
    const unrelated = testCorrection({ id: 'unrelated', target: { ...first.target, entityId: 'another-item' as typeof first.target.entityId } })
    await Promise.all([saveCorrectionDraft(first, starting), saveCorrectionDraft(unrelated, starting)])
    const saved = await loadCorrections()
    expect(saved.entries).toHaveLength(2)
    await expect(saveCorrectionDraft(testCorrection({ id: 'competing' }), starting)).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(await loadCorrections()).toEqual(saved)
    await saveCorrectionDraft(testCorrection({ id: 'replacement', supersedes: [first.id] }), saved)
    expect((await loadCorrections()).entries.map(entry => entry.id)).toEqual(['replacement', first.id, unrelated.id])
  })

  it('retries the same editor draft after a storage failure without recording a partial revision', async () => {
    const starting = await loadCorrections()
    const entry = testCorrection()
    vi.spyOn(database.meta, 'put').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
    await expect(saveCorrectionDraft(entry, starting)).rejects.toMatchObject({ code: 'storage-failure' })
    expect(await loadCorrections()).toEqual(starting)
    expect((await saveCorrectionDraft(entry, starting)).entries).toEqual([entry])
  })

  it('starts blank, persists independently of playthroughs, and updates live subscribers', async () => {
    expect(await loadCorrections()).toEqual({ revision: 0, entries: [] })
    const revisions: number[] = []
    const stop = subscribeCorrections(value => revisions.push(value.revision), error => { throw error })
    try {
      await vi.waitFor(() => expect(revisions).toContain(0))
      const saved = await saveCorrections([testCorrection()], 0)
      const localData = createBlankLocalData()
      await database.localDatas.put({ id: localData.id, revision: 0, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
      expect(await loadCorrections()).toEqual(saved)
      await vi.waitFor(() => expect(revisions).toContain(1))
      expect((await database.localDatas.get(localData.id))?.localData).toEqual(localData)
    } finally { stop() }
  })
  it('rejects simultaneous writes and immutable ID replacement without dropping the winner', async () => {
    const first = testCorrection()
    const second = testCorrection({ id: 'second' })
    const results = await Promise.allSettled([saveCorrections([first], 0), saveCorrections([second], 0)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'revision-conflict' } })
    const current = await loadCorrections()
    await expect(saveCorrections([{ ...current.entries[0]!, reason: 'overwritten' }], 1)).rejects.toMatchObject({ code: 'import-conflict' })
    expect(await loadCorrections()).toEqual(current)
  })
  it('rolls back a failed import transaction and allows retrying the exact collection', async () => {
    const entry = testCorrection()
    await saveCorrections([entry], 0)
    const second = testCorrection({ id: 'second', supersedes: [entry.id] })
    const entries = mergeCorrections([entry], [second])
    vi.spyOn(database.meta, 'put').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
    await expect(saveCorrections(entries, 1)).rejects.toMatchObject({ code: 'storage-failure' })
    expect((await loadCorrections()).entries).toEqual([entry])
    expect((await saveCorrections(entries, 1)).entries).toEqual(entries)
  })
  it('reports corrupt stored content instead of silently clearing it', async () => {
    await database.meta.put({ key: CORRECTIONS_STORAGE_KEY, value: '{broken' })
    await expect(loadCorrections()).rejects.toThrow('valid JSON')
    expect((await database.meta.get(CORRECTIONS_STORAGE_KEY))?.value).toBe('{broken')
  })
  it('includes global decisions in full backups and restores them only when requested', async () => {
    await loadLocalData()
    const correction = testCorrection()
    await saveCorrections([correction], 0)
    const bytes = await exportBackup()
    const preview = await previewImport(bytes, 'synthetic-correction-backup.zip')
    expect(preview.proposed.corrections?.entries).toEqual([correction])
    const restoredDatabase = new CrystalCompanionDatabase(`restore-${crypto.randomUUID()}`)
    setDatabaseForTests(restoredDatabase)
    try {
      await loadLocalData()
      await commitImport(preview)
      expect((await loadCorrections()).entries).toEqual([])
      await commitImport(preview, { restoreCorrections: true })
      expect((await loadCorrections()).entries).toEqual([correction])
    } finally { setDatabaseForTests(database); await restoredDatabase.delete() }
  })
  it('rolls back correction restoration when a full backup import fails later', async () => {
    await loadLocalData()
    const correction = testCorrection()
    await saveCorrections([correction], 0)
    const preview = await previewImport(await exportBackup(), 'synthetic-backup.zip')
    const destination = new CrystalCompanionDatabase(`rollback-${crypto.randomUUID()}`)
    setDatabaseForTests(destination)
    try {
      const original = await loadLocalData()
      vi.spyOn(destination.localDatas, 'put').mockRejectedValueOnce(new Error('Synthetic localData import failure'))
      await expect(commitImport(preview, { restoreCorrections: true })).rejects.toThrow()
      expect((await loadCorrections()).entries).toEqual([])
      expect(await loadLocalData()).toEqual(original)
    } finally { setDatabaseForTests(database); await destination.delete() }
  })

})

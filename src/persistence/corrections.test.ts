import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadWorkspace, exportBackup, commitImport, previewImport } from './workspace'
import { createBlankProfile } from '../domain/profile'
import { mergeCorrections } from '../domain/corrections'
import { testCorrection } from '../domain/corrections.test-helpers'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import { CORRECTIONS_STORAGE_KEY, loadCorrections, saveCorrections, subscribeCorrections } from './corrections'

describe('global correction storage', () => {
  let database: CrystalCompanionDatabase
  beforeEach(() => {
    database = new CrystalCompanionDatabase(`corrections-${crypto.randomUUID()}`)
    setDatabaseForTests(database)
  })
  afterEach(async () => { setDatabaseForTests(undefined); await database.delete() })

  it('starts blank, persists independently of playthroughs, and updates live subscribers', async () => {
    expect(await loadCorrections()).toEqual({ revision: 0, entries: [] })
    const revisions: number[] = []
    const stop = subscribeCorrections(value => revisions.push(value.revision), error => { throw error })
    try {
      await vi.waitFor(() => expect(revisions).toContain(0))
      const saved = await saveCorrections([testCorrection()], 0)
      const profile = createBlankProfile()
      await database.profiles.put({ id: profile.id, revision: 0, updatedAt: profile.updatedAt, profile, lineage: { rootProfileId: profile.id } })
      expect(await loadCorrections()).toEqual(saved)
      await vi.waitFor(() => expect(revisions).toContain(1))
      expect((await database.profiles.get(profile.id))?.profile).toEqual(profile)
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
  it('includes global decisions in full backups and restores them only when requested', { timeout: 15_000 }, async () => {
    const workspace = await loadWorkspace()
    const correction = testCorrection()
    await saveCorrections([correction], 0)
    const bytes = await exportBackup(workspace.profile.id)
    const preview = await previewImport(bytes, 'synthetic-correction-backup.zip')
    expect(preview.proposed.corrections?.entries).toEqual([correction])
    const restoredDatabase = new CrystalCompanionDatabase(`restore-${crypto.randomUUID()}`)
    setDatabaseForTests(restoredDatabase)
    try {
      await commitImport(preview)
      expect((await loadCorrections()).entries).toEqual([])
      await commitImport(preview, { restoreCorrections: true })
      expect((await loadCorrections()).entries).toEqual([correction])
    } finally { setDatabaseForTests(database); await restoredDatabase.delete() }
  })
  it('rolls back correction restoration when a full backup import fails later', async () => {
    const workspace = await loadWorkspace()
    const correction = testCorrection()
    await saveCorrections([correction], 0)
    const preview = await previewImport(await exportBackup(workspace.profile.id), 'synthetic-backup.zip')
    const destination = new CrystalCompanionDatabase(`rollback-${crypto.randomUUID()}`)
    setDatabaseForTests(destination)
    try {
      vi.spyOn(destination.profiles, 'add').mockRejectedValueOnce(new Error('Synthetic profile import failure'))
      await expect(commitImport(preview, { restoreCorrections: true })).rejects.toThrow()
      expect((await loadCorrections()).entries).toEqual([])
      expect(await destination.profiles.count()).toBe(0)
    } finally { setDatabaseForTests(database); await destination.delete() }
  })

})

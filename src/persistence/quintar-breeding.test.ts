import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QUINTAR_STEP } from '../catalog/quintar-breeding'
import { requirePlaythrough, toggleQuintarStep } from '../domain'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, saveLocalData, undoLocalDataWithStatus } from './local-data'

let database: CrystalCompanionDatabase
beforeEach(() => { database = new CrystalCompanionDatabase(`quintar-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })

it('rolls back a failed transaction, retries the step, and undoes its completion', async () => {
  const loaded = await loadLocalData()
  const before = loaded.localData
  const next = toggleQuintarStep(before, { stepId: QUINTAR_STEP.babel, playthroughId: requirePlaythrough(before).id })
  const historyCount = await database.history.count()
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(saveLocalData(next, before.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(before)
  expect(await database.history.count()).toBe(historyCount)
  const saved = await saveLocalData(next, before.revision)
  expect(requirePlaythrough(saved).quintarBreeding).toHaveProperty(QUINTAR_STEP.babel)
  const undone = await undoLocalDataWithStatus(saved.revision)
  expect(requirePlaythrough(undone.localData).quintarBreeding).toEqual(requirePlaythrough(before).quintarBreeding)
})

it('round-trips completion timestamps through native backup and rejects unsupported step records', async () => {
  const loaded = await loadLocalData()
  let next = toggleQuintarStep(loaded.localData, { stepId: QUINTAR_STEP.golden, playthroughId: requirePlaythrough(loaded.localData).id })
  next = toggleQuintarStep(next, { stepId: QUINTAR_STEP.trustyBlue, playthroughId: requirePlaythrough(next).id })
  const saved = await saveLocalData(next, loaded.revision)
  const preview = await previewImport(await exportBackup(), 'synthetic-quintar.zip')
  expect(preview.errors).toEqual([])
  const restored = await commitImport(preview, { mode: 'replace', targetLocalDataId: saved.id, expectedRevision: saved.revision })
  expect(requirePlaythrough(restored.localData).quintarBreeding).toEqual(requirePlaythrough(saved).quintarBreeding)
  expect(requirePlaythrough(restored.localData).inventory).toEqual(requirePlaythrough(loaded.localData).inventory)
  const invalid = (quintarBreeding: unknown) => ({ ...saved, playthroughs: { ...saved.playthroughs, [requirePlaythrough(saved).id]: { ...requirePlaythrough(saved), quintarBreeding } } })
  expect(NativeLocalDataSchema.safeParse(invalid({ bogus: new Date().toISOString() })).success).toBe(false)
  expect(NativeLocalDataSchema.safeParse(invalid({ babel: 'not-a-date' })).success).toBe(false)
})

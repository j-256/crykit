import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { importSkillTrees } from '../domain/skill-trees'
import { screenshotTestLocalData, TEST_CAPTURE } from '../domain/skill-trees.test-helpers'
import { requirePlaythrough } from '../domain'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, saveLocalData, undoLocalDataWithStatus } from './local-data'

let database: CrystalCompanionDatabase
beforeEach(() => { database = new CrystalCompanionDatabase(`screenshot-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })

it('rolls back failed screenshot saves, supports retry, and undoes the whole batch', async () => {
  const loaded = await loadLocalData()
  const before = await saveLocalData(screenshotTestLocalData(loaded.localData), loaded.revision)
  const capture = { ...TEST_CAPTURE, gameSetupRevisionId: undefined }
  const next = importSkillTrees(before, loaded.catalogs, [capture], before.revision)
  const historyCount = await database.history.count()
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(saveLocalData(next, before.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(before)
  expect(await database.history.count()).toBe(historyCount)
  const saved = await saveLocalData(next, before.revision)
  expect(requirePlaythrough(saved).skillTreeCaptures).toEqual(requirePlaythrough(next).skillTreeCaptures)
  const undone = await undoLocalDataWithStatus(saved.revision)
  expect(requirePlaythrough(undone.localData).characters).toEqual(requirePlaythrough(before).characters)
  expect(requirePlaythrough(undone.localData).skillTreeCaptures).toEqual(requirePlaythrough(before).skillTreeCaptures)
  expect(undone.localData.skillTreeLayouts).toEqual(before.skillTreeLayouts)
})

it('round-trips screenshot evidence and layouts through a restored native backup', async () => {
  const loaded = await loadLocalData()
  const before = await saveLocalData(screenshotTestLocalData(loaded.localData), loaded.revision)
  const next = importSkillTrees(before, loaded.catalogs, [{ ...TEST_CAPTURE, gameSetupRevisionId: undefined }], before.revision)
  const saved = await saveLocalData(next, before.revision)
  const preview = await previewImport(await exportBackup(), 'synthetic-learning.zip')
  const restored = await commitImport(preview, { mode: 'replace', targetLocalDataId: saved.id, expectedRevision: saved.revision })
  expect(restored.localData.id).toBe(saved.id)
  expect(requirePlaythrough(restored.localData).characters).toEqual(requirePlaythrough(saved).characters)
  expect(requirePlaythrough(restored.localData).skillTreeCaptures).toEqual(requirePlaythrough(saved).skillTreeCaptures)
  expect(restored.localData.skillTreeLayouts).toEqual(saved.skillTreeLayouts)
})

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { importSkillTrees } from '../domain/skill-trees'
import { screenshotTestProfile, TEST_CAPTURE } from '../domain/skill-trees.test-helpers'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadWorkspace, previewImport, saveProfile, undoProfileWithStatus } from './workspace'

let database: CrystalCompanionDatabase
beforeEach(() => { database = new CrystalCompanionDatabase(`screenshot-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })

it('rolls back failed screenshot saves, supports retry, and undoes the whole batch', async () => {
  const workspace = await loadWorkspace()
  const before = await saveProfile(screenshotTestProfile(workspace.profile), workspace.revision)
  const capture = { ...TEST_CAPTURE, rulesetRevisionId: undefined }
  const next = importSkillTrees(before, workspace.catalogs, [capture], before.revision)
  const historyCount = await database.history.count()
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(saveProfile(next, before.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadWorkspace(before.id)).profile).toEqual(before)
  expect(await database.history.count()).toBe(historyCount)
  const saved = await saveProfile(next, before.revision)
  expect(saved.skillTreeCaptures).toEqual(next.skillTreeCaptures)
  const undone = await undoProfileWithStatus(saved.id, saved.revision)
  expect(undone.profile.characters).toEqual(before.characters)
  expect(undone.profile.skillTreeCaptures).toEqual(before.skillTreeCaptures)
  expect(undone.profile.skillTreeLayouts).toEqual(before.skillTreeLayouts)
})

it('round-trips screenshot evidence and layouts through a restored native backup', async () => {
  const workspace = await loadWorkspace()
  const before = await saveProfile(screenshotTestProfile(workspace.profile), workspace.revision)
  const next = importSkillTrees(before, workspace.catalogs, [{ ...TEST_CAPTURE, rulesetRevisionId: undefined }], before.revision)
  const saved = await saveProfile(next, before.revision)
  const preview = await previewImport(await exportBackup(saved.id), 'synthetic-learning.zip')
  const restored = await commitImport(preview, { mode: 'new-profile' })
  expect(restored.profile.id).not.toBe(saved.id)
  expect(restored.profile.characters).toEqual(saved.characters)
  expect(restored.profile.skillTreeCaptures).toEqual(saved.skillTreeCaptures)
  expect(restored.profile.skillTreeLayouts).toEqual(saved.skillTreeLayouts)
})

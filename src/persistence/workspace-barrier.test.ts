import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import Dexie from 'dexie'
import { CryKitDatabase } from './database'
import { loadLocalData, saveLocalDataWithStatus } from './local-data'
import { InspectorStorage } from '../mod-inspector/storage'
import { acquireParticipantBarrier, releaseParticipantBarrier } from '../workspace/guest-barrier'

it('fences actual planner mutations including automatic catalog cleanup inside their transactions', async () => {
  const database = new CryKitDatabase(`barrier-planner-${crypto.randomUUID()}`)
  try {
    const loaded = await loadLocalData(database)
    await acquireParticipantBarrier(database, 'operation')
    await expect(saveLocalDataWithStatus(loaded.localData, loaded.revision, database)).rejects.toThrow('retired')
    await expect(loadLocalData(database)).rejects.toThrow('retired')
    await expect(database.catalogs.clear()).rejects.toThrow('retired')
    await expect(releaseParticipantBarrier(database, 'other')).rejects.toThrow()
    await releaseParticipantBarrier(database, 'operation')
    expect((await loadLocalData(database)).revision).toBe(loaded.revision)
  } finally { await database.delete() }
})
it('fences real inspector save, delete and import while retaining old data', async () => {
  const name = `barrier-inspector-${crypto.randomUUID()}`
  const inspector = new InspectorStorage(name)
  const native = new Dexie(name)
  try {
    const draft = await inspector.import('original.json', '{"original":true}', 'generic')
    await native.open()
    await acquireParticipantBarrier(native, 'operation')
    await expect(inspector.save(draft.id, '{"changed":true}', draft.revision)).rejects.toThrow('retired')
    await expect(inspector.remove(draft.id, draft.revision)).rejects.toThrow('retired')
    await expect(inspector.import('another.json', '{}', 'generic')).rejects.toThrow('retired')
    expect((await inspector.get(draft.id))?.draftText).toBe(draft.draftText)
    await releaseParticipantBarrier(native, 'operation')
    expect((await inspector.save(draft.id, '{"changed":true}', draft.revision)).revision).toBe(draft.revision + 1)
  } finally { inspector.close(); await native.delete() }
})

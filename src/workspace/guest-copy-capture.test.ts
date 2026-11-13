import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { CryKitDatabase } from '../persistence/database'
import { createBlankLocalData } from '../domain/local-data'
import { captureGuestWorkspaceForCopy } from './guest-repository'

it.each([1, 2, 3, 4, 5, 6])('rejects prelaunch planner layout %s before copying or rewriting stored data', async version => {
  const original = new CryKitDatabase(`synthetic-prelaunch-copy-${crypto.randomUUID()}`), raw = new Dexie(original.name)
  raw.version(version).stores({ localDatas: '&id' })
  const data = createBlankLocalData()
  const row = { id: 'local-data-record', revision: data.revision, updatedAt: data.updatedAt, localData: { ...data, schemaVersion: '2.4.0' }, lineage: { rootLocalDataId: data.id } }
  await raw.table('localDatas').put(row)
  raw.close()
  const retained = new Dexie(original.name)
  try {
    await expect(captureGuestWorkspaceForCopy(original)).rejects.toMatchObject({ code: 'PRELAUNCH_GUEST_DATA' })
    await retained.open()
    expect(retained.backendDB().version).toBe(version * 10)
    expect(await retained.table('localDatas').get(row.id)).toEqual(row)
  } finally { original.close(); retained.close() }
})

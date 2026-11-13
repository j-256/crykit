import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { CryKitDatabase } from '../persistence/database'

it.each([1, 2, 3, 4, 5, 6])('rejects direct opening of prelaunch planner layout %s and rolls back the upgrade', async version => {
  const name = `synthetic-unsupported-layout-${crypto.randomUUID()}`
  const raw = new Dexie(name)
  raw.version(version).stores({ localDatas: '&id', meta: '&key' })
  const row = { id: 'local-data-record', localData: { schemaVersion: '2.4.0', privateValue: 'synthetic preserved bytes' } }
  await raw.table('localDatas').put(row)
  raw.close()
  const candidate = new CryKitDatabase(name), retained = new Dexie(name)
  try {
    await expect(candidate.open()).rejects.toThrow(/prelaunch/i)
    await retained.open()
    expect(retained.backendDB().version).toBe(version * 10)
    expect(await retained.table('localDatas').get(row.id)).toEqual(row)
  } finally { candidate.close(); retained.close() }
})

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport } from './local-data'
import { readModSource } from './mod-library'
import { modLibrary } from '../domain/mod-library'

let database: CryKitDatabase
const original = '\ufeff{\r\n"ID":"synthetic-library","Title":"Synthetic mod","EditorVersion":34,"Passives":[{"ID":91000,"Name":"Synthetic passive","PP":1}]\r\n}'
beforeEach(() => { database = new CryKitDatabase(`mods-library-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { setDatabaseForTests(undefined); await database.delete() })

it('opens exact saved sources for editing and keeps both revisions through a backup round trip', async () => {
  const before = await loadLocalData()
  const save = async (text: string) => commitImport(await previewImport(new TextEncoder().encode(text), 'synthetic.json'), { mode: 'add-reference' })
  const first = await save(original)
  const firstPin = modLibrary(first.catalogs)[0]!.revisions[0]!
  expect(await readModSource(firstPin)).toEqual({ filename: 'synthetic.json', text: original })
  const changed = original.replace('"PP":1', '"PP":2')
  const second = await save(changed)
  expect(second.localData.playthroughs).toEqual(before.localData.playthroughs)
  expect(second.localData.gameSetups).toEqual(before.localData.gameSetups)
  expect(second.localData.buildRevisions).toEqual(before.localData.buildRevisions)
  const repeated = await save(changed)
  expect(repeated.revision).toBe(second.revision)
  const backup = await previewImport(await exportBackup(), 'synthetic-backup.zip')
  const restored = await commitImport(backup)
  const mods = modLibrary(restored.catalogs)
  expect(mods).toHaveLength(1)
  expect(mods[0]!.revisions).toHaveLength(2)
  expect((await readModSource(firstPin)).text).toBe(original)
  expect(new Set(await Promise.all(mods[0]!.revisions.map(async revision => (await readModSource(revision)).text)))).toEqual(new Set([original, changed]))
})

it('rejects missing or damaged source bytes instead of manufacturing an editable file', async () => {
  await loadLocalData()
  const added = await commitImport(await previewImport(new TextEncoder().encode(original), 'synthetic.json'), { mode: 'add-reference' })
  const pin = modLibrary(added.catalogs)[0]!.revisions[0]!
  const source = (await database.sources.toArray())[0]!
  await database.sources.put({ ...source, bytes: new TextEncoder().encode('{}') })
  await expect(readModSource(pin)).rejects.toThrow('missing or damaged')
  await database.sources.delete(source.id)
  await expect(readModSource(pin)).rejects.toThrow('missing or damaged')
})

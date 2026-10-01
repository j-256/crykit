import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSPECTOR_TEXT_CHUNK_CODE_UNITS, InspectorStorage, summarizeInspectorDraft } from './storage'
import { deriveInspectorFileInfo } from './file-info'
import { parseDocument } from './document'
import type { InspectorDraft } from './types'

const stores: InspectorStorage[] = []
const names: string[] = []
const inspectedDatabases: Dexie[] = []
function createStore(name = `synthetic-inspector-${crypto.randomUUID()}`): InspectorStorage {
  if (!names.includes(name)) names.push(name)
  const store = new InspectorStorage(name)
  stores.push(store)
  return store
}

async function inspectDatabase(name: string): Promise<Dexie> {
  const database = new Dexie(name)
  await database.open()
  inspectedDatabases.push(database)
  return database
}

function chunkedText(label = 'Synthetic original'): string {
  const prefix = '\ufeff{"Unknown":"'
  return prefix + 'x'.repeat(INSPECTOR_TEXT_CHUNK_CODE_UNITS - prefix.length - 1) + '\ud83d\ude00|' + label + '|\ud800|\udc00|' + 'y'.repeat(INSPECTOR_TEXT_CHUNK_CODE_UNITS) + '","ID":900719925474099312345}\r\n'
}

function legacyRow(id = 'synthetic-legacy', originalText = '{}', draftText = originalText): InspectorDraft {
  return { schemaVersion: 1, id, filename: 'Synthetic legacy.json', originalText, draftText, referenceId: 'synthetic-pinned-reference', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', revision: 7 }
}

async function createLegacyDatabase(rows: readonly InspectorDraft[]): Promise<string> {
  const name = `synthetic-inspector-legacy-${crypto.randomUUID()}`
  names.push(name)
  const database = new Dexie(name)
  database.version(1).stores({ drafts: 'id, updatedAt' })
  await database.table<InspectorDraft>('drafts').bulkAdd([...rows])
  database.close()
  return name
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const database of inspectedDatabases.splice(0)) database.close()
  for (const name of names.splice(0)) await Dexie.delete(name)
})

describe('isolated inspector draft persistence', () => {
  it('stores bounded UTF16 chunks and round-trips BOM, split surrogate pairs, lone surrogates and unknown numeric literals', async () => {
    const store = createStore()
    const text = chunkedText()
    const imported = await store.import('Synthetic chunks.json', text, 'synthetic-reference')
    const database = await inspectDatabase(names[0])
    expect(database.verno).toBe(2)
    const metadata = await database.table('drafts').get(imported.id)
    expect(metadata).toMatchObject({ schemaVersion: 1, layoutVersion: 2, originalPayload: { codeUnits: text.length }, draftPayload: { codeUnits: text.length } })
    expect(metadata).not.toHaveProperty('originalText')
    expect(metadata).not.toHaveProperty('draftText')
    const chunks = await database.table('chunks').where('draftId').equals(imported.id).toArray()
    expect(chunks).toHaveLength(2 * Math.ceil(text.length / INSPECTOR_TEXT_CHUNK_CODE_UNITS))
    expect(chunks.every(chunk => chunk.text.length <= INSPECTOR_TEXT_CHUNK_CODE_UNITS)).toBe(true)
    expect(chunks.find(chunk => chunk.kind === 'original' && chunk.index === 0).text.charCodeAt(INSPECTOR_TEXT_CHUNK_CODE_UNITS - 1)).toBe(0xd83d)
    expect(chunks.find(chunk => chunk.kind === 'original' && chunk.index === 1).text.charCodeAt(0)).toBe(0xde00)
    store.close()
    const reopened = createStore(names[0])
    expect(await reopened.get(imported.id)).toEqual(imported)
  })

  it('replaces only draft chunks and removes surplus chunks when an edit shortens the document', async () => {
    const store = createStore()
    const imported = await store.import('Synthetic chunks.json', chunkedText(), 'synthetic-reference')
    const database = await inspectDatabase(names[0])
    const originals = await database.table('chunks').where('[draftId+kind]').equals([imported.id, 'original']).toArray()
    const editedText = '{"Unknown":false,"ID":900719925474099312345}'
    const saved = await store.save(imported.id, editedText, imported.revision)
    expect(saved.originalText).toBe(imported.originalText)
    expect(saved.draftText).toBe(editedText)
    expect(await store.get(imported.id)).toEqual(saved)
    expect(await database.table('chunks').where('[draftId+kind]').equals([imported.id, 'original']).toArray()).toEqual(originals)
    const drafts = await database.table('chunks').where('[draftId+kind]').equals([imported.id, 'draft']).toArray()
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ revision: saved.revision, index: 0, text: editedText })
    expect(await store.list()).toEqual([summarizeInspectorDraft(saved)])
  })

  it('lists metadata only while full originals and drafts remain available on selection', async () => {
    const store = createStore()
    const first = await store.import('First.json', '{"Unknown":"Synthetic first"}', 'ref-first')
    const second = await store.import('Second.json', '{"Unknown":"Synthetic second"}', 'ref-second')
    const saved = await store.save(first.id, '{"Unknown":"Synthetic edit"}', first.revision)
    const summaries = await store.list()
    expect(summaries).toEqual(expect.arrayContaining([summarizeInspectorDraft(saved), summarizeInspectorDraft(second)]))
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('originalText')
      expect(summary).not.toHaveProperty('draftText')
    }
    expect(await store.get(first.id)).toEqual(saved)
    expect(await store.get(second.id)).toEqual(second)
  })

  it('round-trips exact originals, edits and reference pins across a reopened database', async () => {
    const store = createStore()
    const text = '\ufeff{ "ID": 900719925474099312345, "Unknown": null }\r\n'
    const imported = await store.import('Synthetic.json', text, 'synthetic-reference-v1')
    const saved = await store.save(imported.id, text.replace('null', 'true'), imported.revision)
    expect(saved).toMatchObject({ schemaVersion: 1, originalText: text, referenceId: 'synthetic-reference-v1', createdAt: imported.createdAt, revision: imported.revision + 1 })
    store.close()
    const reopened = createStore(names[0])
    expect(await reopened.get(imported.id)).toEqual(saved)
    expect(await reopened.list()).toEqual([summarizeInspectorDraft(saved)])
    await reopened.remove(saved.id, saved.revision)
    expect(await reopened.get(saved.id)).toBeUndefined()
  })

  it('rejects invalid imports and saves without modifying any existing draft', async () => {
    const store = createStore()
    const imported = await store.import('Synthetic.json', '{"Unknown":900719925474099312345}', 'ref')
    await expect(store.import('Invalid.json', '{"ID":1,"ID":2}', 'ref')).rejects.toThrow(/Duplicate/)
    await expect(store.save(imported.id, '{"Unknown":NaN}', imported.revision)).rejects.toThrow()
    expect(await store.list()).toEqual([summarizeInspectorDraft(imported)])
  })

  it('serializes competing tabs so only one expected-revision write can succeed', async () => {
    const first = createStore()
    const second = createStore(names[0])
    const imported = await first.import('Synthetic.json', '{"value":1}', 'ref')
    const results = await Promise.allSettled([first.save(imported.id, '{"value":2}', imported.revision), second.save(imported.id, '{"value":3}', imported.revision)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner = await first.get(imported.id)
    expect(winner?.revision).toBe(imported.revision + 1)
    await expect(second.remove(imported.id, imported.revision)).rejects.toThrow(/another tab/)
    expect(await second.get(imported.id)).toEqual(winner)
  })

  it('rolls back an aborted IndexedDB save after the write was issued', async () => {
    const store = createStore()
    const imported = await store.import('Synthetic.json', '{"value":1}', 'ref')
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...arguments_: Parameters<typeof put>) {
      const request = put.apply(this, arguments_)
      this.transaction.abort()
      return request
    })
    await expect(store.save(imported.id, '{"value":2}', imported.revision)).rejects.toThrow()
    vi.restoreAllMocks()
    expect(await store.get(imported.id)).toEqual(imported)
  })

  it('rolls back an aborted import and rejects edits of missing drafts', async () => {
    const store = createStore()
    const add = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...arguments_: Parameters<typeof add>) {
      const request = add.apply(this, arguments_)
      this.transaction.abort()
      return request
    })
    await expect(store.import('Synthetic.json', '{}', 'ref')).rejects.toThrow()
    vi.restoreAllMocks()
    expect(await store.list()).toEqual([])
    await expect(store.save('missing', '{}', 1)).rejects.toThrow(/no longer exists/)
    await expect(store.remove('missing', 1)).rejects.toThrow(/no longer exists/)
  })

  it('rolls back metadata and prior chunk writes when a later import chunk fails', async () => {
    const store = createStore()
    const existing = await store.import('Existing.json', '{}', 'ref')
    let failedId: string | undefined
    const add = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...arguments_: Parameters<typeof add>) {
      const request = add.apply(this, arguments_)
      const value = arguments_[0] as { draftId?: string; kind?: string; index?: number }
      if (this.name === 'chunks' && value.kind === 'original' && value.index === 1) { failedId = value.draftId; this.transaction.abort() }
      return request
    })
    await expect(store.import('Failed.json', chunkedText(), 'ref')).rejects.toThrow()
    vi.restoreAllMocks()
    expect(await store.list()).toEqual([summarizeInspectorDraft(existing)])
    const database = await inspectDatabase(names[0])
    expect(failedId).toBeDefined()
    expect(await database.table('chunks').where('draftId').equals(failedId!).count()).toBe(0)
    expect(await store.get(existing.id)).toEqual(existing)
  })

  it('restores old draft chunks and revision when a replacement chunk fails after deletion and a partial write', async () => {
    const store = createStore()
    const imported = await store.import('Synthetic chunks.json', chunkedText(), 'ref')
    const add = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...arguments_: Parameters<typeof add>) {
      const request = add.apply(this, arguments_)
      const value = arguments_[0] as { kind?: string; index?: number }
      if (this.name === 'chunks' && value.kind === 'draft' && value.index === 1) this.transaction.abort()
      return request
    })
    await expect(store.save(imported.id, chunkedText('Synthetic edited'), imported.revision)).rejects.toThrow()
    vi.restoreAllMocks()
    expect(await store.get(imported.id)).toEqual(imported)
    expect(await store.list()).toEqual([summarizeInspectorDraft(imported)])
  })

  it('restores metadata and all chunks when deletion fails after the chunk deletion', async () => {
    const store = createStore()
    const imported = await store.import('Synthetic chunks.json', chunkedText(), 'ref')
    const remove = IDBObjectStore.prototype.delete
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, ...arguments_: Parameters<typeof remove>) {
      const request = remove.apply(this, arguments_)
      if (this.name === 'drafts') this.transaction.abort()
      return request
    })
    await expect(store.remove(imported.id, imported.revision)).rejects.toThrow()
    vi.restoreAllMocks()
    expect(await store.get(imported.id)).toEqual(imported)
    await store.remove(imported.id, imported.revision)
    const database = await inspectDatabase(names[0])
    expect(await database.table('chunks').where('draftId').equals(imported.id).count()).toBe(0)
    expect(await store.get(imported.id)).toBeUndefined()
  })

  it.each(['missing', 'length', 'content', 'revision', 'extra', 'unknown kind'] as const)('rejects %s chunk inconsistency instead of returning truncated or changed text', async failure => {
    const store = createStore()
    const imported = await store.import('Synthetic chunks.json', chunkedText(), 'ref')
    const database = await inspectDatabase(names[0])
    const chunks = database.table('chunks')
    const key = [imported.id, 'draft', 1]
    const chunk = await chunks.get(key)
    if (failure === 'missing') await chunks.delete(key)
    else if (failure === 'length') await chunks.put({ ...chunk, text: chunk.text.slice(1) })
    else if (failure === 'content') await chunks.put({ ...chunk, text: 'z' + chunk.text.slice(1) })
    else if (failure === 'revision') await chunks.put({ ...chunk, revision: imported.revision + 1 })
    else if (failure === 'unknown kind') await chunks.add({ ...chunk, kind: 'unknown' })
    else {
      await chunks.add({ ...chunk, index: Math.ceil(imported.draftText.length / INSPECTOR_TEXT_CHUNK_CODE_UNITS) })
      expect(await chunks.where('[draftId+kind]').equals([imported.id, 'draft']).count()).toBe(Math.ceil(imported.draftText.length / INSPECTOR_TEXT_CHUNK_CODE_UNITS) + 1)
    }
    await expect(store.get(imported.id).then(() => 'unexpected successful load')).rejects.toThrow(/incomplete or inconsistent/)
    await expect(store.save(imported.id, '{}', imported.revision)).rejects.toThrow(/incomplete or inconsistent/)
    expect(await store.list()).toEqual([summarizeInspectorDraft(imported)])
  })

  it('migrates legacy full rows transactionally while preserving exact text and original pins across reopening', async () => {
    const row = legacyRow('synthetic-legacy', chunkedText(), chunkedText('Synthetic draft'))
    const name = await createLegacyDatabase([row])
    const store = createStore(name)
    const opened = { ...row, fileInfo: deriveInspectorFileInfo(parseDocument(row.draftText), row.originalText !== row.draftText) }
    expect(await store.get(row.id)).toEqual(opened)
    expect(await store.list()).toEqual([summarizeInspectorDraft(opened)])
    const database = await inspectDatabase(name)
    expect(database.verno).toBe(2)
    expect(await database.table('drafts').get(row.id)).not.toHaveProperty('originalText')
    store.close()
    const reopened = createStore(name)
    expect(await reopened.get(row.id)).toEqual(opened)
    const saved = await reopened.save(row.id, '{}', row.revision)
    expect(saved).toMatchObject({ originalText: row.originalText, referenceId: row.referenceId, createdAt: row.createdAt, revision: row.revision + 1 })
  })

  it('rolls back legacy rows and database layout after a partial migration chunk failure, then retries cleanly', async () => {
    const row = legacyRow('synthetic-legacy', chunkedText(), chunkedText('Synthetic draft'))
    const name = await createLegacyDatabase([row])
    const add = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...arguments_: Parameters<typeof add>) {
      const request = add.apply(this, arguments_)
      const value = arguments_[0] as { kind?: string; index?: number }
      if (this.name === 'chunks' && value.kind === 'draft' && value.index === 1) this.transaction.abort()
      return request
    })
    const failed = createStore(name)
    await expect(failed.get(row.id)).rejects.toThrow()
    failed.close()
    vi.restoreAllMocks()
    const legacy = await inspectDatabase(name)
    expect(legacy.verno).toBe(1)
    expect(legacy.tables.map(table => table.name)).toEqual(['drafts'])
    expect(await legacy.table('drafts').get(row.id)).toEqual(row)
    legacy.close()
    expect(await createStore(name).get(row.id)).toMatchObject(row)
  })

  it('restores previously migrated rows when a later invalid legacy document rejects the upgrade', async () => {
    const rows = [legacyRow('a', '\ufeff{"Unknown":900719925474099312345}\r\n'), legacyRow('b', '{}', '{"invalid":true,}')]
    const name = await createLegacyDatabase(rows)
    const failed = createStore(name)
    await expect(failed.list()).rejects.toThrow()
    failed.close()
    const legacy = await inspectDatabase(name)
    expect(legacy.verno).toBe(1)
    expect(legacy.tables.map(table => table.name)).toEqual(['drafts'])
    expect(await legacy.table('drafts').toArray()).toEqual(rows)
  })
})


describe('optional inspector file metadata cache', () => {
  it('refreshes draft identity without modifying original identity, text or private draft IDs', async () => {
    const store = createStore()
    const original = '\ufeff{"Title":"First","Version":"1","ID":"project"}\r\n'
    const first = await store.import('mod.json', original, 'pin')
    const duplicate = await store.import('mod.json', original, 'pin')
    expect(first.id).not.toBe(duplicate.id)
    expect(first.fileInfo).toMatchObject({ title: 'First', version: '1', projectId: 'project', edited: false })
    const saved = await store.save(first.id, '{"Title":"Second","Version":"2","ID":"changed"}', first.revision)
    expect(saved).toMatchObject({ id: first.id, originalText: original, referenceId: 'pin', fileInfo: { title: 'Second', version: '2', projectId: 'changed', edited: true } })
    const restored = await store.save(first.id, original, saved.revision)
    expect(restored.fileInfo).toMatchObject({ title: 'First', edited: false })
  })

  it('lists old metadata without payload reads then populates only the opened cache', async () => {
    const store = createStore()
    const imported = await store.import('mod.json', '{"Title":"Old"}', 'pin')
    const database = await inspectDatabase(names[0])
    await database.table('drafts').update(imported.id, { fileInfo: undefined })
    const before = await database.table('drafts').get(imported.id)
    const chunks = await database.table('chunks').toArray()
    const openCursor = IDBObjectStore.prototype.openCursor
    const guard = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof openCursor>) {
      if (this.name === 'chunks') throw new Error('Unexpected payload read')
      return openCursor.apply(this, args)
    })
    const indexCursor = IDBIndex.prototype.openCursor
    const indexGuard = vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (this: IDBIndex, ...args: Parameters<typeof indexCursor>) {
      if (this.objectStore.name === 'chunks') throw new Error('Unexpected indexed payload read')
      return indexCursor.apply(this, args)
    })
    expect((await store.list())[0].fileInfo).toBeUndefined()
    guard.mockRestore()
    indexGuard.mockRestore()
    const opened = await store.get(imported.id)
    expect(opened).toEqual(imported)
    const after = await database.table('drafts').get(imported.id)
    expect(after).toEqual({ ...before, fileInfo: imported.fileInfo })
    expect(await database.table('chunks').toArray()).toEqual(chunks)
  })

  it('keeps reads usable when a cache transaction fails and preserves a future cache version', async () => {
    const store = createStore()
    const imported = await store.import('mod.json', '{"Title":"Old"}', 'pin')
    const database = await inspectDatabase(names[0])
    await database.table('drafts').update(imported.id, { fileInfo: undefined })
    const put = IDBObjectStore.prototype.put
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const request = put.apply(this, args)
      if (this.name === 'drafts') this.transaction.abort()
      return request
    })
    expect(await store.get(imported.id)).toEqual(imported)
    failure.mockRestore()
    expect((await database.table('drafts').get(imported.id)).fileInfo).toBeUndefined()
    const future = { schemaVersion: 99, unknown: 'preserve' }
    await database.table('drafts').update(imported.id, { fileInfo: future })
    expect(await store.get(imported.id)).toEqual(imported)
    expect((await database.table('drafts').get(imported.id)).fileInfo).toEqual(future)
  })

  it('cannot write stale opened metadata over a concurrently saved revision', async () => {
    const store = createStore()
    const imported = await store.import('mod.json', '{"Title":"Old"}', 'pin')
    const database = await inspectDatabase(names[0])
    await database.table('drafts').update(imported.id, { fileInfo: undefined })
    const writer = createStore(names[0])
    const cacheHost = store as unknown as { cacheFileInfo: (...args: unknown[]) => Promise<void> }
    const cache = cacheHost.cacheFileInfo.bind(store)
    let saved: InspectorDraft | undefined
    vi.spyOn(cacheHost, 'cacheFileInfo').mockImplementation(async (...args) => {
      saved = await writer.save(imported.id, '{"Title":"New"}', imported.revision)
      await cache(...args)
    })
    expect((await store.get(imported.id))?.fileInfo?.title).toBe('Old')
    expect(await writer.get(imported.id)).toEqual(saved)
    expect((await store.list())[0]).toMatchObject({ revision: imported.revision + 1, fileInfo: { title: 'New', edited: true } })
  })
})

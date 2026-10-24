import { expect, it } from 'vitest'
import { prepareLocalIndex, readLocalIndex } from './local-index'
import { INDEX_PAGE_ENTRIES, type IndexPage } from './directory'
import type { CipherRef } from '../persistence/account-database'

function storage<T>() {
  const values = new Map<string, IndexPage<T>>()
  let writes = 0
  return {
    values,
    writes: () => writes,
    write: async (page: IndexPage<T>): Promise<CipherRef> => {
      const ref = { documentId: 'index', revisionId: String(++writes) }
      values.set(ref.revisionId, structuredClone(page))
      return ref
    },
    read: async (ref: CipherRef) => structuredClone(values.get(ref.revisionId)!),
  }
}

it('reuses unchanged bounded pages and writes only changed leaf and parent pages', async () => {
  const db = storage<{ id: number; value: string }>()
  const original = Array.from({ length: INDEX_PAGE_ENTRIES * 3 }, (_, id) => ({ id, value: 'before' }))
  const first = await prepareLocalIndex(original, db.write)
  expect(db.writes()).toBe(4)
  const after = original.map(value => value.id === 3 ? { ...value, value: 'after' } : value)
  const second = await prepareLocalIndex(after, db.write, first)
  expect(db.writes()).toBe(6)
  expect((await readLocalIndex(second.root, db.read)).entries).toEqual(after)
  expect((await readLocalIndex(first.root, db.read)).entries).toEqual(original)
  expect((await prepareLocalIndex(after, db.write, second)).root).toEqual(second.root)
  expect(db.writes()).toBe(6)
})

it('append reuses immutable checkpoint pages without encoding their bodies again', async () => {
  const db = storage<CipherRef>()
  const refs = Array.from({ length: INDEX_PAGE_ENTRIES * 2 }, (_, index) => ({ documentId: 'native-checkpoint', revisionId: String(index) }))
  const first = await prepareLocalIndex(refs, db.write)
  const next = await prepareLocalIndex([...refs, { documentId: 'native-checkpoint', revisionId: 'new' }], db.write, first)
  expect(db.writes()).toBe(5)
  expect((await readLocalIndex(next.root, db.read)).entries).toHaveLength(refs.length + 1)
})

it('rejects oversized, cyclic, duplicate and unavailable index pages', async () => {
  const db = storage<string>()
  await expect(prepareLocalIndex(['x'.repeat(256 * 1024)], db.write)).rejects.toThrow()
  const ref = { documentId: 'index', revisionId: 'cycle' }
  db.values.set('cycle', { version: 1, entries: [], children: [ref] })
  await expect(readLocalIndex(ref, db.read)).rejects.toThrow(/repeat|cycl/i)
  db.values.set('cycle', { version: 1, entries: Array(INDEX_PAGE_ENTRIES + 1).fill('x'), children: [] })
  await expect(readLocalIndex(ref, db.read)).rejects.toThrow()
  await expect(readLocalIndex({ ...ref, revisionId: 'missing' }, db.read)).rejects.toThrow()
})

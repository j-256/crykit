import { expect, it, vi } from 'vitest'
import { directoryDocumentId, directoryShard, mergeDirectory, workspaceControlDocumentId } from './directory'

it('freezes account scoped directory and control derivations', async () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i)
  expect(await directoryShard('build/example')).toBe(16)
  expect(await directoryDocumentId(key, 'AAAAAAAAAAAAAAAAAAAAAA', 7)).toBe('X3ecYP8bdHD7YBTjDVghzQ')
  expect(await workspaceControlDocumentId(key, 'AAAAAAAAAAAAAAAAAAAAAA')).toBe('c61EivBgu5DH646a9O_nYQ')
})
it('independentAddsInSameShardMergeByStableKey', async () => {
  const keyA = 'build/a'
  let keyB = ''
  for (let i = 0; !keyB; i++) if (await directoryShard(`build/${i}`) === await directoryShard(keyA)) keyB = `build/${i}`
  expect(await directoryShard(keyA)).toBe(await directoryShard(keyB))
  expect(mergeDirectory([], [{ key: keyA, documentId: 'a' }], [{ key: keyB, documentId: 'b' }]).map(entry => entry.key)).toEqual(expect.arrayContaining([keyA, keyB]))
  expect(() => mergeDirectory([], [{ key: keyA, documentId: 'a' }], [{ key: keyA, documentId: 'b' }])).toThrow('mapping')
})

it('selects seeds only at the exact replaced physical head and preserves stable allocations', async () => {
  const { selectBaselineRevision, allocateDirectory } = await import('./directory')
  const seed = { documentId: 'd', revisionId: 'seed' }
  const entry = { kind: 'mutable' as const, key: 'k', seed, replacedHead: 'old' }
  expect(selectBaselineRevision(entry, { documentId: 'd', revisionId: 'old', key: 'k', lineageId: 'previous', parents: [] }, 'new', new Map())).toEqual(seed)
  expect(() => selectBaselineRevision(entry, undefined, 'new', new Map())).toThrow()
  expect(() => selectBaselineRevision(entry, { documentId: 'd', revisionId: 'unexpected', key: 'k', lineageId: 'previous', parents: [] }, 'new', new Map())).toThrow()
  const edit = { documentId: 'd', revisionId: 'edit', key: 'k', lineageId: 'new', parents: ['seed'] }
  expect(selectBaselineRevision(entry, edit, 'new', new Map())).toEqual({ documentId: 'd', revisionId: 'edit' })
  expect(() => selectBaselineRevision(entry, { ...edit, parents: [] }, 'new', new Map())).toThrow()
  expect(allocateDirectory([{ key: 'existing', documentId: 'stable' }], ['fresh'], () => 'allocated')).toEqual([{ key: 'existing', documentId: 'stable' }, { key: 'fresh', documentId: 'allocated' }])
})
it('splits immutable index pages at both child and encoded byte bounds', async () => {
  const { buildIndexPages } = await import('./directory')
  const written: { entries: readonly unknown[]; children: readonly unknown[] }[] = []
  const root = await buildIndexPages(Array.from({ length: 300 }, (_, i) => ({ key: `${i}:${'x'.repeat(4000)}` })), async page => { written.push(page); return { documentId: `p${written.length}`, revisionId: 'r' } })
  expect(root.documentId).toBe(`p${written.length}`)
  expect(written.length).toBeGreaterThan(3)
  for (const page of written) { expect(page.entries.length + page.children.length).toBeLessThanOrEqual(128); expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(256 * 1024) }
})

it('rejects shared allocation IDs, cyclic ancestry and foreign intermediate ancestry', async () => {
  const { selectBaselineRevision } = await import('./directory')
  expect(() => mergeDirectory([], [{ key: 'one', documentId: 'same' }], [{ key: 'two', documentId: 'same' }])).toThrow()
  const entry = { kind: 'mutable' as const, key: 'k', seed: { documentId: 'd', revisionId: 'seed' }, replacedHead: 'old' }
  const head = { documentId: 'd', revisionId: 'head', key: 'k', lineageId: 'new', parents: ['middle'] }
  expect(() => selectBaselineRevision(entry, head, 'new', new Map([['middle', { ...head, revisionId: 'middle', key: 'foreign', parents: ['seed'] }]]))).toThrow()
  expect(() => selectBaselineRevision(entry, head, 'new', new Map([['middle', { ...head, revisionId: 'middle', parents: ['head', 'seed'] }], ['head', head]]))).toThrow()
})

it('counts typed envelope bytes when paging a producer index', async () => {
  const { buildIndexPages, INDEX_PAGE_BYTES } = await import('./directory')
  const envelope = { kind: 'synthetic-index', evidence: 'x'.repeat(100_000) }
  let pages = 0
  const size = (page: unknown) => new TextEncoder().encode(JSON.stringify({ ...page as object, ...envelope })).length
  await buildIndexPages(Array.from({ length: 100 }, () => ({ value: 'x'.repeat(4000) })), async page => { expect(size(page)).toBeLessThanOrEqual(INDEX_PAGE_BYTES); return { documentId: `page-${++pages}`, revisionId: 'r' } }, size)
  expect(pages).toBeGreaterThan(3)
})

it('sizes ordinary index pages without repeatedly encoding each prefix and preserves exact page bytes', async () => {
  const { buildIndexPages } = await import('./directory')
  const utf8 = new TextEncoder()
  const entries = Array.from({ length: 400 }, (_, index) => ({ key: `${index}:é\\\"`, value: '😀'.repeat(index % 3 === 0 ? 1200 : 8) }))
  const inputBytes = utf8.encode(JSON.stringify(entries)).length
  const size = (page: unknown) => utf8.encode(JSON.stringify(page)).length
  const capture = async (measure?: (page: import('./directory').IndexPage<typeof entries[number]>) => number) => {
    const pages: import('./directory').IndexPage<typeof entries[number]>[] = []
    await buildIndexPages(entries, async page => { pages.push(page); return { documentId: `page-${pages.length}`, revisionId: 'exact' } }, measure)
    return pages
  }
  let encodedBytes = 0
  const encode = TextEncoder.prototype.encode
  const observed = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, text) { const bytes = encode.call(this, text); encodedBytes += bytes.length; return bytes })
  let actual: Awaited<ReturnType<typeof capture>>
  try { actual = await capture() } finally { observed.mockRestore() }
  expect(encodedBytes).toBeLessThan(inputBytes * 3)
  expect(actual).toEqual(await capture(size))
})

it('retains exact default page limits and key-sensitive JSON sizing', async () => {
  const { buildIndexPages, INDEX_PAGE_BYTES } = await import('./directory')
  const utf8 = new TextEncoder(), size = (page: unknown) => utf8.encode(JSON.stringify(page)).length
  const emptyBytes = size({ version: 1, entries: [], children: [] })
  const exact = 'x'.repeat(INDEX_PAGE_BYTES - emptyBytes - 2)
  const collect = async (entries: readonly unknown[], custom = false) => {
    const pages: unknown[] = []
    await buildIndexPages(entries, async page => { pages.push(JSON.parse(JSON.stringify(page))); return { documentId: `page-${pages.length}`, revisionId: 'r' } }, custom ? size : undefined)
    return pages
  }
  expect(await collect([exact, 0])).toEqual(await collect([exact, 0], true))
  await expect(collect([`${exact}x`])).rejects.toThrow('exceeds')
  expect(await collect([])).toEqual(await collect([], true))
  const entries = [undefined, null, Number.NaN, '\ud800', { toJSON(key: string) { return { at: key, value: 'é'.repeat(Number(key) + 1) } } }, { nested: ['😀', undefined] }]
  expect(await collect(entries)).toEqual(await collect(entries, true))
})

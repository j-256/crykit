import { expect, it } from 'vitest'
import { compiledEntityId, compileCatalogIdentities } from './catalog-identities'
import type { CatalogEntity, CatalogSnapshot } from './types'

const native = (id: string, databaseId: number): CatalogEntity => ({ id: id as never, kind: 'class', name: 'Synthetic class', aliases: [], fields: {}, sources: [{ sourceId: 'native-game:synthetic' }], legacy: { native: { database: 'job', databaseId, mode: 'base' } } })

it('compiles exact native IDs and rejects definitions without a source identity', () => {
  expect(compiledEntityId(native('temporary:name', 3))).toBe('base:job:3')
  expect(() => compiledEntityId({ ...native('temporary:unverified', 3), legacy: undefined })).toThrow('no native or mod identity')
})

it('rejects two source definitions that would silently acquire the same native identity', () => {
  const source = { id: 'synthetic', revisionId: 'v1', checksum: 'synthetic', schemaVersion: 'synthetic', applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: { a: native('a', 3), b: native('b', 3) }, claims: [] } as unknown as CatalogSnapshot
  expect(() => compileCatalogIdentities(source)).toThrow('conflicting catalog identities')
})

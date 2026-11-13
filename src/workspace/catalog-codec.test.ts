import { afterEach, expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { encodeCatalogPayload } from './catalog-codec'
import { sourcePayloadValid } from '../domain/source-fulfillment'

afterEach(() => { vi.doUnmock('../catalog/bundled'); vi.resetModules() })

it('retains exact saved definitions after the application package removes their bodies', async () => {
  const saved = JSON.parse(JSON.stringify(encodeCatalogPayload(CURRENT_CATALOG)))
  vi.doMock('../catalog/bundled', () => ({ BUNDLED_CATALOGS: [] }))
  vi.resetModules()
  const { decodeCatalogPayload } = await import('./catalog-codec')
  const reopened = decodeCatalogPayload(saved) as typeof CURRENT_CATALOG
  expect(reopened).toEqual(CURRENT_CATALOG)
  expect(sourcePayloadValid(reopened)).toBe(true)
})

it('rejects package-only prelaunch records even when their source is installed', async () => {
  const { decodeCatalogPayload } = await import('./catalog-codec')
  expect(() => decodeCatalogPayload({ version: 1, kind: 'packaged-catalog-pin', id: CURRENT_CATALOG.id, revisionId: CURRENT_CATALOG.revisionId, checksum: CURRENT_CATALOG.checksum })).toThrow('Prelaunch package-only catalog records are unsupported')
})

it('uses self-contained bounded compression for complete sources', async () => {
  const encoded = encodeCatalogPayload(CURRENT_CATALOG) as { kind: string; byteLength: number; pages: string[] }
  expect(encoded.kind).toBe('compressed-catalog-snapshot')
  expect(new TextEncoder().encode(JSON.stringify(encoded)).byteLength).toBeLessThan(encoded.byteLength / 2)
  const { decodeCatalogPayload } = await import('./catalog-codec')
  expect(() => decodeCatalogPayload({ ...encoded, byteLength: encoded.byteLength - 1 })).toThrow()
  expect(() => decodeCatalogPayload({ ...encoded, pages: [...encoded.pages, encoded.pages[0]] })).toThrow()
  expect(() => decodeCatalogPayload({ ...encoded, pages: ['!!!!'] })).toThrow()
  expect(() => decodeCatalogPayload({ ...encoded, byteLength: Number.MAX_SAFE_INTEGER })).toThrow()
})

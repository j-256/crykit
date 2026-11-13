import { expect, it } from 'vitest'
import { syntheticModLayers } from './mod-layers.test-helpers'
import { sourceCompositionDigest } from './source-composition'

it('pins every source payload, layer choice, and order in a composition fingerprint', async () => {
  const { catalogs, composition } = await syntheticModLayers()
  const original = sourceCompositionDigest(composition, catalogs)
  expect(sourceCompositionDigest(structuredClone(composition), [...catalogs].reverse())).toBe(original)
  expect(sourceCompositionDigest({ ...composition, layers: [...composition.layers].reverse() }, catalogs)).not.toBe(original)
  expect(sourceCompositionDigest({ ...composition, layers: composition.layers.map(layer => ({ ...layer, enabled: false })) }, catalogs)).not.toBe(original)
  expect(sourceCompositionDigest({ ...composition, links: [] }, catalogs)).not.toBe(original)
  expect(sourceCompositionDigest(composition, catalogs.map((catalog, index) => index === 1 ? { ...catalog, checksum: 'synthetic-changed-payload' } : catalog))).not.toBe(original)
  expect(() => sourceCompositionDigest(composition, catalogs.slice(0, 2))).toThrow('every pinned source')
})

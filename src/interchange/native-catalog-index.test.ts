import { afterEach, expect, it, vi } from 'vitest'
import { syntheticCatalog } from '../workspace/test-helpers'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import { sourcePayloadContent } from '../domain/source-payload'
import { createTestLocalData } from '../domain/test-helpers'
import { modCatalogRevision, MOD_CATALOG_SCHEMA } from '../domain/mod-layers'
import type { CatalogSnapshot, CatalogRef } from '../domain/types'
import { immutableCatalogSnapshot, immutableExpandedModCatalogs, validateNativeLocalDataGraph, validatePresentCatalogReferences } from './native'

afterEach(() => vi.restoreAllMocks())
function seal(value: CatalogSnapshot): CatalogSnapshot {
  const { checksum: _checksum, ...content } = value
  return { ...content, checksum: `payload:sha256:${checkpointContentDigest(sourcePayloadContent(content))}` }
}
function catalog(label = 'catalog-index'): CatalogSnapshot {
  const entity = { id: 'synthetic-item' as CatalogRef['entityId'], kind: 'item' as const, name: 'Synthetic item', aliases: [], fields: {}, sources: [], requirements: { state: 'unknown' as const, reason: 'Synthetic unrecorded requirements' } }
  return syntheticCatalog(label, undefined, { [entity.id]: entity })
}
function ref(value: CatalogSnapshot, entityId = 'synthetic-missing'): CatalogRef {
  return { kind: 'catalog', catalogId: value.id, catalogRevisionId: value.revisionId, entityId: entityId as CatalogRef['entityId'] }
}

it.each(['frozen', 'expanded'] as const)('builds a catalog lookup once for the admitted %s collection while validating each current planner', mode => {
  const value = immutableCatalogSnapshot(catalog()), source = [value], data = createTestLocalData()
  const catalogs = mode === 'frozen' ? Object.freeze(source) : immutableExpandedModCatalogs(source)
  const entries = vi.spyOn(Object, 'entries')
  validateNativeLocalDataGraph(data, catalogs)
  validateNativeLocalDataGraph(data, catalogs)
  expect(entries.mock.calls.filter(([input]) => input === value.entities)).toHaveLength(2)
  expect(() => validateNativeLocalDataGraph({ ...data, selectedPlaythroughId: 'absent' as never }, catalogs)).toThrow()
  expect(() => validatePresentCatalogReferences([ref(value)], catalogs)).toThrow('missing catalog entity')
  if (mode === 'expanded') {
    source.push(value)
    expect(() => validateNativeLocalDataGraph(data, catalogs)).not.toThrow()
  }
})

it.each([false, true])('does not reuse mutable catalog descendants under a frozen collection and shell: %s', shell => {
  const value = catalog(), catalogs = Object.freeze([shell ? Object.freeze(value) : value]), data = createTestLocalData()
  validateNativeLocalDataGraph(data, catalogs)
  const entity = Object.values(value.entities)[0]!
  ;(value.entities as Record<string, unknown>)[entity.id] = { ...entity, requirements: { state: 'known', value: [{ kind: 'selected', ref: ref(value) }] } }
  expect(() => validateNativeLocalDataGraph(data, catalogs)).toThrow('invalid identity, revision, or contents')
})

it('rechecks new and reordered collections, duplicate revisions and invalid claims', () => {
  const first = immutableCatalogSnapshot(catalog()), second = immutableCatalogSnapshot(catalog('second'))
  const data = createTestLocalData(), entries = vi.spyOn(Object, 'entries')
  validateNativeLocalDataGraph(data, Object.freeze([first, second]))
  validateNativeLocalDataGraph(data, Object.freeze([second, first]))
  expect(entries.mock.calls.filter(([input]) => input === first.entities)).toHaveLength(4)
  expect(() => validateNativeLocalDataGraph(data, Object.freeze([first, first]))).toThrow('duplicate catalog revision')
  const replaced = catalog()
  ;(replaced as { claims: unknown }).claims = [{ entityId: 'missing' }]
  expect(() => validateNativeLocalDataGraph(data, Object.freeze([replaced]))).toThrow()
})

it('rechecks a mutable collection even when all its individual catalogs are admitted', () => {
  const value = immutableCatalogSnapshot(catalog()), catalogs = [value], data = createTestLocalData()
  validateNativeLocalDataGraph(data, catalogs)
  catalogs.push(value)
  expect(() => validateNativeLocalDataGraph(data, catalogs)).toThrow('duplicate catalog revision')
})

it('does not retain a failed cross-catalog lookup and rejects changed dependencies', () => {
  const value = catalog(), entity = Object.values(value.entities)[0]!
  const dependency = immutableCatalogSnapshot(catalog('dependency'))
  const needsDependency = immutableCatalogSnapshot(seal({ ...value, entities: { [entity.id]: { ...entity, requirements: { state: 'known', value: [{ kind: 'selected', ref: ref(dependency, Object.keys(dependency.entities)[0]) }] } } } }))
  const invalid = Object.freeze([needsDependency]), data = createTestLocalData()
  for (let attempt = 0; attempt < 2; attempt++) expect(() => validateNativeLocalDataGraph(data, invalid)).toThrow('missing catalog entity')
  expect(() => validateNativeLocalDataGraph(data, Object.freeze([needsDependency, dependency]))).not.toThrow()
  const changed = immutableCatalogSnapshot(seal({ ...dependency, entities: {} }))
  expect(() => validateNativeLocalDataGraph(data, Object.freeze([needsDependency, changed]))).toThrow('missing catalog entity')
})

it('rejects missing composition dependencies without granting receipt-only admission', () => {
  const data = createTestLocalData(), setup = Object.values(data.gameSetups)[0]!, baseline = immutableCatalogSnapshot(catalog())
  const layer = catalog('missing-layer')
  const composition = { baseline: { catalogId: baseline.id, catalogRevisionId: baseline.revisionId }, layers: [{ catalogId: layer.id, catalogRevisionId: layer.revisionId, enabled: true }], links: [] }
  const effective = immutableCatalogSnapshot({ ...catalog(), revisionId: modCatalogRevision(setup.id), schemaVersion: MOD_CATALOG_SCHEMA, legacy: { modBaseline: composition.baseline, modGameSetupRevisionId: setup.id } })
  const catalogs = Object.freeze([baseline, effective])
  const unavailable = { ...data, gameSetups: { ...data.gameSetups, [setup.id]: { ...setup, catalogLock: { [baseline.id]: effective.revisionId }, modComposition: composition } } }
  expect(() => validateNativeLocalDataGraph(unavailable, catalogs)).toThrow('unavailable catalog revision')
  expect(() => validatePresentCatalogReferences([ref(effective)], catalogs)).toThrow('missing catalog entity')
})

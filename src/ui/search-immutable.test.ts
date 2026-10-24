import { afterEach, expect, it, vi } from 'vitest'
import * as semantics from '../catalog/source-semantics'
import type { CatalogSnapshot } from '../domain/types'
import { immutableCatalogSnapshot } from '../interchange/native'
import { buildReferenceSearchItems, findReferenceSearchItem } from './search'

function fixture(): CatalogSnapshot {
  return {
    id: 'synthetic-search' as CatalogSnapshot['id'], revisionId: 'synthetic-revision' as CatalogSnapshot['revisionId'],
    schemaVersion: '1.0.0', checksum: 'synthetic', importedAt: '2026-01-01T00:00:00.000Z' as CatalogSnapshot['importedAt'],
    applicability: { state: 'unknown' }, rights: { state: 'known', value: 'Synthetic fixture' },
    entities: { blade: { id: 'blade' as CatalogSnapshot['entities'][string]['id'], kind: 'item', name: 'Synthetic blade', aliases: [], rawDescription: 'Synthetic original description', fields: { Location: { state: 'unknown', reason: 'Synthetic missing provenance' } }, sources: [] } },
    claims: [],
  }
}

afterEach(() => vi.restoreAllMocks())

it('reuses exact admitted catalog projections across fresh caller arrays without rebuilding unchanged records', () => {
  const catalog = immutableCatalogSnapshot(fixture())
  const project = vi.spyOn(semantics, 'projectSourceSemantics')
  const first = buildReferenceSearchItems([catalog])
  const second = buildReferenceSearchItems([...new Set([catalog])])
  expect(first).toEqual(second)
  expect(project).toHaveBeenCalledTimes(1)
  expect(second[0]).toBe(first[0])
  expect(Object.isFrozen(first[0]!.projection)).toBe(true)
  expect(Reflect.set(first[0]!.projection.text!, 'value', 'Changed by another consumer')).toBe(false)
  expect(buildReferenceSearchItems([catalog])[0]!.projection.text).toEqual(first[0]!.projection.text)
  expect(findReferenceSearchItem([catalog], first[0]!.keyParts)).toEqual(first[0])
})

it.each([false, true])('recomputes nested changes when only the catalog shell is frozen: %s', shallow => {
  const catalog = fixture()
  if (shallow) Object.freeze(catalog)
  const first = buildReferenceSearchItems([catalog])
  Object.assign(catalog.entities.blade!, { name: 'Changed synthetic blade', rawDescription: 'Changed description' })
  Object.assign(catalog.entities.blade!.fields.Location!, { reason: 'Changed unknown provenance' })
  const second = buildReferenceSearchItems([catalog])
  expect(second[0]!.entity.name).toBe('Changed synthetic blade')
  expect(second[0]!.projection.text).toEqual({ state: 'known', value: 'Changed synthetic blade\nChanged description\nChanged description' })
  expect(second[0]!.entity.fields.Location).toEqual({ state: 'unknown', reason: 'Changed unknown provenance' })
  expect(second[0]).not.toBe(first[0])
})

it('separately admits a different snapshot with identical labels and digest while preserving its actual facts', () => {
  const first = immutableCatalogSnapshot(fixture())
  const changed = fixture()
  Object.assign(changed.entities.blade!, { rawDescription: 'Different exact source' })
  const second = immutableCatalogSnapshot(changed)
  const a = buildReferenceSearchItems([first]), b = buildReferenceSearchItems([second])
  expect(b[0]).not.toBe(a[0])
  expect(b[0]!.catalog).toBe(second)
  expect(b[0]!.projection.text).not.toEqual(a[0]!.projection.text)
})

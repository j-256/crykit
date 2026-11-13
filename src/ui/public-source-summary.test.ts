import { describe, expect, it } from 'vitest'
import { STARTER_CATALOG_ID } from '../catalog/catalog-ids'
import { publicCatalogLabel, publicReceiptSourceSummary } from './public-source-summary'

const origin = { kind: 'catalog' as const, projectId: STARTER_CATALOG_ID, catalogId: STARTER_CATALOG_ID, sourceRevisionId: 'catalog-v3', catalogRevisionId: 'catalog-v3' }

describe('public source summaries', () => {
  it('labels the bundled catalog without changing its recorded identity', () => {
    const before = { ...origin }
    expect(publicCatalogLabel(STARTER_CATALOG_ID)).toBe('Crystal Project')
    expect(publicReceiptSourceSummary(origin)).toBe('Crystal Project · catalog-v3')
    expect(origin).toEqual(before)
  })

  it('keeps distinct source and catalog revisions and model identity', () => {
    expect(publicReceiptSourceSummary({ ...origin, projectId: 'custom-mod', sourceRevisionId: 'source-v2', modelKey: 'Abilities:3' })).toBe('custom-mod · Source source-v2 · Catalog catalog-v3 · Abilities:3')
  })

  it('does not relabel other catalogs or personal projects', () => {
    expect(publicCatalogLabel('another-project')).toBe('another-project')
    expect(publicReceiptSourceSummary({ kind: 'personal', projectId: 'personal-definition-v1', catalogId: 'personal-definition-v1', sourceRevisionId: 'a'.repeat(64), catalogRevisionId: 'a'.repeat(64) })).toBe(`personal-definition-v1 · ${'a'.repeat(64)}`)
  })
})

import { describe, expect, it } from 'vitest'
import { retainFixtureCatalog } from '../../e2e/fixture-catalogs'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import { sourcePayloadValid } from '../domain/source-fulfillment'
import { syntheticCatalog } from '../workspace/test-helpers'

const required = syntheticCatalog('required-personal-original')
const other = syntheticCatalog('independent-existing-original')

describe('personal-definition fixture source closure', () => {
  it('adds the exact missing complete source without changing other catalogs', () => {
    const original = [other]
    const result = retainFixtureCatalog(original, required)
    expect(result).toEqual([other, required])
    expect(result[0]).toBe(other)
    expect(result[1]).toBe(required)
    expect(original).toEqual([other])
  })

  it('keeps an equal existing body once without requiring object identity', () => {
    const catalogs = [other, structuredClone(required)]
    expect(retainFixtureCatalog(catalogs, required)).toBe(catalogs)
  })

  it('rejects a valid but different full body under the same source identity', () => {
    const { checksum: ignored, ...content } = required
    void ignored
    const changed = { ...content, schemaVersion: 'synthetic-alternative' }
    const conflicting = { ...changed, checksum: `payload:sha256:${checkpointContentDigest(changed)}` }
    expect(sourcePayloadValid(conflicting)).toBe(true)
    expect(() => retainFixtureCatalog([conflicting], required)).toThrow('different or duplicate body')
  })

  it('rejects invalid required bytes and duplicate existing associations', () => {
    expect(() => retainFixtureCatalog([], { ...required, schemaVersion: 'changed-without-checksum' })).toThrow('invalid complete payload')
    expect(() => retainFixtureCatalog([required, structuredClone(required)], required)).toThrow('different or duplicate body')
  })
})

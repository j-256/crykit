import { expect, it } from 'vitest'
import { mergeArtifactCatalogs } from './source-artifacts'

it('unions interpretation bindings but rejects a changed payload at the same pin', () => {
  const first = { id: 'synthetic', revisionId: 'p1', checksum: 'first' }
  const next = { ...first, revisionId: 'p2', checksum: 'next' }
  expect(mergeArtifactCatalogs([first], [next, first])).toEqual([first, next])
  expect(() => mergeArtifactCatalogs([first], [{ ...first, checksum: 'changed' }])).toThrow('conflicting catalog bindings')
})
